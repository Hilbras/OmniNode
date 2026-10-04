/**
 * Provider factory: builds adapter instances from configuration (§5, §7).
 * Custom and local gateways ride the OpenAI-compatible adapter unless a
 * dedicated one exists.
 */
import { ConfigError, OmniNodeError } from "../errors/index.js";
import type { AuditSink } from "../audit/index.js";
import type { IChatProvider, ProviderConfig, ProviderType } from "../types/provider.js";
import { OmniHilbrasProvider } from "./omnihilbras/index.js";
import { OpenAICompatibleProvider } from "./openai-compatible/index.js";

/** Provider types served by the OpenAI-compatible adapter. */
export const OPENAI_COMPATIBLE_TYPES: readonly ProviderType[] = [
  "openai-compatible",
  "openrouter",
  "local",
  "custom",
];

export interface CreateProviderOptions {
  /** Correlates provider errors in the audit log (§18). */
  audit?: AuditSink;
  env?: Record<string, string | undefined>;
}

function assertProviderConfig(config: ProviderConfig): void {
  // Library consumers bypass the config schema — validate here (§23).
  if (!config.name || config.name.trim().length === 0) {
    throw new ConfigError("CONFIG_INVALID", "Provider name must not be empty.");
  }
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new ConfigError("CONFIG_INVALID", `Provider "${config.name}" needs a baseUrl.`);
  }
  try {
    new URL(config.baseUrl);
  } catch {
    throw new ConfigError("CONFIG_INVALID", `Provider "${config.name}" has an invalid baseUrl: ${config.baseUrl}`);
  }
}

export function createProvider(config: ProviderConfig, options: CreateProviderOptions = {}): IChatProvider {
  assertProviderConfig(config);
  const shared = {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
  };
  if (config.type === "omnihilbras") {
    return new OmniHilbrasProvider(config, undefined, options.env, options.audit);
  }
  if (OPENAI_COMPATIBLE_TYPES.includes(config.type)) {
    return new OpenAICompatibleProvider(config, undefined, options.env, options.audit);
  }
  void shared;
  throw new OmniNodeError("NOT_IMPLEMENTED", `Provider type "${config.type}" has no adapter yet.`);
}
