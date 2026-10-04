/**
 * OpenAI-compatible provider adapter (§5, §7): works with OpenAI, OpenRouter,
 * local runtimes (Ollama/LM Studio/vLLM) and custom gateways that expose the
 * /models and /chat/completions endpoints.
 */
import { ProviderError } from "../../errors/index.js";
import { logger, type Logger } from "../../logger/index.js";
import type { ChatRequest, ChatResponse } from "../../types/chat.js";
import type { ModelInfo } from "../../types/model.js";
import type { IChatProvider, ProviderConfig, ProviderStatus } from "../../types/provider.js";
import { authHeaders } from "../auth.js";
import { requestJson } from "../http.js";

interface OpenAIModelEntry {
  id?: unknown;
  owned_by?: unknown;
  created?: unknown;
}

interface OpenAIChatResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

export class OpenAICompatibleProvider implements IChatProvider {
  readonly config: ProviderConfig;
  private readonly log: Logger;

  constructor(config: ProviderConfig, log: Logger = logger) {
    this.config = { ...config, baseUrl: normalizeBaseUrl(config.baseUrl) };
    this.log = log.child({ provider: config.name });
  }

  async listModels(): Promise<ModelInfo[]> {
    const { status, body } = await requestJson(`${this.config.baseUrl}/models`, {
      headers: authHeaders(this.config),
    });
    if (status === 401 || status === 403) {
      throw authFailed(this.config, status);
    }
    if (status !== 200) {
      throw unavailable(this.config, `Model discovery returned HTTP ${status}.`, status);
    }

    const entries = extractModelEntries(body, this.config);
    const models: ModelInfo[] = [];
    let skipped = 0;
    for (const entry of entries) {
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        skipped += 1;
        continue;
      }
      models.push({
        provider: this.config.name,
        id: entry.id,
        displayName: entry.id,
        status: "available",
        metadata: {
          ...(typeof entry.owned_by === "string" ? { ownedBy: entry.owned_by } : {}),
          ...(typeof entry.created === "number" ? { createdAt: entry.created } : {}),
        },
      });
    }
    if (skipped > 0) {
      this.log.warn(`Skipped ${skipped} model entr(y/ies) without a valid id.`);
    }
    return models;
  }

  async healthCheck(): Promise<ProviderStatus> {
    const lastCheckedAt = new Date().toISOString();
    try {
      const started = Date.now();
      const models = await this.listModels();
      return {
        name: this.config.name,
        type: this.config.type,
        baseUrl: this.config.baseUrl,
        health: "healthy",
        connected: true,
        modelCount: models.length,
        lastCheckedAt,
        message: `Discovered ${models.length} model(s) in ${Date.now() - started}ms.`,
      };
    } catch (error) {
      return {
        name: this.config.name,
        type: this.config.type,
        baseUrl: this.config.baseUrl,
        health: inferHealth(error),
        connected: false,
        modelCount: 0,
        lastCheckedAt,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { status, body } = await requestJson(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(this.config),
      body: {
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
      },
    });

    if (status === 401 || status === 403) throw authFailed(this.config, status);
    if (status === 404) {
      throw new ProviderError(
        "MODEL_NOT_FOUND",
        `Model "${request.model}" or the chat endpoint was not found on provider "${this.config.name}" (HTTP 404).`,
        { details: { status } },
      );
    }
    if (status !== 200) {
      throw unavailable(this.config, `Chat completion returned HTTP ${status}.`, status);
    }

    const payload = body as OpenAIChatResponse;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
    if (!first || typeof first.message?.content !== "string") {
      throw unavailable(this.config, "Chat completion response had no message content.", status);
    }

    const usage = (payload.usage ?? {}) as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };

    return {
      model: typeof payload.model === "string" ? payload.model : request.model,
      content: first.message.content,
      finishReason: typeof first.finish_reason === "string" ? first.finish_reason : undefined,
      usage: {
        promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
        completionTokens:
          typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
      },
      raw: body,
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function extractModelEntries(body: unknown, config: ProviderConfig): OpenAIModelEntry[] {
  if (Array.isArray(body)) return body as OpenAIModelEntry[];
  if (body !== null && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: OpenAIModelEntry[] }).data;
  }
  throw new ProviderError(
    "PROVIDER_UNAVAILABLE",
    `Provider "${config.name}" returned an unrecognized model list shape.`,
    { details: { endpoint: "models" } },
  );
}

function authFailed(config: ProviderConfig, status: number): ProviderError {
  const envHint = config.apiKeyEnvVar
    ? ` Check that $${config.apiKeyEnvVar} is set and valid.`
    : " The provider requires authentication; configure api_key_env_var for it.";
  return new ProviderError(
    "PROVIDER_AUTH_FAILED",
    `Authentication with provider "${config.name}" failed (HTTP ${status}).${envHint}`,
    { details: { status } },
  );
}

function unavailable(config: ProviderConfig, message: string, status: number): ProviderError {
  return new ProviderError("PROVIDER_UNAVAILABLE", `Provider "${config.name}": ${message}`, {
    details: { status },
  });
}

function inferHealth(error: unknown): "degraded" | "unreachable" {
  const status =
    error instanceof ProviderError && typeof error.details?.status === "number"
      ? error.details.status
      : undefined;
  return status !== undefined && status >= 500 ? "degraded" : "unreachable";
}
