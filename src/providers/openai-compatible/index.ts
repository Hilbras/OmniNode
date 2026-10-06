/**
 * OpenAI-compatible provider adapter (§5, §7): works with OpenAI, OpenRouter,
 * local runtimes (Ollama/LM Studio/vLLM) and custom gateways that expose the
 * /models and /chat/completions endpoints.
 */
import { ProviderError } from "../../errors/index.js";
import { logger, type Logger } from "../../logger/index.js";

/** Default provider request timeout when the config does not set one. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
import type { ChatRequest, ChatResponse, ChatStreamChunk } from "../../types/chat.js";
import type { AuditSink } from "../../audit/index.js";
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

  private readonly audit?: AuditSink;

  constructor(
    config: ProviderConfig,
    log: Logger = logger,
    env: Record<string, string | undefined> = process.env,
    audit?: AuditSink,
  ) {
    this.audit = audit;
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

  /** Provider-level request timeout (roadmap §6.6/§11) with the shared default. */
  private get requestTimeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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

  /** Raw /models body (protected so adapters can capture gateway-level metadata). */
  protected async rawModelsResponse(): Promise<unknown> {
    const response = await this.modelsRequest();
    return response.body;
  }

  private async modelsRequest(): Promise<{ status: number; body: unknown }> {
    let response: { status: number; body: unknown; durationMs: number };
    try {
      response = await requestJson(`${this.config.baseUrl}/models`, {
        headers: authHeaders(this.config, this.env),
        timeoutMs: this.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        await this.recordProviderError("listModels", error);
        throw error; // auth problem — keep the precise error
      }
      const normalized = providerTransportError({
        provider: this.config.name,
        operation: "listModels",
        cause: error,
      });
      await this.recordProviderError("listModels", normalized);
      throw normalized;
    }
    const { status, body } = response;
    if (status !== 200) {
      const httpError = providerHttpError({
        provider: this.config.name,
        operation: "listModels",
        status,
        body,
        durationMs: response.durationMs,
        dispatched: true,
      });
      await this.recordProviderError("listModels", httpError);
      throw httpError;
    }
    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    const body = await this.rawModelsResponse();

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

  /** Streaming where the gateway supports it (§11). */
  stream(request: ChatRequest, onChunk: (chunk: ChatStreamChunk) => void): Promise<ChatResponse> {
    return streamChatCompletion(this.config, request, onChunk, this.env);
  }

  /** Provider errors are part of the audit trail (§14 correlation, §18 observability).
   *  v2.0.3 Fix 02: audit is observational — a broken sink never replaces the
   *  real provider error or alters execution. */
  private async recordProviderError(operation: string, error: ProviderError): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record({
        at: new Date().toISOString(),
        action: "provider.error",
        id: this.providerId,
        providerId: this.providerId,
        detail: {
          operation,
          code: error.code,
          kind: (error.details as { kind?: string } | undefined)?.kind,
          message: error.message,
        },
      });
    } catch (auditError) {
      this.log.warn(
        `Audit write failed for provider error (execution unaffected): ${
          auditError instanceof Error ? auditError.message : String(auditError)
        }`,
      );
    }
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
    let response: { status: number; body: unknown; durationMs: number };
    try {
      response = await requestJson(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(this.config, this.env),
        timeoutMs: this.requestTimeoutMs,
        body: {
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.stop !== undefined ? { stop: request.stop } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        await this.recordProviderError("chat", error);
        throw error;
      }
      const normalized = providerTransportError({ provider: this.config.name, operation: "chat", cause: error });
      await this.recordProviderError("chat", normalized);
      throw normalized;
    }
    const { status, body } = response;

    if (status !== 200) {
      const httpError = providerHttpError({
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
      await this.recordProviderError("chat", httpError);
      throw httpError;
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

/**
 * Streams a chat completion from an OpenAI-compatible SSE endpoint (§11).
 * Emits deltas through `onChunk` and returns the assembled response.
 */
export async function streamChatCompletion(
  config: ProviderConfig,
  request: ChatRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<ChatResponse> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...authHeaders(config, env),
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw providerTransportError({ provider: config.name, operation: "stream", cause: error });
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw providerHttpError({ provider: config.name, operation: "stream", status: response.status, body });
  }
  if (!response.body) {
    throw providerHttpError({
      provider: config.name,
      operation: "stream",
      status: 500,
      body: { error: { message: "streaming is not supported by this endpoint" } },
    });
  }

  let content = "";
  let model = request.model;
  let finishReason: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0 || line.startsWith(":")) continue;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue; // tolerate non-JSON SSE noise
      }
      if (typeof event.model === "string") model = event.model;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const first = choices[0] as { delta?: { content?: unknown }; finish_reason?: unknown } | undefined;
      const delta = typeof first?.delta?.content === "string" ? first.delta.content : "";
      if (delta.length > 0) content += delta;
      if (typeof first?.finish_reason === "string") finishReason = first.finish_reason;
      onChunk({ delta, ...(finishReason !== undefined ? { finishReason } : {}), raw: event });
    }
  }

  return { model, content, ...(finishReason !== undefined ? { finishReason } : {}) };
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
