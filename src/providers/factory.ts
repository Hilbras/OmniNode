/**
 * Provider factory: builds adapter instances from configuration (§5, §7).
 * Custom and local gateways ride the OpenAI-compatible adapter unless a
 * dedicated one exists.
 */
import { OmniNodeError } from "../errors/index.js";
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

export function createProvider(config: ProviderConfig, options: CreateProviderOptions = {}): IChatProvider {
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
