/**
 * Authentication resolution (§24): API keys live in the environment and are
 * referenced from configuration by variable name — never stored in files.
 */
import { ProviderError } from "../errors/index.js";
import type { ProviderConfig } from "../types/provider.js";

export function resolveApiKey(
  config: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!config.apiKeyEnvVar) return undefined;
  const value = env[config.apiKeyEnvVar];
  if (!value) {
    throw new ProviderError(
      "PROVIDER_AUTH_FAILED",
      `Environment variable "${config.apiKeyEnvVar}" (referenced by provider "${config.name}") is not set.`,
    );
  }
  return value;
}

export function authHeaders(
  config: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const key = resolveApiKey(config, env);
  const base = { ...(config.headers ?? {}) };
  return key ? { ...base, authorization: `Bearer ${key}` } : base;
}
