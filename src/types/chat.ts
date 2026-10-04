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
