/**
 * Configuration schema. The project file (omninode.yaml) uses snake_case keys
 * as shown in DEVELOPMENT_PLAN.md §7 and §23; the loader maps them onto the
 * camelCase TypeScript contracts in src/types.
 */
import { z } from "zod";

export const providerConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["openai-compatible", "omnihilbras", "openrouter", "local", "custom"]),
    base_url: z.string().url(),
    api_key_env_var: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const agentConfigSchema = z
  .object({
    name: z.string().min(1),
    /** "cli" agents communicate over stdin/stdout (process adapter). */
    type: z.enum(["cli", "native", "process"]).default("cli"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    input_mode: z.enum(["stdin", "arg", "protocol"]).default("stdin"),
    timeout_ms: z.number().int().positive().optional(),
    inherit_env: z.boolean().optional(),
    env_policy: z.enum(["inherit", "allowlist", "denylist", "explicit"]).optional(),
    env_allowlist: z.array(z.string()).optional(),
    env_denylist: z.array(z.string()).optional(),
    max_output_bytes: z.number().int().positive().optional(),
    allow_external_cwd: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const roleConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "role id must be kebab-case"),
    name: z.string().min(1),
    description: z.string().optional(),
    responsibilities: z.array(z.string()).default([]),
    expected_outputs: z.array(z.string()).default([]),
    preferred_agents: z.array(z.string()).optional(),
    system_prompt: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const pipelineStepConfigSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["research", "collect", "analyze", "plan", "execute", "custom"]),
    agents: z.array(z.string()).optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    retries: z.number().int().min(0).max(10).optional(),
    condition: z.enum(["always", "on-success", "on-failure"]).optional(),
  })
  .strict();

export const pipelineConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "pipeline id must be kebab-case"),
    name: z.string().optional(),
    objective: z.string().optional(),
    role: z.string().optional(),
    steps: z.array(pipelineStepConfigSchema).min(1),
  })
  .strict();

export const plannerConfigSchema = z
  .object({
    kind: z.enum(["model", "heuristic"]).default("model"),
    model: z.string().optional(),
    instruction: z.string().optional(),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    name: z.string().min(1),
    providers: z.array(providerConfigSchema).default([]),
    agents: z.array(agentConfigSchema).default([]),
    roles: z.array(roleConfigSchema).default([]),
    pipelines: z.array(pipelineConfigSchema).default([]),
    planner: plannerConfigSchema.optional(),
    memory: z
      .object({
        provider: z.string().min(1).default("local"),
        base_url: z.string().url().optional(),
        api_key_env_var: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    project: projectConfigSchema,
    logging: z
      .object({ level: z.enum(["debug", "info", "warn", "error"]) })
      .strict()
      .optional(),
  })
  .strict();

export type ProviderConfigYaml = z.infer<typeof providerConfigSchema>;
export type AgentConfigYaml = z.infer<typeof agentConfigSchema>;
export type RoleConfigYaml = z.infer<typeof roleConfigSchema>;
export type PipelineConfigYaml = z.infer<typeof pipelineConfigSchema>;
export type PipelineStepConfigYaml = z.infer<typeof pipelineStepConfigSchema>;
export type PlannerConfigYaml = z.infer<typeof plannerConfigSchema>;
export type ProjectConfigYaml = z.infer<typeof projectConfigSchema>;
export type AppConfigYaml = z.infer<typeof appConfigSchema>;
