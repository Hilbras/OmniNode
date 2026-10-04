/**
 * Plan persistence (§27 Phase 8 — planner result storage). Same
 * replaceable-store pattern as the other local stores.
 */
import { JsonFileStore } from "../persistence/json-file-store.js";
import type { Plan } from "../types/plan.js";

export interface PlanFilter {
  pipelineRunId?: string;
  taskId?: string;
}

export interface PlanStore {
  save(plan: Plan): Promise<void>;
  get(id: string): Promise<Plan | undefined>;
  list(filter?: PlanFilter): Promise<Plan[]>;
}

export class FilePlanStore extends JsonFileStore<Plan> implements PlanStore {
  constructor(directory?: string) {
    super({ ...(directory !== undefined ? { directory } : {}), fileName: "plans.json" });
  }

  save(plan: Plan): Promise<void> {
    return this.mutate((plans) => {
      const index = plans.findIndex((p) => p.id === plan.id);
      if (index >= 0) plans[index] = plan;
      else plans.push(plan);
      return [plans, undefined];
    });
  }

  async get(id: string): Promise<Plan | undefined> {
    return (await this.readAll()).find((p) => p.id === id);
  }

  async list(filter: PlanFilter = {}): Promise<Plan[]> {
    return (await this.readAll())
      .filter((plan) => (filter.pipelineRunId ? plan.pipelineRunId === filter.pipelineRunId : true))
      .filter((plan) => (filter.taskId ? plan.taskId === filter.taskId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
