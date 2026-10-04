/**
 * Configuration loader: discovers omninode.yaml, expands ${ENV_VAR}
 * references (so credentials never live in project files, §24), validates it
 * and maps it onto the core TypeScript contracts.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "../errors/index.js";
import { describeSecretFindings, scanForInlineSecrets } from "./secrets.js";
import {
  applyDefaults,
  applyEnvOverrides,
  mergeConfig,
  resolveProfile,
  userConfigPath,
  type AppConfigInput,
  type ConfigSources,
} from "./profiles.js";
import type { AgentConfig, AgentIntegrationType } from "../types/agent.js";
import type { ProviderConfig } from "../types/provider.js";
import type { RoleDefinition } from "../types/role.js";
import type { LogLevel } from "../logger/index.js";
import { appConfigSchema } from "./schema.js";
import type { AgentConfigYaml, PipelineConfigYaml, ProviderConfigYaml, RoleConfigYaml } from "./schema.js";
import type { PipelineDefinition } from "../types/pipeline.js";

const CONFIG_FILENAMES = ["omninode.yaml", "omninode.yml", "omninode.json"];

export interface AppConfig {
  project: {
    name: string;
    providers: ProviderConfig[];
    agents: AgentConfig[];
    roles: RoleDefinition[];
    pipelines: PipelineDefinition[];
    planner?: {
      kind: "model" | "heuristic";
      model?: string;
      instruction?: string;
    };
    memory?: {
      provider: string;
      baseUrl?: string;
      apiKeyEnvVar?: string;
      required?: boolean;
    };
  };
  logging?: {
    level: LogLevel;
  };
}

export interface LoadConfigOptions {
  /** Explicit path (CLI --config); otherwise the project file is discovered. */
  path?: string;
  directory?: string;
  /** Environment used for ${VAR} expansion and OMNINODE_* overrides; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Profile override (CLI --profile), above environment and file selection. */
  profile?: string;
}

export function findConfigFile(directory = process.cwd()): string | undefined {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = `${directory}/${filename}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Replaces ${VAR} and ${VAR:-fallback} references. Unset variables without a
 * fallback abort loading: a half-resolved config could silently misroute
 * authentication.
 */
export function expandEnvRefs(
  text: string,
  env: Record<string, string | undefined>,
  source = "config",
): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      const value = env[name] ?? fallback;
      if (value === undefined) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Environment variable "${name}" is referenced in ${source} but is not set and has no default.`,
        );
      }
      return value;
    },
  );
}

export interface LoadConfigResult {
  config: AppConfig;
  sources: ConfigSources;
}

/**
 * Composes configuration from every source with the documented precedence
 * (roadmap §16): CLI → environment → project file → user file → profile
 * overlay → defaults.
 */
export function loadConfigDetailed(options: LoadConfigOptions = {}): LoadConfigResult {
  const env = options.env ?? process.env;
  const explicitPath = options.path;

  // 1. Files: user config first, project config overrides it.
  let input: AppConfigInput = {} as AppConfigInput;
  let projectFile: string | undefined;
  let userFile: string | undefined;

  if (!explicitPath) {
    const candidate = userConfigPath(env);
    if (existsSync(candidate)) {
      input = mergeConfig(input, readConfigDocument(candidate, env));
      userFile = candidate;
    }
  }

  const resolvedProject =
    explicitPath ??
    (options.directory ? findConfigFile(options.directory) : findConfigFile());
  if (resolvedProject) {
    input = mergeConfig(input, readConfigDocument(resolvedProject, env));
    projectFile = resolvedProject;
  }

  if (!projectFile && !userFile) {
    throw new ConfigError(
      "CONFIG_NOT_FOUND",
      "No omninode.yaml found. Run `omninode init` to create one, or pass an explicit path.",
    );
  }

  // 2. Profile overlay, selected by CLI > env > file.
  const profile = options.profile ?? resolveProfile(input, env);
  const overlay = (input as { profiles?: Record<string, unknown> }).profiles?.[profile];
  if (overlay !== undefined) {
    const { profiles: _drop, ...base } = input as { profiles?: unknown } & Record<string, unknown>;
    input = mergeConfig(base, overlay) as AppConfigInput;
  } else if (profile !== "default" && profile !== "") {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Profile "${profile}" is not defined in this configuration (known: ${Object.keys((input as { profiles?: Record<string, unknown> }).profiles ?? {}).join(", ") || "none"}).`,
    );
  }

  // 3. Environment overrides, then defaults.
  const withEnv = applyEnvOverrides(input, env);
  const withDefaults = applyDefaults(withEnv.config);

  // 4. Validate the composed document.
  const parsed = appConfigSchema.safeParse(withDefaults.config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const location = issue.path.join(".") || "(root)";
      return `${location}: ${issue.message}`;
    });
    throw new ConfigError(
      "CONFIG_INVALID",
      `Invalid configuration:\n  ${issues.join("\n  ")}`,
      { details: { issues } },
    );
  }

  return {
    config: toAppConfig(parsed.data),
    sources: {
      ...(projectFile !== undefined ? { projectFile } : {}),
      ...(userFile !== undefined ? { userFile } : {}),
      profile,
      envOverrides: withEnv.applied,
      defaults: withDefaults.applied,
    },
  };
}

/** Reads, secret-scans and parses a configuration file. */
function readConfigDocument(path: string, optionsEnv: Record<string, string | undefined>): AppConfigInput {
  const raw = readFileSync(path, "utf8");
  // §13 Security: refuse inline credentials before anything is persisted.
  const secretFindings = scanForInlineSecrets(raw);
  if (secretFindings.length > 0) {
    throw new ConfigError("CONFIG_INVALID", describeSecretFindings(path, secretFindings));
  }
  // ${VAR} / ${VAR:-fallback} references are expanded before parsing.
  const expanded = expandEnvRefs(raw, optionsEnv, path);
  try {
    return parseYaml(expanded) as AppConfigInput;
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `Failed to parse ${path}.`, { cause: error });
  }
}

/** Backwards-compatible wrapper: the composed configuration. */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  return loadConfigDetailed(options).config;
}

/**
 * Actionable configuration diagnostics (roadmap §16) — the kind of message a
 * user can act on, rather than a generic schema failure.
 */
export function configDiagnostics(config: AppConfig): string[] {
  const notes: string[] = [];
  for (const provider of config.project.providers) {
    if (!provider.apiKeyEnvVar && provider.baseUrl.startsWith("https://")) {
      notes.push(
        `Provider "${provider.name}": API key reference is missing — add api_key_env_var: <ENV_VAR> unless this endpoint is intentionally keyless.`,
      );
    }
  }
  for (const agent of config.project.agents) {
    if (!agent.command && agent.integration !== "custom") {
      notes.push(`Agent "${agent.name}": no command configured — the process adapter needs one.`);
    }
    if (agent.allowExternalCwd) {
      notes.push(`Agent "${agent.name}": may run outside the project root (allow_external_cwd).`);
    }
  }
  for (const pipeline of config.project.pipelines) {
    const ids = new Set(pipeline.steps.map((s) => s.id));
    for (const step of pipeline.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!ids.has(dep)) {
          notes.push(`Pipeline "${pipeline.id}": step "${step.id}" depends on unknown step "${dep}".`);
        }
      }
    }
  }
  return notes;
}

function toAppConfig(yaml: ReturnType<typeof appConfigSchema.parse>): AppConfig {
  return {
    project: {
      name: yaml.project.name,
      providers: yaml.project.providers.map(toProviderConfig),
      agents: yaml.project.agents.map(toAgentConfig),
      roles: yaml.project.roles.map(toRoleDefinition),
      pipelines: yaml.project.pipelines.map(toPipelineDefinition),
      ...(yaml.project.planner !== undefined
        ? {
            planner: {
              kind: yaml.project.planner.kind,
              model: yaml.project.planner.model,
              instruction: yaml.project.planner.instruction,
            },
          }
        : {}),
      ...(yaml.project.memory !== undefined
        ? {
            memory: {
              provider: yaml.project.memory.provider,
              baseUrl: yaml.project.memory.base_url,
              apiKeyEnvVar: yaml.project.memory.api_key_env_var,
              required: yaml.project.memory.required,
            },
          }
        : {}),
    },
    ...(yaml.logging !== undefined ? { logging: yaml.logging } : {}),
  };
}

function toPipelineDefinition(raw: PipelineConfigYaml): PipelineDefinition {
  return {
    id: raw.id,
    name: raw.name,
    objective: raw.objective,
    role: raw.role,
    steps: raw.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      agents: step.agents,
      agent: step.agent,
      model: step.model,
      dependsOn: step.depends_on,
      retries: step.retries,
      condition: step.condition,
      constraints: step.constraints,
    })),
  };
}

function toProviderConfig(raw: ProviderConfigYaml): ProviderConfig {
  return {
    name: raw.name,
    type: raw.type,
    baseUrl: raw.base_url,
    apiKeyEnvVar: raw.api_key_env_var,
    timeoutMs: raw.timeout_ms,
    headers: raw.headers,
    enabled: raw.enabled,
    metadata: raw.metadata,
  };
}

function toAgentConfig(raw: AgentConfigYaml): AgentConfig {
  const integration: AgentIntegrationType =
    raw.type === "native" ? "native" : "process";
  return {
    name: raw.name,
    integration,
    command: raw.command,
    args: raw.args,
    cwd: raw.cwd,
    env: raw.env,
    inputMode: raw.input_mode,
    timeoutMs: raw.timeout_ms,
    inheritEnv: raw.inherit_env,
    envPolicy: raw.env_policy,
    envAllowlist: raw.env_allowlist,
    envDenylist: raw.env_denylist,
    maxOutputBytes: raw.max_output_bytes,
    allowExternalCwd: raw.allow_external_cwd,
    metadata: raw.metadata,
  };
}

function toRoleDefinition(raw: RoleConfigYaml): RoleDefinition {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    responsibilities: raw.responsibilities,
    expectedOutputs: raw.expected_outputs,
    preferredAgents: raw.preferred_agents,
    systemPrompt: raw.system_prompt,
    metadata: raw.metadata,
  };
}

