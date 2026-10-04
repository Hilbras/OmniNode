/**
 * Agent environment policies (roadmap §8, Environment Isolation).
 *
 * Four explicit policies, so operators decide exactly what an agent can see:
 *   - `inherit`   (default, backwards compatible): the full parent environment
 *   - `allowlist`: only the allow-listed variables (+ PATH/HOME)
 *   - `denylist`: the parent environment minus the deny-listed variables
 *   - `explicit`: nothing from the parent; only PATH/HOME and `env`
 *
 * The v1 boolean `inherit_env: false` is still honored and maps to `explicit`.
 */
import type { AgentConfig } from "../types/agent.js";

export type EnvPolicy = "inherit" | "allowlist" | "denylist" | "explicit";

/** Variables always provided so shells and runtimes keep working. */
const BASELINE_KEYS = ["PATH", "HOME"] as const;

export function resolveEnvPolicy(config: Partial<AgentConfig>): EnvPolicy {
  if (config.envPolicy !== undefined) return config.envPolicy;
  if (config.inheritEnv === false) return "explicit"; // v1 compatibility
  return "inherit";
}

export function buildChildEnv(config: AgentConfig): NodeJS.ProcessEnv {
  const configured = config.env ?? {};
  const policy = resolveEnvPolicy(config);

  if (policy === "inherit") {
    return { ...process.env, ...configured };
  }

  const base: NodeJS.ProcessEnv = {};
  for (const key of BASELINE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }

  switch (policy) {
    case "explicit":
      return { ...base, ...configured };
    case "allowlist": {
      const allowed: NodeJS.ProcessEnv = { ...base };
      for (const key of config.envAllowlist ?? []) {
        const value = process.env[key];
        if (value !== undefined) allowed[key] = value;
      }
      return { ...allowed, ...configured };
    }
    case "denylist": {
      const denied = new Set((config.envDenylist ?? []).map((k) => k.toUpperCase()));
      const filtered: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (denied.has(key.toUpperCase())) continue;
        filtered[key] = value;
      }
      return { ...filtered, ...configured };
    }
  }
}