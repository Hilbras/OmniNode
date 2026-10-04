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
  /** Constraints handed to the planner for plan steps (§15). */
  constraints?: string[];
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

/**
 * One step execution inside a run (§9.1 — Step Run is NOT the Step).
 */
export interface PipelineStepRun {
  stepId: string;
  status: TaskStatus;
  /** Tasks created for this step (research fans out to several). */
  taskIds?: string[];
  /** Execution ids of the tasks this step created, for correlation (§6.5). */
  executionIds?: string[];
  /** Which attempt of this step produced this record (1 = first try). */
  attempt?: number;
  /** Set on plan steps that produced a stored plan (§18). */
  planId?: string;
  error?: string;
}

/** One execution attempt of a run (§9.1 — Attempt is not the Run). */
export interface PipelineRunAttempt {
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  status: PipelineRunStatus;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  /** Execution attempt counter: retries of the same run increment it. */
  attempt: number;
  /** Set when cancellation was requested; the run stops at the next check point. */
  cancellationRequested?: boolean;
  cancellationRequestedAt?: string;
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
  /** Per-attempt history (§9.1). */
  attempts?: PipelineRunAttempt[];
}

/**
 * Executor contract (roadmap §9.1 / §9.2): a Pipeline definition, a Run of
 * it, Steps, Step Runs and Attempts are distinct concepts; this interface is
 * what orchestration code depends on.
 */
export interface IPipelineExecutor {
  validate(definition: PipelineDefinition): void;
  run(definition: PipelineDefinition, options?: PipelineRunOptions): Promise<PipelineRun>;
  cancel(runId: string): Promise<void>;
  get(runId: string): Promise<PipelineRun | undefined>;
  listRuns(filter?: { pipelineId?: string }): Promise<PipelineRun[]>;
}

export interface PipelineRunOptions {
  objective?: string;
  onStep?: (stepRun: PipelineStepRun) => void;
  /** Total run attempts (1 = no automatic rerun of the whole run). */
  maxAttempts?: number;
}
