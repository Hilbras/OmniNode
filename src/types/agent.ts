/** Agent abstraction: CLI agents and custom agents plug in via adapters (§9–§10). */
import type { RoleDefinition } from "./role.js";

export type AgentIntegrationType = "native" | "process" | "custom";

export type AgentStatus =
  | "registered"
  | "ready"
  | "running"
  | "busy"
  | "stopped"
  | "error";

export interface AgentConfig {
  name: string;
  integration: AgentIntegrationType;
  /** Executable command for process agents, e.g. "opencode". */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Models (as "provider:model-id") this agent may use, if restricted. */
  allowedModels?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentInfo {
  name: string;
  integration: AgentIntegrationType;
  version?: string;
  capabilities?: string[];
  command?: string;
  cwd?: string;
  status: AgentStatus;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskInput {
  taskId: string;
  objective: string;
  role?: RoleDefinition;
  /** Assembled task context (project, memory, files) already selected for this agent. */
  context?: string;
  instruction?: string;
}

export interface AgentTaskOutput {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  /** Verbatim agent output; structured report parsing lands in Phase 6. */
  rawOutput?: string;
  exitCode?: number;
  logs?: string[];
  error?: string;
}

/** Contract every agent adapter implements (Phase 3+). */
export interface IAgent {
  readonly info: AgentInfo;
  /** Submit a task and collect the agent's output. */
  run(input: AgentTaskInput): Promise<AgentTaskOutput>;
  /** Ask the agent to stop current work, if supported. */
  cancel?(taskId: string): Promise<void>;
}
