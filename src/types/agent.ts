/** Agent abstraction: CLI agents and custom agents plug in via adapters (§9–§10). */
import type { AskedQuestion } from "../agent-protocol/types.js";
import type { AgentDescriptor } from "../agent-protocol/handshake.js";
import type { Report } from "./report.js";
import type { RoleDefinition } from "./role.js";

export type AgentIntegrationType = "native" | "process" | "custom";

export type AgentStatus =
  | "registered"
  | "ready"
  | "running"
  | "busy"
  | "stopped"
  | "error";

/** How the task payload reaches a process agent (§9). */
export type AgentInputMode = "stdin" | "arg" | "protocol";

export interface AgentConfig {
  name: string;
  integration: AgentIntegrationType;
  /** Executable command for process agents, e.g. "opencode". */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** How the task is delivered: prompt on stdin, as last argument, or the §21 JSON-lines protocol. */
  inputMode?: AgentInputMode;
  /** Per-task timeout in milliseconds; the process is killed when exceeded. */
  timeoutMs?: number;
  /** When false, the agent process starts with a minimal environment (PATH + env). */
  inheritEnv?: boolean;
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
  /** Pipeline run that owns this task (protocol correlation, §7.4). */
  pipelineId?: string;
  /** Execution identity for this attempt (protocol correlation, §7.4). */
  executionId?: string;
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
  /** Structured reports extracted from protocol-mode runs (§16, §21). */
  reports?: Report[];
  /** Protocol diagnostics for protocol-mode runs (roadmap §7): questions asked, violations seen. */
  protocol?: {
    protocol: string;
    legacy: boolean;
    descriptor?: AgentDescriptor;
    questions: AskedQuestion[];
    violations: string[];
  };
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
