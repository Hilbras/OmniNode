/**
 * OpenAI-compatible provider adapter (§5, §7): works with OpenAI, OpenRouter,
 * local runtimes (Ollama/LM Studio/vLLM) and custom gateways that expose the
 * /models and /chat/completions endpoints.
 */
import { ProviderError } from "../../errors/index.js";
import { logger, type Logger } from "../../logger/index.js";
import type { ChatRequest, ChatResponse } from "../../types/chat.js";
import type { Modality, ModelInfo } from "../../types/model.js";
import type { IChatProvider, ProviderConfig, ProviderStatus } from "../../types/provider.js";
import { authHeaders } from "../auth.js";
import { requestJson } from "../http.js";
import { providerHttpError, providerTransportError } from "../errors.js";
import type { ProviderAuthentication } from "../../types/provider.js";

interface OpenAIModelEntry {
  id?: unknown;
  name?: unknown;
  owned_by?: unknown;
  created?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  supported_parameters?: unknown;
}

interface OpenAIChatResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

export class OpenAICompatibleProvider implements IChatProvider {
  readonly config: ProviderConfig;
  readonly providerId: string;
  readonly authentication: ProviderAuthentication;
  private readonly log: Logger;
  /** Discovered models, so getModel() answers without another round-trip. */
  private discovered?: ModelInfo[];

  private readonly env: Record<string, string | undefined>;

  constructor(config: ProviderConfig, log: Logger = logger, env: Record<string, string | undefined> = process.env) {
    this.config = { ...config, baseUrl: normalizeBaseUrl(config.baseUrl) };
    this.env = env;
    this.providerId = config.providerId ?? config.name;
    this.authentication = {
      method: config.apiKeyEnvVar ? "bearer" : "none",
      ...(config.apiKeyEnvVar ? { envVar: config.apiKeyEnvVar } : {}),
      configured: config.apiKeyEnvVar ? Boolean(env[config.apiKeyEnvVar]) : true,
    };
    this.log = log.child({ provider: config.name });
  }

  /** Authenticate + discover (roadmap §10, Model Discovery). */
  async connect(): Promise<ModelInfo[]> {
    authHeaders(this.config, this.env); // throws PROVIDER_AUTH_FAILED when the env var is unset
    const models = await this.listModels();
    this.discovered = models;
    return models;
  }

  async getModel(modelId: string): Promise<ModelInfo | undefined> {
    const models = this.discovered ?? (await this.connect());
    return models.find((m) => m.id === modelId);
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: { status: number; body: unknown };
    try {
      response = await requestJson(`${this.config.baseUrl}/models`, {
        headers: authHeaders(this.config, this.env),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error; // auth problem — keep the precise error
      throw providerTransportError({ provider: this.config.name, operation: "listModels", cause: error });
    }
    const { status, body } = response;
    if (status !== 200) {
      throw providerHttpError({
        provider: this.config.name,
        operation: "listModels",
        status,
        body,
      });
    }

    const entries = extractModelEntries(body, this.config);
    const models: ModelInfo[] = [];
    let skipped = 0;
    for (const entry of entries) {
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        skipped += 1;
        continue;
      }
      models.push(this.toModelInfo(entry as OpenAIModelEntry & { id: string }));
    }
    if (skipped > 0) {
      this.log.warn(`Skipped ${skipped} model entr(y/ies) without a valid id.`);
    }
    return models;
  }

  /** Maps a raw model entry onto the normalized metadata shape (§10). */
  private toModelInfo(entry: OpenAIModelEntry & { id: string }): ModelInfo {
    const parameters = Array.isArray(entry.supported_parameters)
      ? (entry.supported_parameters.filter((p): p is string => typeof p === "string") as string[])
      : undefined;
    const contextWindow =
      typeof entry.context_length === "number"
        ? entry.context_length
        : typeof entry.context_window === "number"
          ? entry.context_window
          : undefined;
    const inputTypes = normalizeModalities(entry.input_modalities);
    const outputTypes = normalizeModalities(entry.output_modalities);
    return {
      provider: this.config.name,
      id: entry.id,
      displayName: entry.id,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      status: "available",
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(inputTypes !== undefined ? { inputTypes } : {}),
      ...(outputTypes !== undefined ? { outputTypes } : {}),
      ...(parameters !== undefined
        ? {
            supportsTools: parameters.includes("tools") || parameters.includes("tool_choice"),
            supportsStructuredOutput: parameters.includes("response_format"),
            supportsStreaming: parameters.includes("stream"),
          }
        : {}),
      metadata: {
        ...(typeof entry.owned_by === "string" ? { ownedBy: entry.owned_by } : {}),
        ...(typeof entry.created === "number" ? { createdAt: entry.created } : {}),
        ...(parameters !== undefined ? { supportedParameters: parameters } : {}),
      },
    };
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
    let response: { status: number; body: unknown };
    try {
      response = await requestJson(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(this.config, this.env),
        body: {
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.stop !== undefined ? { stop: request.stop } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw providerTransportError({ provider: this.config.name, operation: "chat", cause: error });
    }
    const { status, body } = response;

    if (status !== 200) {
      throw providerHttpError({
        provider: this.config.name,
        operation: "chat",
        status,
        body,
        ...(status === 404
          ? {
              code: "MODEL_NOT_FOUND" as const,
            }
          : {}),
      });
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

/** Normalizes provider modality lists ("text", ["text","image"], …). */
function normalizeModalities(value: unknown): Modality[] | undefined {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
  if (!list) return undefined;
  const allowed = new Set<Modality>(["text", "image", "audio", "video", "embedding"]);
  const modalities = list.filter((m): m is Modality => typeof m === "string" && allowed.has(m as Modality));
  return modalities.length > 0 ? modalities : undefined;
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
