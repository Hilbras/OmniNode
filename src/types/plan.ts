/** Plan types: the final implementation plan produced by the planner layer (§18). */

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  order: number;
  /** Files/modules the step touches, if stated. */
  targets?: string[];
  acceptanceCriteria?: string[];
  /** Plan-internal dependencies between steps. */
  dependsOn?: string[];
  /** Finding ids that motivated this step (traceability to reports). */
  sourceFindings?: string[];
}

export interface Plan {
  id: string;
  objective: string;
  /** Explicit goal statement (§15, Planner Output). */
  goal?: string;
  summary: string;
  steps: PlanStep[];
  risks?: string[];
  notes?: string[];
  /** What produced the plan, e.g. "model:my-gateway:chatgpt" or "heuristic". */
  generatedBy: string;
  model?: string;
  taskId?: string;
  pipelineRunId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
