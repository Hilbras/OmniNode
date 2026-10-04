/**
 * Task engine (§13, §27 Phase 4): owns the task lifecycle — create, queue,
 * run, cancel — validates role/agent assignment against the registries and
 * persists every transition through the task store.
 */
import { randomBytes } from "node:crypto";
import type { AgentRegistry } from "../agents/index.js";
import type { RoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { TaskError } from "../errors/index.js";
import type { MemoryService } from "../memory/index.js";
import type { Task, TaskContext, TaskResult, TaskStatus } from "../types/task.js";
import type { TaskStore, TaskStoreFilter } from "./store.js";

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ["queued", "running", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  waiting: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface CreateTaskInput {
  objective: string;
  project?: string;
  role?: string;
  agent?: string;
  context?: TaskContext;
}

export interface TaskEngineOptions {
  agents: AgentRegistry;
  roles: RoleRegistry;
  store: TaskStore;
  /** When present, tasks gather relevant memory before running and record outcomes after (§20). */
  memory?: MemoryService;
  log?: Logger;
}

export class TaskEngine {
  private readonly log: Logger;

  constructor(private readonly options: TaskEngineOptions) {
    this.log = (options.log ?? logger).child({ component: "tasks" });
  }

  get store(): TaskStore {
    return this.options.store;
  }

  async create(input: CreateTaskInput): Promise<Task> {
    if (!input.objective || input.objective.trim().length === 0) {
      throw new TaskError("TASK_INVALID", "Task objective must not be empty.");
    }
    if (input.role && !this.options.roles.get(input.role)) {
      throw new TaskError("TASK_INVALID", 
        `Role "${input.role}" is not defined. Add it under project.roles in omninode.yaml.`,
      );
    }
    if (input.agent && !this.options.agents.get(input.agent)) {
      throw new TaskError("TASK_INVALID", 
        `Agent "${input.agent}" is not registered. Add it with \`omninode agent add\`.`,
      );
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: generateTaskId(),
      objective: input.objective.trim(),
      status: "created",
      createdAt: now,
      updatedAt: now,
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    await this.options.store.save(task);
    this.log.info(`Created task ${task.id}.`);
    return task;
  }

  async queue(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    return this.transition(task, "queued");
  }

  /** Runs the task through its assigned agent and records the result. */
  async run(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    if (task.status !== "created" && task.status !== "queued") {
      throw new TaskError("TASK_INVALID", `Task ${id} is "${task.status}" and cannot be run.`);
    }
    if (!task.agent) {
      throw new TaskError("TASK_INVALID", `Task ${id} has no agent assigned. Re-create it with --agent.`);
    }
    const agent = this.options.agents.get(task.agent);
    if (!agent) {
      throw new TaskError("TASK_INVALID", `Agent "${task.agent}" is not registered anymore.`);
    }
    const role = task.role ? this.options.roles.get(task.role) : undefined;

    const running = await this.transition(task, "running");
    this.log.info(`Running task ${task.id} on agent "${task.agent}".`);

    // §20: relevant memory is gathered before the agent receives context.
    let background = running.context?.background;
    if (this.options.memory) {
      const memoryContext = await this.options.memory.gatherContext({
        objective: running.objective,
        ...(running.role ? { role: running.role } : {}),
        ...(running.project ? { project: running.project } : {}),
      });
      if (memoryContext.length > 0) {
        background = [memoryContext, background].filter((part) => part && part.length > 0).join("\n\n");
      }
    }

    let output;
    try {
      output = await agent.run({
        taskId: running.id,
        objective: running.objective,
        ...(role ? { role } : {}),
        ...(background !== undefined ? { context: background } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Task ${task.id} failed: ${message}`);
      return this.transition(running, "failed", {
        result: { error: message, finishedAt: new Date().toISOString() },
      });
    }

    const result: TaskResult = {
      ...(output.summary !== undefined ? { summary: output.summary } : {}),
      ...(output.reports !== undefined && output.reports.length > 0 ? { reports: output.reports } : {}),
      // Keep the verbatim output (bounded) for report extraction and audit.
      ...(output.rawOutput !== undefined && output.rawOutput.length > 0
        ? { rawOutput: output.rawOutput.slice(0, 10_000) }
        : {}),
      ...(output.error !== undefined ? { error: output.error } : {}),
      finishedAt: new Date().toISOString(),
    };
    const finalStatus: TaskStatus = output.status === "completed" ? "completed" : "failed";
    const finished = await this.transition(running, finalStatus, { result });
    this.log.info(`Task ${task.id} finished: ${finalStatus}.`);
    // §20: the outcome is written back to memory — best-effort, never fatal.
    if (this.options.memory) {
      await this.options.memory.recordTaskOutcome(finished);
    }
    return finished;
  }

  async cancel(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    if (!ALLOWED_TRANSITIONS[task.status].includes("cancelled")) {
      throw new TaskError("TASK_INVALID", `Task ${id} is "${task.status}" and cannot be cancelled.`);
    }
    if (task.agent) {
      const agent = this.options.agents.get(task.agent);
      await agent?.cancel?.(task.id);
    }
    return this.transition(task, "cancelled");
  }

  /** Error recovery (§27 Phase 9): reset a failed/cancelled task so it can run again. */
  async retry(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new TaskError(
        "TASK_INVALID",
        `Only failed or cancelled tasks can be retried — task ${id} is "${task.status}".`,
      );
    }
    const { result: _discarded, ...rest } = task;
    const reset: Task = {
      ...rest,
      status: "created",
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.save(reset);
    this.log.info(`Task ${id} reset for retry.`);
    return reset;
  }

  async get(id: string): Promise<Task | undefined> {
    return this.options.store.get(id);
  }

  async list(filter?: TaskStoreFilter): Promise<Task[]> {
    return this.options.store.list(filter);
  }

  private async mustGet(id: string): Promise<Task> {
    const task = await this.options.store.get(id);
    if (!task) {
      throw new TaskError("TASK_NOT_FOUND", `Task "${id}" does not exist in this project's task store.`);
    }
    return task;
  }

  private async transition(
    task: Task,
    to: TaskStatus,
    extra: { result?: TaskResult } = {},
  ): Promise<Task> {
    const allowed = ALLOWED_TRANSITIONS[task.status] ?? [];
    if (!allowed.includes(to)) {
      throw new TaskError("TASK_INVALID", `Task ${task.id} cannot move from "${task.status}" to "${to}".`);
    }
    const updated: Task = {
      ...task,
      status: to,
      updatedAt: new Date().toISOString(),
      ...(extra.result !== undefined
        ? { result: { ...task.result, ...extra.result } }
        : {}),
    };
    await this.options.store.save(updated);
    return updated;
  }
}

function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
