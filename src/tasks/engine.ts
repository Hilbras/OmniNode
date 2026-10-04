/**
 * Task engine (§13, §27 Phase 4): owns the task lifecycle — create, queue,
 * run, cancel — validates role/agent assignment against the registries and
 * persists every transition through the task store.
 */
import { randomBytes } from "node:crypto";
import type { AgentRegistry } from "../agents/index.js";
import type { RoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { AgentError, TaskError } from "../errors/index.js";
import type { AuditAction, AuditSink } from "../audit/index.js";
import type { MemoryService } from "../memory/index.js";
import type {
  ExecutionRecord,
  Task,
  TaskContext,
  TaskResult,
  TaskStatus,
} from "../types/task.js";
import type { TaskStore, TaskStoreFilter } from "./store.js";

/**
 * Strict state machine (roadmap §6.2). Invalid transitions are rejected —
 * engines never mutate state directly.
 *
 *   created ──▶ queued ──▶ running ──┬─▶ completed
 *      │           │         │        ├─▶ failed
 *      │           │         │        ├─▶ timed_out   (no side effects possible)
 *      └───────────┴─────────┴────────┼─▶ unknown      (outcome unprovable — e.g. killed after dispatch)
 *                                       ├─▶ cancelled
 *                                       └─▶ partially_completed (fan-out where some units succeeded)
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ["queued", "running", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "timed_out", "unknown", "cancelled", "partially_completed"],
  waiting: ["running", "cancelled"],
  completed: [],
  // failed → running is the only re-entry: bounded automatic retry (§6.4).
  failed: ["running"],
  timed_out: [],
  cancelled: [],
  unknown: [],
  partially_completed: [],
};

/**
 * Error codes safe to retry automatically: a transient agent crash before any
 * report was produced. Timeouts/unknown outcomes are NEVER auto-retried
 * because the agent may already have performed side effects (roadmap §6.4).
 */
const RETRYABLE_ERROR_CODES: readonly string[] = ["AGENT_FAILED"];
const EXECUTION_HISTORY_LIMIT = 10;

export interface CreateTaskInput {
  objective: string;
  project?: string;
  pipelineId?: string;
  role?: string;
  agent?: string;
  context?: TaskContext;
}

export interface RunTaskOptions {
  /** Total attempts (1 = no automatic retry). Retries apply to retryable errors only. */
  maxAttempts?: number;
  /** Linear backoff base in ms: waits backoffMs × attempt between attempts. */
  retryBackoffMs?: number;
}

export interface TaskEngineOptions {
  agents: AgentRegistry;
  roles: RoleRegistry;
  store: TaskStore;
  /** When present, tasks gather relevant memory before running and record outcomes after (§20). */
  memory?: MemoryService;
  /** When present, task lifecycle transitions are appended to the audit log (§24). */
  audit?: AuditSink;
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
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    await this.options.store.save(task);
    this.log.info(`Created task ${task.id}.`);
    await this.audit("task.created", task, { objective: task.objective });
    return task;
  }

  async queue(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    return this.transition(task, "queued");
  }

  /** Runs the task through its assigned agent and records the result.
   *  `maxAttempts` enables bounded automatic retries of *retryable* errors
   *  with linear backoff; unknown/timed_out outcomes are never auto-retried. */
  async run(id: string, options: RunTaskOptions = {}): Promise<Task> {
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

    this.log.info(`Running task ${task.id} on agent "${task.agent}".`);

    // §20: relevant memory is gathered before the agent receives context.
    let background = task.context?.background;
    if (this.options.memory) {
      const memoryContext = await this.options.memory.gatherContext({
        objective: task.objective,
        ...(task.role ? { role: task.role } : {}),
        ...(task.project ? { project: task.project } : {}),
      });
      if (memoryContext.length > 0) {
        background = [memoryContext, background].filter((part) => part && part.length > 0).join("\n\n");
      }
    }

    const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    const backoffMs = options.retryBackoffMs ?? 0;

    let current = task;
    for (let i = 0; i < maxAttempts; i += 1) {
      // Attempt numbers are cumulative for the task (roadmap §6.5).
      const attempt = current.attempt + 1;
      const executionId = `exec-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const startedAt = new Date().toISOString();
      current = await this.transition(current, "running", { attempt });

      await this.options.audit?.record({
        at: startedAt,
        action: "agent.started",
        id: current.id,
        taskId: current.id,
        ...(current.pipelineId !== undefined ? { pipelineId: current.pipelineId } : {}),
        agentId: task.agent,
        executionId,
        detail: { attempt },
      });

      let output;
      let thrown: unknown;
      try {
        output = await agent.run({
          taskId: current.id,
          objective: current.objective,
          executionId,
          ...(current.pipelineId !== undefined ? { pipelineId: current.pipelineId } : {}),
          ...(role ? { role } : {}),
          ...(background !== undefined ? { context: background } : {}),
        });
      } catch (error) {
        thrown = error;
      }

      const finishedAt = new Date().toISOString();
      await this.options.audit?.record({
        at: finishedAt,
        action: "agent.completed",
        id: current.id,
        taskId: current.id,
        ...(current.pipelineId !== undefined ? { pipelineId: current.pipelineId } : {}),
        agentId: task.agent,
        executionId,
        detail: { attempt, outcome: thrown !== undefined || output === undefined ? "threw" : "returned" },
      });
      if (thrown !== undefined || output === undefined) {
        const outcome = classifyThrown(thrown);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        const retryable =
          outcome === "failed" &&
          RETRYABLE_ERROR_CODES.includes(errorCode(thrown)) &&
          i < maxAttempts - 1;
        current = await this.transition(current, outcome, {
          attempt,
          lastError: message,
          execution: {
            executionId,
            attempt,
            startedAt,
            finishedAt,
            outcome,
            error: message,
          },
        });
        this.log.warn(`Task ${current.id} attempt ${attempt} → ${outcome}: ${message}`);
        if (retryable) {
          if (backoffMs > 0) await sleep(backoffMs * attempt);
          continue;
        }
        if (this.options.memory) await this.options.memory.recordTaskOutcome(current);
        return current;
      }

      // The task may have been cancelled while the agent was finishing —
      // respect the terminal state instead of forcing a completed transition.
      const currentState = await this.options.store.get(current.id);
      if (currentState?.status === "cancelled") {
        current = currentState;
        break;
      }

      const result: TaskResult = {
        ...(output.summary !== undefined ? { summary: output.summary } : {}),
        ...(output.reports !== undefined && output.reports.length > 0 ? { reports: output.reports } : {}),
        // Keep the verbatim output (bounded) for report extraction and audit.
        ...(output.rawOutput !== undefined && output.rawOutput.length > 0
          ? { rawOutput: output.rawOutput.slice(0, 10_000) }
          : {}),
        ...(output.error !== undefined ? { error: output.error } : {}),
        finishedAt,
      };
      const finalStatus: TaskStatus = output.status === "completed" ? "completed" : "failed";
      current = await this.transition(current, finalStatus, {
        attempt,
        result,
        execution: { executionId, attempt, startedAt, finishedAt, outcome: finalStatus },
      });
      this.log.info(`Task ${current.id} finished: ${finalStatus}.`);
      break;
    }

    // §20: the outcome is written back to memory — best-effort, never fatal.
    if (this.options.memory) {
      await this.options.memory.recordTaskOutcome(current);
    }
    return current;
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

  /** Error recovery: reset a failed/cancelled/unknown/timed_out task so it can run again. */
  async retry(id: string): Promise<Task> {
    const task = await this.mustGet(id);
    const retryableStates: TaskStatus[] = ["failed", "cancelled", "unknown", "timed_out"];
    if (!retryableStates.includes(task.status)) {
      throw new TaskError(
        "TASK_INVALID",
        `Only failed, timed out, unknown or cancelled tasks can be retried — task ${id} is "${task.status}".`,
      );
    }
    const { result: _discarded, ...rest } = task;
    const reset: Task = {
      ...rest,
      status: "created",
      updatedAt: new Date().toISOString(),
    };
    await this.options.store.save(reset);
    await this.audit("task.retry", reset, { from: task.status });
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
    extra: { result?: TaskResult; attempt?: number; lastError?: string; execution?: ExecutionRecord } = {},
  ): Promise<Task> {
    const allowed = ALLOWED_TRANSITIONS[task.status] ?? [];
    if (!allowed.includes(to)) {
      throw new TaskError("TASK_INVALID", `Task ${task.id} cannot move from "${task.status}" to "${to}".`);
    }
    const executions = extra.execution
      ? [...(task.executions ?? []), extra.execution].slice(-EXECUTION_HISTORY_LIMIT)
      : task.executions;
    const updated: Task = {
      ...task,
      status: to,
      updatedAt: new Date().toISOString(),
      ...(extra.attempt !== undefined ? { attempt: extra.attempt } : {}),
      ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
      ...(executions !== undefined ? { executions } : {}),
      ...(extra.result !== undefined
        ? { result: { ...task.result, ...extra.result } }
        : {}),
    };
    await this.options.store.save(updated);
    await this.audit(`task.${to === "queued" ? "queued" : to}` as AuditAction, updated, {
      from: task.status,
    });
    return updated;
  }

  private async audit(
    action: AuditAction,
    task: Task,
    detail?: Record<string, unknown>,
    executionId?: string,
  ): Promise<void> {
    // Correlation (§18): every event carries task/pipeline/agent/execution ids.
    await this.options.audit?.record({
      at: new Date().toISOString(),
      action,
      id: task.id,
      taskId: task.id,
      ...(task.project !== undefined ? { project: task.project } : {}),
      ...(task.pipelineId !== undefined ? { pipelineId: task.pipelineId } : {}),
      ...(task.agent !== undefined ? { agentId: task.agent } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function errorCode(error: unknown): string {
  return (error as { code?: string } | undefined)?.code ?? "";
}

/**
 * Classifies a thrown adapter error into a terminal state.
 *
 * §6.3: a timeout is NOT assumed to be a failure. If the operation was
 * dispatched, the remote side may have completed it, so the outcome is
 * `unknown`. Only a timeout provably raised *before* dispatch becomes
 * `timed_out`.
 */
function classifyThrown(error: unknown): "failed" | "timed_out" | "unknown" {
  if (error instanceof AgentError && error.code === "AGENT_TIMEOUT") {
    const dispatched = (error.details as { dispatched?: unknown } | undefined)?.dispatched;
    return dispatched === false ? "timed_out" : "unknown";
  }
  return "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
