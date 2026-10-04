/**
 * Task persistence (§4.1 — execution state). The store is replaceable
 * (§2 — Modular); the default implementation is a local JSON file so
 * OmniNode stays local-first (§25).
 */
import { JsonFileStore } from "../persistence/json-file-store.js";
import type { Task, TaskStatus } from "../types/task.js";

export interface TaskStoreFilter {
  status?: TaskStatus;
  project?: string;
}

export interface TaskStore {
  save(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  list(filter?: TaskStoreFilter): Promise<Task[]>;
}

export class FileTaskStore extends JsonFileStore<Task> implements TaskStore {
  constructor(directory?: string) {
    super({ ...(directory !== undefined ? { directory } : {}), fileName: "tasks.json" });
  }

  save(task: Task): Promise<void> {
    return this.mutate((tasks) => {
      const index = tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) tasks[index] = task;
      else tasks.push(task);
      return [tasks, undefined];
    });
  }

  async get(id: string): Promise<Task | undefined> {
    const tasks = await this.readAll();
    return tasks.find((t) => t.id === id);
  }

  async list(filter: TaskStoreFilter = {}): Promise<Task[]> {
    const tasks = await this.readAll();
    return tasks
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .filter((task) => (filter.project ? task.project === filter.project : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
