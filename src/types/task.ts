/** Task system: every operation becomes a Task (§13). */
import type { Report } from "./report.js";

export type TaskStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

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
  objective: string;
  /** Role id from the role system. */
  role?: string;
  /** Agent name from the agent registry. */
  agent?: string;
  context?: TaskContext;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult;
}
