/** Planner interface and request contract (§18). The planner is replaceable. */
import type { Plan } from "../types/plan.js";
import type { MemoryEntry } from "../types/memory.js";
import type { Report } from "../types/report.js";
import type { RoleDefinition } from "../types/role.js";

export interface PlanRequest {
  objective: string;
  /** Raw reports (already normalized) the plan is based on. */
  reports: Report[];
  /** Combined research context from upstream pipeline steps, if available. */
  context?: string;
  role?: RoleDefinition;
  memory?: MemoryEntry[];
  project?: string;
  taskId?: string;
  pipelineRunId?: string;
}

export interface IPlanner {
  readonly name: string;
  plan(request: PlanRequest): Promise<Plan>;
}
