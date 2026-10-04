/**
 * Configuration composition (v2 Phase 16 — Configuration System v2).
 *
 * Precedence, highest first:
 *   1. CLI arguments      (--config / --profile, explicit file)
 *   2. Environment        (OMNINODE_*)
 *   3. Project config     (./omninode.yaml)
 *   4. User config        (~/.omninode/config.yaml)
 *   5. Profile overlay    (selected profile, applied over 3+4)
 *   6. Defaults
 *
 * Profiles let one file describe several environments (development,
 * production, testing) without duplicating the whole configuration.
 */
import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig } from "./loader.js";

/** Loose input shape: composition happens before strict validation. */
export type AppConfigInput = Record<string, unknown>;

export const KNOWN_PROFILES = ["default", "development", "production", "testing"] as const;
export type ProfileName = (typeof KNOWN_PROFILES)[number];

export interface ConfigSources {
  /** Project-level configuration file, if any. */
  projectFile?: string;
  /** User-level configuration file, if any. */
  userFile?: string;
  /** Active profile. */
  profile: string;
  /** Environment variables that overrode configuration. */
  envOverrides: string[];
  /** Values that came from built-in defaults. */
  defaults: string[];
}

/** Default user-level configuration locations, most portable first. */
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
  if (env.OMNINODE_USER_CONFIG) return env.OMNINODE_USER_CONFIG;
  const home = env.HOME ?? homedir();
  return path.join(home, ".omninode", "config.yaml");
}

/** Picks the profile: CLI (applied by the loader) > environment > file > default. */
export function resolveProfile(
  input: { profile?: unknown },
  env: Record<string, string | undefined>,
): string {
  if (env.OMNINODE_PROFILE) return env.OMNINODE_PROFILE;
  if (typeof input.profile === "string" && input.profile.length > 0) return input.profile;
  return "default";
}

/** Deep-merges configuration overlays (objects merge, scalars/arrays replace). */
export function mergeConfig<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return (overlay === undefined ? base : (overlay as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    if (Array.isArray(value)) {
      result[key] = value;
    } else if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = mergeConfig(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** Environment overrides applied above every file source. */
export function applyEnvOverrides(
  input: AppConfigInput,
  env: Record<string, string | undefined>,
): { config: AppConfigInput; applied: string[] } {
  const applied: string[] = [];
  const config: AppConfigInput = mergeConfig(input, {});

  if (env.OMNINODE_LOG_LEVEL) {
    config.logging = { ...(asObject(config.logging)), level: env.OMNINODE_LOG_LEVEL };
    applied.push("OMNINODE_LOG_LEVEL");
  }
  if (env.OMNINODE_LOG_FORMAT) {
    config.logging = { ...(asObject(config.logging)), format: env.OMNINODE_LOG_FORMAT };
    applied.push("OMNINODE_LOG_FORMAT");
  }
  const memoryProvider = env.OMNINODE_MEMORY_PROVIDER;
  const memoryRequired = env.OMNINODE_MEMORY_REQUIRED;
  if (memoryProvider || memoryRequired) {
    const project = asObject(config.project);
    config.project = {
      ...project,
      memory: {
        ...asObject(project.memory ?? { provider: "local" }),
        ...(memoryProvider ? { provider: memoryProvider } : {}),
        ...(memoryRequired ? { required: memoryRequired !== "false" } : {}),
      },
    };
    if (memoryProvider) applied.push("OMNINODE_MEMORY_PROVIDER");
    if (memoryRequired) applied.push("OMNINODE_MEMORY_REQUIRED");
  }
  return { config, applied };
}

/** Built-in defaults, applied last. */
export function applyDefaults(input: AppConfigInput): { config: AppConfigInput; applied: string[] } {
  const applied: string[] = [];
  const config: AppConfigInput = mergeConfig(input, {});
  const logging = asObject(config.logging);
  if (logging.level === undefined) {
    config.logging = { ...logging, level: "info" };
    applied.push("logging.level");
  }
  if (logging.format === undefined) {
    config.logging = { ...asObject(config.logging), format: "text" };
    applied.push("logging.format");
  }
  return { config, applied };
}

export type { AppConfig };
