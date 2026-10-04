/** Normalized model registry entry (DEVELOPMENT_PLAN.md §8). */

export interface ModelCapabilities {
  chat?: boolean;
  coding?: boolean;
  tools?: boolean;
  vision?: boolean;
  embeddings?: boolean;
}

export type ModelStatus = "available" | "unavailable" | "deprecated";

export type Modality = "text" | "image" | "audio" | "video" | "embedding";

/** Model metadata (roadmap §10, Model Metadata). */
export interface ModelInfo {
  /** Name of the provider this model belongs to. */
  provider: string;
  /** Provider-specific model identifier, e.g. "qwen3-coder". */
  id: string;
  displayName?: string;
  /** Human-readable model name reported by the provider, when available. */
  name?: string;
  capabilities?: ModelCapabilities;
  contextWindow?: number;
  inputTypes?: Modality[];
  outputTypes?: Modality[];
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsStructuredOutput?: boolean;
  supportsStreaming?: boolean;
  status?: ModelStatus;
  metadata?: Record<string, unknown>;
}
