/** Normalized model registry entry (DEVELOPMENT_PLAN.md §8). */

export interface ModelCapabilities {
  chat?: boolean;
  coding?: boolean;
  tools?: boolean;
  vision?: boolean;
  embeddings?: boolean;
}

export type ModelStatus = "available" | "unavailable" | "deprecated";

export interface ModelInfo {
  /** Name of the provider this model belongs to. */
  provider: string;
  /** Provider-specific model identifier, e.g. "qwen3-coder". */
  id: string;
  displayName?: string;
  capabilities?: ModelCapabilities;
  contextWindow?: number;
  status?: ModelStatus;
  metadata?: Record<string, unknown>;
}
