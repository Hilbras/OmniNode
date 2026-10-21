import type { TaskStatus } from "../types/task.js";

export { FileTaskStore } from "./store.js";
export type { TaskStore, TaskStoreFilter } from "./store.js";
export { TaskEngine } from "./engine.js";
export type { CreateTaskInput, TaskEngineOptions, RunTaskOptions } from "./engine.js";
export { createTaskEngine } from "./engine-factory.js";

/**
 * States from which no further automatic transition happens.
 *
 * Lives in the tasks layer (not the types layer) because it is a runtime
 * value: a value exported through the type-only `src/types` barrel would be
 * emitted into the published `.d.ts` without a matching runtime binding.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "partially_completed",
];
