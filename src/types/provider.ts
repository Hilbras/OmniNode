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

/** Declared provider capabilities (roadmap §10, Provider Interface). */
export type ProviderCapability =
  | "chat"
  | "models"
  | "streaming"
  | "tools"
  | "embeddings"
  | "vision";

/** Normalized authentication description — never contains a secret value. */
export interface ProviderAuthentication {
  /** How the provider authenticates. */
  method: "bearer" | "none" | "custom";
  /** Environment variable that holds the credential, if any. */
  envVar?: string;
  /** True when the referenced variable is currently set. */
  configured: boolean;
}

export interface ProviderConfig {
  /** Stable identifier used in records and references (defaults to `name`). */
  providerId?: string;
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
  /** Capabilities declared for this provider (discovered ones are merged in). */
  capabilities?: ProviderCapability[];
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

/** Contract every provider adapter implements (roadmap §10). */
export interface IProvider {
  readonly config: ProviderConfig;
  /** Stable identifier of this provider. */
  readonly providerId: string;
  /** Normalized authentication description (no secret values). */
  readonly authentication: ProviderAuthentication;
  /**
   * Connect: authenticate and discover models (roadmap §10, Model Discovery).
   * Returns the discovered models.
   */
  connect(): Promise<ModelInfo[]>;
  /** Discover models exposed by this provider. */
  listModels(): Promise<ModelInfo[]>;
  /** Fetch a single model's metadata (from discovery; re-discovers if unknown). */
  getModel(modelId: string): Promise<ModelInfo | undefined>;
  /** Check connectivity and authentication. */
  healthCheck(): Promise<ProviderStatus>;
}

/** Contract for providers that can run chat completions (foundation for planning). */
export interface IChatProvider extends IProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
