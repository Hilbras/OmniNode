/** Pipeline engine: coordinating multiple AI operations (§14, §15). */
import type { Report } from "./report.js";
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
  /** Single agent for analyze/execute/custom steps. */
  agent?: string;
  /** Model used for plan steps, as "provider:model-id". */
  model?: string;
  /** Defaults to the previous step (implicit sequential chain). */
  dependsOn?: string[];
  condition?: PipelineStepCondition;
  retries?: number;
}

export interface PipelineDefinition {
  id: string;
  name?: string;
  /** Default objective; can be overridden at run time. */
  objective?: string;
  /** Optional role applied to research/execute tasks. */
  role?: string;
  steps: PipelineStep[];
}

/**
 * Run status. "partial" means the run finished but some step outcome was
 * incomplete or unprovable (partial fan-out, unknown task state) — the
 * authoritative detail always lives in `stepRuns`/`taskRuns`.
 */
export type PipelineRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "cancelled";

export interface PipelineStepRun {
  stepId: string;
  status: TaskStatus;
  /** Tasks created for this step (research fans out to several). */
  taskIds?: string[];
  /** Set on plan steps that produced a stored plan (§18). */
  planId?: string;
  error?: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  /** The objective this run is executing (persisted for retries). */
  objective?: string;
  status: PipelineRunStatus;
  startedAt?: string;
  finishedAt?: string;
  stepRuns: PipelineStepRun[];
  /** Structured reports gathered across all steps (Phase 6 builds on this). */
  reports?: Report[];
  /** Set when the report system generated a combined report for this run. */
  combinedReportId?: string;
  /** Set when a plan step produced an implementation plan (§18). */
  planId?: string;
  /** Outcome summary of the final executed step (§28 — Result). */
  resultSummary?: string;
}
