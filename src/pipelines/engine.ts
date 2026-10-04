/**
 * Pipeline engine (§14, §15, §27 Phase 5): validates pipeline definitions,
 * schedules steps over their dependency DAG (implicit sequential chain by
 * default, parallel where the DAG allows), fans research steps out to several
 * agents, hands combined context to plan steps (via a chat model) and to the
 * final execution agent. Every task runs through the TaskEngine, so tasks,
 * results and reports are persisted normally.
 */
import { randomBytes } from "node:crypto";
import type { AgentRegistry } from "../agents/index.js";
import type { AppConfig } from "../config/index.js";
import { PipelineError } from "../errors/index.js";
import { logger, type Logger } from "../logger/index.js";
import type { RoleRegistry } from "../roles/index.js";
import { createProvider } from "../providers/index.js";
import type { RoleDefinition } from "../types/role.js";
import type {
  IPipelineExecutor,
  PipelineDefinition,
  PipelineRun,
  PipelineRunOptions,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepRun,
} from "../types/pipeline.js";
import type { ChatFn } from "../types/chat.js";
// Re-exported for v1 compatibility: ChatFn now lives in the neutral types layer.
export type { ChatFn };
import type { Plan } from "../types/plan.js";
import type { Report } from "../types/report.js";
import type { ReportService } from "../reports/index.js";
import { aggregateReports } from "../reports/aggregate.js";
import type { AuditSink } from "../audit/index.js";
import type { IPlanner } from "../planner/index.js";
import type { PlanStore } from "../planner/store.js";
import { HeuristicPlanner } from "../planner/heuristic.js";
import { ModelPlanner } from "../planner/model.js";
import type { TaskEngine } from "../tasks/index.js";
import type { PipelineRunStore } from "./store.js";

export interface PipelineEngineOptions {
  tasks: TaskEngine;
  agents: AgentRegistry;
  roles: RoleRegistry;
  providers: AppConfig["project"]["providers"];
  store: PipelineRunStore;
  chat?: ChatFn;
  /** Default planner used by plan steps without their own model (§18). */
  planner?: IPlanner;
  /** When present, plans produced by plan steps are persisted. */
  plans?: PlanStore;
  /** When present, pipeline lifecycle events are appended to the audit log (§24). */
  audit?: AuditSink;
  /** When present, finished runs have their reports collected, stored and combined (§16–§17). */
  reports?: ReportService;
  log?: Logger;
}

export interface RunPipelineOptions {
  objective?: string;
  onStep?: (stepRun: PipelineStepRun) => void;
}

interface StepOutcome {
  status: "completed" | "failed" | "partial" | "skipped";
  summary: string;
  /** What this step adds to the combined context (defaults to summary). */
  contextContribution?: string;
  taskIds: string[];
  /** Execution ids of created tasks, for correlation (§6.5). */
  executionIds?: string[];
  /** Step attempt that produced this outcome (1 = first try). */
  attempt?: number;
  planId?: string;
  error?: string;
  reports: Report[];
}

interface StepContext {
  objective: string;
  runId?: string;
  /** Definition id (correlates events with the pipeline, not just the run). */
  pipelineDefId?: string;
  taskId?: string;
  role?: RoleDefinition;
  combinedContext: string;
  reports: Report[];
  pipelineRunId?: string;
}

export type { IPipelineExecutor };

export class PipelineEngine implements IPipelineExecutor {
  private readonly log: Logger;
  /** Runs executing in THIS process — cancellation can terminate them directly. */
  private readonly activeRuns = new Map<
    string,
    { taskIds: Set<string>; cancelTasks: () => Promise<void> }
  >();

  constructor(private readonly options: PipelineEngineOptions) {
    this.log = (options.log ?? logger).child({ component: "pipelines" });
  }

  get store(): PipelineRunStore {
    return this.options.store;
  }

  /**
   * Saves the run while preserving fields that may be set by another process
   * (e.g. a cancellation request) — an in-memory snapshot must never clobber
   * externally requested cancellation (§9.2).
   */
  private async persist(run: PipelineRun): Promise<void> {
    const current = await this.options.store.get(run.id);
    await this.options.store.save({
      ...run,
      ...(current?.cancellationRequested === true
        ? { cancellationRequested: true, cancellationRequestedAt: current.cancellationRequestedAt }
        : {}),
    });
  }

  /** Structural + semantic validation (§27 Phase 5 — pipeline parser). */
  validate(def: PipelineDefinition): void {
    const ids = new Set<string>();
    for (const step of def.steps) {
      if (ids.has(step.id)) {
        throw new PipelineError("PIPELINE_INVALID", `Duplicate step id "${step.id}".`);
      }
      ids.add(step.id);
    }
    for (const step of def.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!ids.has(dep)) {
          throw new PipelineError(
            "PIPELINE_INVALID",
            `Step "${step.id}" depends on unknown step "${dep}".`,
          );
        }
      }
      if ((step.kind === "research") && (step.agents ?? []).length === 0) {
        throw new PipelineError(
          "PIPELINE_INVALID",
          `Research step "${step.id}" needs at least one agent.`,
        );
      }
      if ((step.kind === "execute" || step.kind === "custom") && !step.agent) {
        throw new PipelineError("PIPELINE_INVALID", `Step "${step.id}" (${step.kind}) needs an agent.`);
      }
    }
    this.assertAcyclic(def);
  }

  private assertAcyclic(def: PipelineDefinition): void {
    const deps = this.effectiveDependencies(def);
    const remaining = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const [id, list] of deps) {
      remaining.set(id, list.length);
      for (const d of list) {
        dependents.set(d, [...(dependents.get(d) ?? []), id]);
      }
    }
    const queue = [...deps.keys()].filter((id) => (remaining.get(id) ?? 0) === 0);
    let processed = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      processed += 1;
      for (const next of dependents.get(id) ?? []) {
        const left = (remaining.get(next) ?? 0) - 1;
        remaining.set(next, left);
        if (left === 0) queue.push(next);
      }
    }
    if (processed < deps.size) {
      const stuck = [...deps.keys()].filter((id) => (remaining.get(id) ?? 0) > 0);
      throw new PipelineError(
        "PIPELINE_INVALID",
        `Pipeline "${def.id}" has a dependency cycle involving: ${stuck.join(", ")}.`,
      );
    }
  }

  /**
   * Steps run sequentially in definition order unless they declare explicit
   * dependencies, which enable parallel branches.
   */
  private effectiveDependencies(def: PipelineDefinition): Map<string, string[]> {
    const deps = new Map<string, string[]>();
    def.steps.forEach((step, index) => {
      const explicit = step.dependsOn ?? [];
      deps.set(
        step.id,
        explicit.length > 0 ? explicit : index > 0 ? [def.steps[index - 1]!.id] : [],
      );
    });
    return deps;
  }

  async run(def: PipelineDefinition, options: PipelineRunOptions = {}): Promise<PipelineRun> {
    this.validate(def);

    const objective = (options.objective ?? def.objective ?? "").trim();
    if (objective.length === 0) {
      throw new PipelineError(
        "PIPELINE_INVALID",
        `Pipeline "${def.id}" needs an objective — pass one or set it in the definition.`,
      );
    }
    const role = def.role ? this.options.roles.get(def.role) : undefined;
    if (def.role && !role) {
      throw new PipelineError(
        "PIPELINE_INVALID",
        `Role "${def.role}" (pipeline "${def.id}") is not defined in project.roles.`,
      );
    }
    // Agents referenced by steps must be registered, and plan-step models
    // must resolve to a configured provider — both before anything runs (§9.5).
    for (const step of def.steps) {
      for (const name of [...(step.agents ?? []), ...(step.agent ? [step.agent] : [])]) {
        if (!this.options.agents.get(name)) {
          throw new PipelineError(
            "PIPELINE_INVALID",
            `Step "${step.id}" references unregistered agent "${name}".`,
          );
        }
      }
      if (step.model) {
        const separator = step.model.indexOf(":");
        if (separator <= 0 || separator === step.model.length - 1) {
          throw new PipelineError(
            "PIPELINE_INVALID",
            `Step "${step.id}" has an invalid model reference "${step.model}" — use "provider:model-id".`,
          );
        }
        const providerName = step.model.slice(0, separator);
        if (!this.options.providers.some((p) => p.name === providerName)) {
          throw new PipelineError(
            "PIPELINE_INVALID",
            `Step "${step.id}" uses model "${step.model}" but provider "${providerName}" is not configured.`,
          );
        }
      }
    }

    const now = new Date().toISOString();
    const run: PipelineRun = {
      id: `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      pipelineId: def.id,
      attempt: 1,
      objective,
      status: "running",
      startedAt: now,
      stepRuns: [],
    };
    await this.options.store.save(run);
    const liveTaskIds = new Set<string>();
    this.activeRuns.set(run.id, {
      taskIds: liveTaskIds,
      cancelTasks: async () => {
        for (const taskId of liveTaskIds) {
          await this.options.tasks.cancel(taskId).catch(() => undefined);
        }
      },
    });
    this.log.info(`Running pipeline ${def.id} as ${run.id} (attempt ${run.attempt}).`);
    await this.options.audit?.record({
      at: new Date().toISOString(),
      action: "pipeline.run.started",
      id: run.id,
      pipelineId: def.id,
      detail: { pipeline: def.id, objective },
    });

    const deps = this.effectiveDependencies(def);
    const outcomes = new Map<string, StepOutcome>();
    const pending = new Set(def.steps.map((s) => s.id));
    const contextParts: string[] = [];
    const allReports: Report[] = [];
    let cancelled = false;

    while (pending.size > 0) {
      // §9.2 cancellation check point: stop scheduling, terminate what runs.
      const persisted = await this.options.store.get(run.id);
      if (persisted?.cancellationRequested === true) {
        cancelled = true;
        run.cancellationRequested = true;
        run.cancellationRequestedAt = persisted.cancellationRequestedAt;
        await this.activeRuns.get(run.id)?.cancelTasks();
        for (const step of def.steps.filter((s) => pending.has(s.id))) {
          const stepRun: PipelineStepRun = { stepId: step.id, status: "cancelled" };
          run.stepRuns.push(stepRun);
          options.onStep?.(stepRun);
        }
        pending.clear();
        break;
      }

      const ready = def.steps.filter(
        (step) => pending.has(step.id) && (deps.get(step.id) ?? []).every((d) => outcomes.has(d)),
      );
      if (ready.length === 0) {
        // Cycle — already rejected by validate(), but never hang.
        throw new PipelineError("PIPELINE_FAILED", `Pipeline "${def.id}" scheduling stalled.`);
      }

      const settled = await Promise.all(
        ready.map(async (step): Promise<StepOutcome> => {
          if (!this.shouldRun(step, deps.get(step.id) ?? [], outcomes)) {
            return { status: "skipped", summary: "", taskIds: [], reports: [] };
          }
          const ctx: StepContext = {
            objective,
            ...(role ? { role } : {}),
            combinedContext: contextParts.join("\n\n"),
            reports: [...allReports],
            pipelineRunId: run.id,
            runId: run.id,
            pipelineDefId: def.id,
            taskId: run.id,
          };
          return this.executeStep(step, ctx);
        }),
      );

      ready.forEach((step, index) => {
        const outcome = settled[index]!;
        outcomes.set(step.id, outcome);
        pending.delete(step.id);
        allReports.push(...outcome.reports);
        if (outcome.status !== "skipped" && outcome.summary.length > 0) {
          const contribution = outcome.contextContribution ?? outcome.summary;
          contextParts.push(`## Step "${step.id}" (${step.kind})\n${contribution}`);
        }
        const stepRun: PipelineStepRun = {
          stepId: step.id,
          attempt: outcome.attempt ?? 1,
          ...(outcome.executionIds && outcome.executionIds.length > 0
            ? { executionIds: outcome.executionIds }
            : {}),
          status:
            outcome.status === "skipped"
              ? "cancelled"
              : outcome.status === "failed"
                ? "failed"
                : outcome.status === "partial"
                  ? "partially_completed"
                  : "completed",
          ...(outcome.taskIds.length > 0 ? { taskIds: outcome.taskIds } : {}),
          ...(outcome.planId !== undefined ? { planId: outcome.planId } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        };
        run.stepRuns.push(stepRun);
        options.onStep?.(stepRun);
      });
      run.reports = [...allReports];
      await this.persist(run);
    }

    const allOutcomes = [...outcomes.values()];
    const failed = !cancelled && allOutcomes.some((o) => o.status === "failed");
    const partial = !cancelled && !failed && allOutcomes.some((o) => o.status === "partial");
    const finalStatus: PipelineRunStatus = cancelled
      ? "cancelled"
      : failed
        ? "failed"
        : partial
          ? "partial"
          : "completed";
    const planId = [...outcomes.values()].find((o) => o.planId !== undefined)?.planId;

    // §28 — Result: the outcome of the last completed step with tasks.
    let resultSummary: string | undefined;
    for (let i = def.steps.length - 1; i >= 0; i -= 1) {
      const step = def.steps[i]!;
      const outcome = outcomes.get(step.id);
      if (outcome?.status !== "completed" || outcome.taskIds.length === 0) continue;
      const stepTasks = (
        await Promise.all(outcome.taskIds.map((id) => this.options.tasks.get(id)))
      ).filter((task): task is NonNullable<typeof task> => task !== undefined);
      const summaries = stepTasks
        .map((task) => task.result?.summary)
        .filter((summary): summary is string => summary !== undefined);
      if (summaries.length > 0) resultSummary = summaries.join("\n");
      break;
    }

    // Report system (§16–§17): collect, store and combine reports from the
    // analysis tasks (research/analyze) — execution output is a result, not a report.
    let combinedReportId: string | undefined;
    if (this.options.reports) {
      const taskIds = def.steps
        .filter((step) => step.kind === "research" || step.kind === "analyze")
        .flatMap((step) => outcomes.get(step.id)?.taskIds ?? []);
      const tasks = (
        await Promise.all(taskIds.map((id) => this.options.tasks.get(id)))
      ).filter((task): task is NonNullable<typeof task> => task !== undefined);
      const collected = await this.options.reports.collectFromTasks(tasks);
      await this.options.reports.saveReports(collected);
      const combined = await this.options.reports.generateCombined(collected, {
        objective,
        pipelineRunId: run.id,
        taskIds,
      });
      combinedReportId = combined?.id;
      if (collected.length > 0) {
        run.reports = collected;
      }
    }

    const finishedAt = new Date().toISOString();
    this.activeRuns.delete(run.id);
    const finished: PipelineRun = {
      ...run,
      status: finalStatus,
      finishedAt,
      attempts: [...(run.attempts ?? []), { attempt: run.attempt, startedAt: run.startedAt ?? finishedAt, finishedAt, status: finalStatus }],
      ...(run.reports !== undefined && run.reports.length > 0 ? { reports: run.reports } : {}),
      ...(combinedReportId !== undefined ? { combinedReportId } : {}),
      ...(planId !== undefined ? { planId } : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
    };
    await this.persist(finished);
    this.log.info(`Pipeline ${def.id} finished: ${finalStatus}.`);
    await this.options.audit?.record({
      at: new Date().toISOString(),
      action: cancelled ? "pipeline.run.cancelled" : finalStatus === "failed" ? "pipeline.run.failed" : "pipeline.run.finished",
      id: run.id,
      pipelineId: def.id,
      detail: { pipeline: def.id, status: finalStatus },
    });
    return finished;
  }

  /** First-class cancellation (§9.2): requests cancellation and terminates
   *  tasks that are running in this process immediately. */
  async cancel(runId: string): Promise<void> {
    const run = await this.options.store.get(runId);
    if (!run) {
      throw new PipelineError("PIPELINE_NOT_FOUND", `Pipeline run "${runId}" does not exist.`);
    }
    await this.options.store.save({
      ...run,
      cancellationRequested: true,
      cancellationRequestedAt: new Date().toISOString(),
    });
    const active = this.activeRuns.get(runId);
    if (active) {
      await active.cancelTasks();
    }
  }

  async get(runId: string): Promise<PipelineRun | undefined> {
    return this.options.store.get(runId);
  }

  async listRuns(filter?: { pipelineId?: string }): Promise<PipelineRun[]> {
    return this.options.store.list(filter);
  }

  private shouldRun(
    step: PipelineStep,
    deps: string[],
    outcomes: Map<string, StepOutcome>,
  ): boolean {
    const condition = step.condition ?? "on-success";
    const depStatuses = deps.map((d) => outcomes.get(d)?.status);
    const anyFailed = depStatuses.includes("failed");
    // A partial dependency carries real output, so it does not block.
    const anySkipped = depStatuses.includes("skipped");
    if (condition === "always") return true;
    if (condition === "on-failure") return anyFailed;
    return !anyFailed && !anySkipped;
  }

  private async executeStep(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    const retries = step.retries ?? 0;
    let last: StepOutcome | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        this.log.warn(`Step "${step.id}" failed — retry ${attempt}/${retries}.`);
      }
      last = await this.executeStepOnce(step, ctx);
      if (last.status !== "failed") return { ...last, attempt: attempt + 1 };
    }
    return { ...last!, attempt: retries + 1 };
  }

  /** Registers tasks created for a step as live, so cancellation can terminate them (§9.2). */
  private trackLiveTasks(runId: string | undefined, taskIds: string[]): void {
    if (!runId) return;
    const active = this.activeRuns.get(runId);
    if (!active) return;
    for (const id of taskIds) active.taskIds.add(id);
  }

  private async executeStepOnce(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    switch (step.kind) {
      case "research":
        return this.runFanOut(step, ctx);
      case "collect":
        return { status: "completed", summary: "(collect: outputs gathered from previous steps)", taskIds: [], reports: [] };
      case "analyze":
        if (!step.agent) {
          return { status: "completed", summary: "(analyze: pass-through, no agent assigned)", taskIds: [], reports: [] };
        }
        return this.runSingle(step, ctx, step.agent);
      case "plan":
        return this.runPlan(step, ctx);
      case "execute":
      case "custom":
        return this.runSingle(step, ctx, step.agent!);
    }
  }

  /** Research fan-out: one task per agent, in parallel (§15). */
  private async runFanOut(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    const agentNames = step.agents ?? [];
    const created = await Promise.all(
      agentNames.map((name) =>
        this.options.tasks.create({
          objective: ctx.objective,
          ...(ctx.pipelineRunId !== undefined ? { pipelineId: ctx.pipelineRunId } : {}),
          agent: name,
          ...(ctx.role ? { role: ctx.role.id } : {}),
          ...(ctx.combinedContext.length > 0
            ? { context: { background: ctx.combinedContext } }
            : {}),
        }),
      ),
    );
    this.trackLiveTasks(ctx.runId, created.map((t) => t.id));
    const results = await Promise.all(created.map((task) => this.options.tasks.run(task.id)));
    const executionIds = results.map((r) => r.executions?.at(-1)?.executionId).filter((id): id is string => id !== undefined);

    const completedTasks = results.filter((r) => r.status === "completed");
    const failedTasks = results.filter((r) => r.status !== "completed");
    const lines = results.map((result, index) => {
      const agentName = agentNames[index] ?? "unknown";
      const outcome = result.result?.summary ?? result.result?.error ?? "(no output)";
      return `- ${agentName}: ${outcome}`;
    });
    const reports = results.flatMap((r) => r.result?.reports ?? []);
    const summary = lines.join("\n");

    if (failedTasks.length > 0) {
      const firstError = failedTasks[0]?.result?.error ?? failedTasks[0]?.lastError ?? "unknown outcome";
      const states = failedTasks.map((r) => r.status).join(", ");
      return {
        // Some agents succeeded → the step produced usable but incomplete
        // intelligence: partial, not failed (roadmap §9.3).
        status: completedTasks.length > 0 ? "partial" : "failed",
        summary,
        taskIds: created.map((t) => t.id),
        error: `${failedTasks.length}/${results.length} task(s) incomplete (${states}) — ${firstError}`,
        reports,
      };
    }
    return {
      status: "completed",
      summary,
      taskIds: created.map((t) => t.id),
      ...(executionIds.length > 0 ? { executionIds } : {}),
      reports,
    };
  }

  private async runSingle(
    step: PipelineStep,
    ctx: StepContext,
    agentName: string,
  ): Promise<StepOutcome> {
    const task = await this.options.tasks.create({
      objective: ctx.objective,
      ...(ctx.pipelineRunId !== undefined ? { pipelineId: ctx.pipelineRunId } : {}),
      agent: agentName,
      ...(ctx.role ? { role: ctx.role.id } : {}),
      ...(ctx.combinedContext.length > 0 ? { context: { background: ctx.combinedContext } } : {}),
    });
    this.trackLiveTasks(ctx.runId, [task.id]);
    const result = await this.options.tasks.run(task.id);
    if (result.status !== "completed") {
      return {
        // Unknown/timed_out outcomes are not failures — the work may have
        // happened remotely; the step is incomplete, not broken.
        status: result.status === "unknown" || result.status === "timed_out" ? "partial" : "failed",
        summary: result.result?.summary ?? "",
        taskIds: [task.id],
        error: result.result?.error ?? `task ${task.id} did not complete`,
        reports: result.result?.reports ?? [],
      };
    }
    return {
      status: "completed",
      summary: result.result?.summary ?? "(no output)",
      taskIds: [task.id],
      reports: result.result?.reports ?? [],
    };
  }

  private async runPlan(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    // §15 Planner Input: task, reports, aggregated findings (consensus +
    // conflicts), context, role and step constraints.
    const aggregated = ctx.reports.length > 0 ? aggregateReports(ctx.reports) : undefined;
    const request = {
      objective: ctx.objective,
      reports: ctx.reports,
      ...(aggregated !== undefined ? { aggregated } : {}),
      ...(ctx.combinedContext.length > 0 ? { context: ctx.combinedContext } : {}),
      ...(ctx.role ? { role: ctx.role } : {}),
      ...(step.constraints !== undefined && step.constraints.length > 0
        ? { constraints: step.constraints }
        : {}),
      ...(ctx.pipelineRunId !== undefined ? { pipelineRunId: ctx.pipelineRunId } : {}),
    };

    // Selection order: an explicit step model wins, then the configured
    // default planner, then a pass-through (nothing to plan with).
    let planner: IPlanner;
    if (step.model) {
      planner = new ModelPlanner({
        model: step.model,
        chat: this.getChat(),
        fallback: new HeuristicPlanner(),
        log: this.log,
      });
    } else if (this.options.planner) {
      planner = this.options.planner;
    } else {
      return {
        status: "completed",
        summary: "(plan: no model or planner configured — skipped)",
        taskIds: [],
        reports: [],
      };
    }

    let plan: Plan;
    try {
      plan = await planner.plan(request);
    } catch (error) {
      return {
        status: "failed",
        summary: "",
        taskIds: [],
        error: error instanceof Error ? error.message : String(error),
        reports: [],
      };
    }

    await this.options.plans?.save(plan);
    await this.options.audit?.record({
      at: new Date().toISOString(),
      action: "plan.generated",
      id: plan.id,
      ...(ctx.pipelineDefId !== undefined ? { pipelineId: ctx.pipelineDefId } : {}),
      detail: {
        generatedBy: plan.generatedBy,
        steps: plan.steps.length,
        run: ctx.pipelineRunId,
        taskId: ctx.taskId,
      },
    });
    return {
      status: "completed",
      summary: plan.summary,
      contextContribution: formatPlan(plan),
      taskIds: [],
      planId: plan.id,
      reports: [],
    };
  }

  private getChat(): ChatFn {
    if (this.options.chat) return this.options.chat;
    throw new PipelineError(
      "PIPELINE_FAILED",
      "No chat function available — configure a provider for plan steps.",
    );
  }
}

function formatPlan(plan: Plan): string {
  const lines = [
    `# Implementation Plan (by ${plan.generatedBy})`,
    plan.summary,
    "Steps:",
    ...plan.steps.map((step) => {
      const targets = step.targets && step.targets.length > 0 ? ` [targets: ${step.targets.join(", ")}]` : "";
      return `${step.order}. ${step.title}${targets}`;
    }),
  ];
  if (plan.risks && plan.risks.length > 0) {
    lines.push("Risks:", ...plan.risks.map((risk) => `- ${risk}`));
  }
  return lines.join("\n");
}

/** Default chat function: resolves "provider:model" against the configured providers. */
export interface DefaultChatOptions {
  /** Correlates provider errors in the audit log (§18). */
  audit?: AuditSink;
  env?: Record<string, string | undefined>;
}

export function createDefaultChatFn(
  providers: AppConfig["project"]["providers"],
  options: DefaultChatOptions = {},
): ChatFn {
  return async (modelRef, messages) => {
    const separator = modelRef.indexOf(":");
    if (separator <= 0 || separator === modelRef.length - 1) {
      throw new PipelineError(
        "PIPELINE_INVALID",
        `Invalid model reference "${modelRef}". Use "provider:model-id".`,
      );
    }
    const providerName = modelRef.slice(0, separator);
    const modelId = modelRef.slice(separator + 1);
    const providerConfig = providers.find((p) => p.name === providerName);
    if (!providerConfig) {
      throw new PipelineError(
        "PIPELINE_INVALID",
        `Provider "${providerName}" (model "${modelRef}") is not configured.`,
      );
    }
    const provider = createProvider(providerConfig, {
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    const response = await provider.chat({ model: modelId, messages });
    return response.content;
  };
}
