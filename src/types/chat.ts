/** Chat completion types — the foundation for planner and research phases (§18, §15). */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** Provider-specific model id, e.g. "qwen3-coder". */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  metadata?: Record<string, unknown>;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  /** Model that actually served the request, as reported by the provider. */
  model: string;
  content: string;
  finishReason?: string;
  usage?: ChatUsage;
  /** Verbatim provider response body for advanced consumers. */
  raw?: unknown;
}

/**
 * Model-backed chat used by the planner layer. Lives in the neutral types
 * layer so adapters (e.g. planner) never depend on engine modules.
 */
export type ChatFn = (model: string, messages: ChatMessage[]) => Promise<string>;

/** One streamed chunk (SSE deltas from OpenAI-compatible gateways). */
export interface ChatStreamChunk {
  /** Text delta (empty for role-only or final chunks). */
  delta: string;
  /** Provider-reported finish reason, on the final chunk. */
  finishReason?: string;
  raw?: unknown;
}
