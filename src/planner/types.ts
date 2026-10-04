/** Planner interface and request contract (§18). The planner is replaceable. */
import type { Plan } from "../types/plan.js";
import type { MemoryEntry } from "../types/memory.js";
import type { CombinedReport, Report } from "../types/report.js";
import type { RoleDefinition } from "../types/role.js";

export interface PlanRequest {
  /** The original task (§15, Planner Input). */
  objective: string;
  /** Project context (repository/workspace background, role-derived context…). */
  projectContext?: string;
  /** Agent reports the plan is based on. */
  reports: Report[];
  /** Aggregated findings (combined report) — consensus and conflicts made explicit. */
  aggregated?: CombinedReport;
  /** Combined research context from upstream pipeline steps, if available. */
  context?: string;
  role?: RoleDefinition;
  memory?: MemoryEntry[];
  /** Constraints the plan must respect. */
  constraints?: string[];
  project?: string;
  taskId?: string;
  pipelineRunId?: string;
}

export interface IPlanner {
  readonly name: string;
  plan(request: PlanRequest): Promise<Plan>;
}
