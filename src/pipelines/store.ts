/**
 * Pipeline run persistence (§27 Phase 5 — pipeline state). Same
 * replaceable-store pattern as the task store, local-first JSON file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PipelineRun, PipelineRunStatus } from "../types/pipeline.js";

export interface PipelineRunFilter {
  pipelineId?: string;
  status?: PipelineRunStatus;
}

export interface PipelineRunStore {
  save(run: PipelineRun): Promise<void>;
  get(id: string): Promise<PipelineRun | undefined>;
  list(filter?: PipelineRunFilter): Promise<PipelineRun[]>;
}

export class FilePipelineRunStore implements PipelineRunStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.filePath = `${directory}/pipelines.json`;
  }

  async save(run: PipelineRun): Promise<void> {
    return this.synchronized(async () => {
      const runs = await this.load();
      const index = runs.findIndex((r) => r.id === run.id);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
      await this.write(runs);
    });
  }

  async get(id: string): Promise<PipelineRun | undefined> {
    return this.synchronized(async () => {
      const runs = await this.load();
      return runs.find((r) => r.id === id);
    });
  }

  async list(filter: PipelineRunFilter = {}): Promise<PipelineRun[]> {
    return this.synchronized(async () => {
      const runs = await this.load();
      return runs
        .filter((run) => (filter.pipelineId ? run.pipelineId === filter.pipelineId : true))
        .filter((run) => (filter.status ? run.status === filter.status : true))
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
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

  private async load(): Promise<PipelineRun[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PipelineRun[]) : [];
    } catch {
      return [];
    }
  }

  private async write(runs: PipelineRun[]): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}
