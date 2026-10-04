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
  PipelineDefinition,
  PipelineRun,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepRun,
} from "../types/pipeline.js";
import type { ChatMessage } from "../types/chat.js";
import type { Report } from "../types/report.js";
import type { TaskEngine } from "../tasks/index.js";
import type { PipelineRunStore } from "./store.js";

export type ChatFn = (modelRef: string, messages: ChatMessage[]) => Promise<string>;

export interface PipelineEngineOptions {
  tasks: TaskEngine;
  agents: AgentRegistry;
  roles: RoleRegistry;
  providers: AppConfig["project"]["providers"];
  store: PipelineRunStore;
  chat?: ChatFn;
  log?: Logger;
}

export interface RunPipelineOptions {
  objective?: string;
  onStep?: (stepRun: PipelineStepRun) => void;
}

interface StepOutcome {
  status: "completed" | "failed" | "skipped";
  summary: string;
  /** What this step adds to the combined context (defaults to summary). */
  contextContribution?: string;
  taskIds: string[];
  error?: string;
  reports: Report[];
}

interface StepContext {
  objective: string;
  role?: RoleDefinition;
  combinedContext: string;
}

export class PipelineEngine {
  private readonly log: Logger;

  constructor(private readonly options: PipelineEngineOptions) {
    this.log = (options.log ?? logger).child({ component: "pipelines" });
  }

  get store(): PipelineRunStore {
    return this.options.store;
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

  async run(def: PipelineDefinition, options: RunPipelineOptions = {}): Promise<PipelineRun> {
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
    // Agents referenced by steps must be registered before anything runs.
    for (const step of def.steps) {
      for (const name of [...(step.agents ?? []), ...(step.agent ? [step.agent] : [])]) {
        if (!this.options.agents.get(name)) {
          throw new PipelineError(
            "PIPELINE_INVALID",
            `Step "${step.id}" references unregistered agent "${name}".`,
          );
        }
      }
    }

    const now = new Date().toISOString();
    const run: PipelineRun = {
      id: `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      pipelineId: def.id,
      status: "running",
      startedAt: now,
      stepRuns: [],
    };
    await this.options.store.save(run);
    this.log.info(`Running pipeline ${def.id} as ${run.id}.`);

    const deps = this.effectiveDependencies(def);
    const outcomes = new Map<string, StepOutcome>();
    const pending = new Set(def.steps.map((s) => s.id));
    const contextParts: string[] = [];
    const allReports: Report[] = [];

    while (pending.size > 0) {
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
          status:
            outcome.status === "skipped" ? "cancelled" : outcome.status === "failed" ? "failed" : "completed",
          ...(outcome.taskIds.length > 0 ? { taskIds: outcome.taskIds } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        };
        run.stepRuns.push(stepRun);
        options.onStep?.(stepRun);
      });
      run.reports = [...allReports];
      await this.options.store.save(run);
    }

    const failed = [...outcomes.values()].some((o) => o.status === "failed");
    const finalStatus: PipelineRunStatus = failed ? "failed" : "completed";
    const finished: PipelineRun = {
      ...run,
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      ...(allReports.length > 0 ? { reports: allReports } : {}),
    };
    await this.options.store.save(finished);
    this.log.info(`Pipeline ${def.id} finished: ${finalStatus}.`);
    return finished;
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
      if (last.status !== "failed") return last;
    }
    return last!;
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
          agent: name,
          ...(ctx.role ? { role: ctx.role.id } : {}),
          ...(ctx.combinedContext.length > 0
            ? { context: { background: ctx.combinedContext } }
            : {}),
        }),
      ),
    );
    const results = await Promise.all(created.map((task) => this.options.tasks.run(task.id)));

    const failedTasks = results.filter((r) => r.status !== "completed");
    const lines = results.map((result, index) => {
      const agentName = agentNames[index] ?? "unknown";
      const outcome = result.result?.summary ?? result.result?.error ?? "(no output)";
      return `- ${agentName}: ${outcome}`;
    });
    const reports = results.flatMap((r) => r.result?.reports ?? []);
    const summary = lines.join("\n");

    if (failedTasks.length > 0) {
      const firstError = failedTasks[0]?.result?.error ?? "unknown error";
      return {
        status: "failed",
        summary,
        taskIds: created.map((t) => t.id),
        error: `${failedTasks.length}/${results.length} task(s) failed — ${firstError}`,
        reports,
      };
    }
    return { status: "completed", summary, taskIds: created.map((t) => t.id), reports };
  }

  private async runSingle(
    step: PipelineStep,
    ctx: StepContext,
    agentName: string,
  ): Promise<StepOutcome> {
    const task = await this.options.tasks.create({
      objective: ctx.objective,
      agent: agentName,
      ...(ctx.role ? { role: ctx.role.id } : {}),
      ...(ctx.combinedContext.length > 0 ? { context: { background: ctx.combinedContext } } : {}),
    });
    const result = await this.options.tasks.run(task.id);
    if (result.status !== "completed") {
      return {
        status: "failed",
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
    if (!step.model) {
      // The full planner layer is Phase 8; a plan step without a model passes through.
      return { status: "completed", summary: "(plan: no model configured — skipped)", taskIds: [], reports: [] };
    }
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a planning assistant inside OmniNode. Given the objective and the combined " +
          "research context, produce a prioritized, actionable plan.",
      },
      {
        role: "user",
        content: `# Objective\n${ctx.objective}\n\n${ctx.combinedContext}\n\nProduce the final plan.`,
      },
    ];
    try {
      const planText = await this.getChat()(step.model, messages);
      return {
        status: "completed",
        summary: planText.split("\n", 1)[0] ?? planText,
        contextContribution: planText,
        taskIds: [],
        reports: [],
      };
    } catch (error) {
      return {
        status: "failed",
        summary: "",
        taskIds: [],
        error: error instanceof Error ? error.message : String(error),
        reports: [],
      };
    }
  }

  private getChat(): ChatFn {
    if (this.options.chat) return this.options.chat;
    throw new PipelineError(
      "PIPELINE_FAILED",
      "No chat function available — configure a provider for plan steps.",
    );
  }
}

/** Default chat function: resolves "provider:model" against the configured providers. */
export function createDefaultChatFn(
  providers: AppConfig["project"]["providers"],
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
    const provider = createProvider(providerConfig);
    const response = await provider.chat({ model: modelId, messages });
    return response.content;
  };
}
