/** Pipeline engine: coordinating multiple AI operations (§14). */
import type { TaskStatus } from "./task.js";

export type PipelineStepKind =
  | "research"
  | "collect"
  | "analyze"
  | "plan"
  | "execute"
  | "custom";

export type PipelineStepCondition = "always" | "on-success" | "on-failure";

export interface PipelineStep {
  id: string;
  kind: PipelineStepKind;
  /** Agents fanned out for research steps. */
  agents?: string[];
  /** Model used for plan steps, e.g. "my-gateway:chatgpt". */
  model?: string;
  dependsOn?: string[];
  condition?: PipelineStepCondition;
  retries?: number;
}

export interface PipelineDefinition {
  id: string;
  name?: string;
  steps: PipelineStep[];
}

export type PipelineRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface PipelineStepRun {
  stepId: string;
  taskId?: string;
  status: TaskStatus;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: PipelineRunStatus;
  startedAt?: string;
  finishedAt?: string;
  stepRuns: PipelineStepRun[];
}
