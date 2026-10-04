/**
 * Pipeline run persistence (§27 Phase 5 — pipeline state). Same
 * replaceable-store pattern as the task store, local-first JSON file.
 */
import { JsonFileStore } from "../persistence/json-file-store.js";
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

export class FilePipelineRunStore extends JsonFileStore<PipelineRun> implements PipelineRunStore {
  constructor(directory?: string) {
    super({ ...(directory !== undefined ? { directory } : {}), fileName: "pipelines.json" });
  }

  save(run: PipelineRun): Promise<void> {
    return this.mutate((runs) => {
      const index = runs.findIndex((r) => r.id === run.id);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
      return [runs, undefined];
    });
  }

  async get(id: string): Promise<PipelineRun | undefined> {
    return (await this.readAll()).find((r) => r.id === id);
  }

  async list(filter: PipelineRunFilter = {}): Promise<PipelineRun[]> {
    return (await this.readAll())
      .filter((run) => (filter.pipelineId ? run.pipelineId === filter.pipelineId : true))
      .filter((run) => (filter.status ? run.status === filter.status : true))
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  }
}
