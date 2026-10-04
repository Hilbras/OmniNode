/** Task system: every operation becomes a Task (§13). */
import type { Report } from "./report.js";

/**
 * Execution states (v2 Phase 2, roadmap §6.1).
 *
 * The crucial distinction: `unknown` means "we cannot prove the outcome" —
 * e.g. a process timeout after the agent may already have performed side
 * effects. It is deliberately NOT `failed`: retrying blindly could duplicate
 * work, and reporting failure would be a lie. Resolve it explicitly with
 * `task retry` (which starts a fresh execution) or by inspecting artifacts.
 */
export type TaskStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown"
  | "partially_completed";

/** States from which no further automatic transition happens. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "partially_completed",
];

/** One execution attempt (roadmap §6.5 identity: task + attempt + execution id). */
export interface ExecutionRecord {
  executionId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outcome: "completed" | "failed" | "timed_out" | "unknown" | "cancelled";
  error?: string;
}

export interface TaskContext {
  project?: string;
  /** Paths or globs relevant to the task. */
  files?: string[];
  /** Free-form background injected into the prompt. */
  background?: string;
  /** Keys of memory entries pulled from the memory provider. */
  memoryKeys?: string[];
}

export interface TaskResult {
  summary?: string;
  artifacts?: string[];
  reportId?: string;
  /** Structured reports produced by protocol-mode agents (Phase 6 builds on this). */
  reports?: Report[];
  /** Truncated verbatim agent output, kept for report extraction and audit. */
  rawOutput?: string;
  error?: string;
  finishedAt?: string;
}

export interface Task {
  id: string;
  project?: string;
  /** Pipeline run that owns this task, when created by a pipeline. */
  pipelineId?: string;
  objective: string;
  /** Role id from the role system. */
  role?: string;
  /** Agent name from the agent registry. */
  agent?: string;
  context?: TaskContext;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Number of engine.run attempts so far (0 = never executed). */
  attempt: number;
  /** Error from the most recent failed/unknown attempt. */
  lastError?: string;
  /** Recent execution attempts, newest last, bounded in length. */
  executions?: ExecutionRecord[];
  result?: TaskResult;
}
