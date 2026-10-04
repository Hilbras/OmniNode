/**
 * Provider abstraction. OmniNode is provider-agnostic: any AI gateway or local
 * runtime plugs in through this interface (DEVELOPMENT_PLAN.md §5–§7).
 */
import type { ChatRequest, ChatResponse } from "./chat.js";
import type { ModelInfo } from "./model.js";

export type ProviderType =
  | "openai-compatible"
  | "omnihilbras"
  | "openrouter"
  | "local"
  | "custom";

export type ProviderHealth = "unknown" | "healthy" | "degraded" | "unreachable";

export interface ProviderConfig {
  /** Unique name used in project configuration and the model registry. */
  name: string;
  type: ProviderType;
  baseUrl: string;
  /**
   * Name of the environment variable that holds the API key. Keys are never
   * stored in project files (DEVELOPMENT_PLAN.md §24 — Security).
   */
  apiKeyEnvVar?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProviderStatus {
  name: string;
  type: ProviderType;
  baseUrl: string;
  health: ProviderHealth;
  connected: boolean;
  modelCount: number;
  lastCheckedAt?: string;
  message?: string;
}

/** Contract every provider adapter implements (Phase 1+). */
export interface IProvider {
  readonly config: ProviderConfig;
  /** Discover models exposed by this provider. */
  listModels(): Promise<ModelInfo[]>;
  /** Check connectivity and authentication. */
  healthCheck(): Promise<ProviderStatus>;
}

/** Contract for providers that can run chat completions (foundation for planning). */
export interface IChatProvider extends IProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
