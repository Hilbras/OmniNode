/**
 * Task persistence (§4.1 — execution state). The store is replaceable
 * (§2 — Modular); the default implementation is a local JSON file so
 * OmniNode stays local-first (§25).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export class FileTaskStore implements TaskStore {
  private readonly filePath: string;

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.filePath = `${directory}/tasks.json`;
  }

  async save(task: Task): Promise<void> {
    const tasks = await this.load();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    await this.write(tasks);
  }

  async get(id: string): Promise<Task | undefined> {
    const tasks = await this.load();
    return tasks.find((t) => t.id === id);
  }

  async list(filter: TaskStoreFilter = {}): Promise<Task[]> {
    const tasks = await this.load();
    return tasks
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .filter((task) => (filter.project ? task.project === filter.project : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async load(): Promise<Task[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Task[]) : [];
    } catch {
      return [];
    }
  }

  private async write(tasks: Task[]): Promise<void> {
    // Write to a temp file and rename for an atomic-enough local save.
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}
