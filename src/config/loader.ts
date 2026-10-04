/**
 * Configuration loader: discovers omninode.yaml, expands ${ENV_VAR}
 * references (so credentials never live in project files, §24), validates it
 * and maps it onto the core TypeScript contracts.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "../errors/index.js";
import { describeSecretFindings, scanForInlineSecrets } from "./secrets.js";
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
  /** Explicit path; otherwise omninode.yaml/yml/json is looked up in the given directory. */
  path?: string;
  directory?: string;
  /** Environment used for ${VAR} expansion; defaults to process.env. */
  env?: Record<string, string | undefined>;
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

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const path = options.path ?? (options.directory ? findConfigFile(options.directory) : findConfigFile());
  if (!path) {
    throw new ConfigError(
      "CONFIG_NOT_FOUND",
      "No omninode.yaml found. Run `omninode init` to create one, or pass an explicit path.",
    );
  }

  const raw = readFileSync(path, "utf8");
  // §13 Security: refuse inline credentials before anything is persisted.
  const secretFindings = scanForInlineSecrets(raw);
  if (secretFindings.length > 0) {
    throw new ConfigError("CONFIG_INVALID", describeSecretFindings(path, secretFindings));
  }
  const expanded = expandEnvRefs(raw, env, path);

  let data: unknown;
  try {
    data = parseYaml(expanded);
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `Failed to parse ${path}.`, { cause: error });
  }

  const parsed = appConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${location}: ${issue.message}`;
    });
    throw new ConfigError("CONFIG_INVALID", `Invalid configuration in ${path}.`, {
      details: { issues },
    });
  }

  return toAppConfig(parsed.data);
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

