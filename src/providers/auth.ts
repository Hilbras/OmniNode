/**
 * Authentication resolution (§24): API keys live in the environment and are
 * referenced from configuration by variable name — never stored in files.
 */
import { ProviderError } from "../errors/index.js";
// AuthRef is structurally satisfied by ProviderConfig.

/** Minimal provider identity — any config object with a name and optional env var reference. */
export interface AuthRef {
  name: string;
  apiKeyEnvVar?: string;
  headers?: Record<string, string>;
}

export function resolveApiKey(
  config: AuthRef,
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
  config: AuthRef,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const key = resolveApiKey(config, env);
  const base = { ...(config.headers ?? {}) };
  return key ? { ...base, authorization: `Bearer ${key}` } : base;
}
