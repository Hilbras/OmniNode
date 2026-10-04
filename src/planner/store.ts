/**
 * Plan persistence (§27 Phase 8 — planner result storage). Same
 * replaceable-store pattern as the other local stores.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export class FilePlanStore implements PlanStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.filePath = `${directory}/plans.json`;
  }

  async save(plan: Plan): Promise<void> {
    return this.synchronized(async () => {
      const plans = await this.load();
      const index = plans.findIndex((p) => p.id === plan.id);
      if (index >= 0) plans[index] = plan;
      else plans.push(plan);
      await this.write(plans);
    });
  }

  async get(id: string): Promise<Plan | undefined> {
    return this.synchronized(async () => {
      const plans = await this.load();
      return plans.find((p) => p.id === id);
    });
  }

  async list(filter: PlanFilter = {}): Promise<Plan[]> {
    return this.synchronized(async () => {
      const plans = await this.load();
      return plans
        .filter((plan) => (filter.pipelineRunId ? plan.pipelineRunId === filter.pipelineRunId : true))
        .filter((plan) => (filter.taskId ? plan.taskId === filter.taskId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  private synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<Plan[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Plan[]) : [];
    } catch {
      return [];
    }
  }

  private async write(plans: Plan[]): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(plans, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}
