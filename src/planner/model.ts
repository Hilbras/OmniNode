/**
 * ModelPlanner (§18): uses a chat model ("provider:model-id" through the chat
 * layer) to produce an implementation plan. The model is asked for JSON
 * matching the plan contract; unparseable output degrades gracefully to the
 * heuristic fallback rather than failing the pipeline.
 */
import { randomBytes } from "node:crypto";
import { PlannerError } from "../errors/index.js";
import { planJsonSchema, validatePlan } from "./schema.js";
import { logger, type Logger } from "../logger/index.js";
import type { Plan, PlanStep } from "../types/plan.js";
import type { ChatFn, ChatMessage } from "../types/chat.js";

import { buildPlannerContext } from "./context.js";
import type { IPlanner, PlanRequest } from "./types.js";

export interface ModelPlannerOptions {
  model: string;
  chat: ChatFn;
  /** Extra instruction appended to the system prompt. */
  instruction?: string;
  /** Used when the model output is unparseable (or the call fails, if tolerateErrors). */
  fallback?: IPlanner;
  log?: Logger;
}

export class ModelPlanner implements IPlanner {
  readonly name = "model";
  private readonly log: Logger;

  constructor(private readonly options: ModelPlannerOptions) {
    this.log = (options.log ?? logger).child({ component: "planner", model: options.model });
  }

  async plan(request: PlanRequest): Promise<Plan> {
    const context = buildPlannerContext(request);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are the OmniNode planner. Given the objective and the combined research context, " +
          "produce a final analysis and a prioritized, actionable implementation plan. " +
          "Respond with JSON ONLY (no prose, no code fences) matching exactly this shape: " +
          '{"goal": string, "summary": string, "steps": [{"id": string, "title": string, "description": string, ' +
          '"order": number, "targets": string[], "acceptance_criteria": string[], "source_findings": string[]}], ' +
          '"risks": string[], "notes": string[]}. ' +
          (this.options.instruction ?? ""),
      },
      { role: "user", content: context },
    ];

    let responseText: string;
    try {
      responseText = await this.options.chat(this.options.model, messages);
    } catch (error) {
      return this.degrade(request, `planner model call failed: ${describe(error)}`);
    }

    const parsed = parsePlanJson(responseText);
    if (!parsed.ok) {
      return this.degrade(request, `planner model output rejected: ${parsed.reason}`, parsed.issues);
    }

    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      objective: request.objective,
      goal: parsed.goal,
      summary: parsed.summary,
      steps: parsed.steps,
      ...(parsed.risks !== undefined ? { risks: parsed.risks } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(request.constraints !== undefined && request.constraints.length > 0
        ? { constraints: request.constraints }
        : {}),
      generatedBy: `model:${this.options.model}`,
      model: this.options.model,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.pipelineRunId !== undefined ? { pipelineRunId: request.pipelineRunId } : {}),
      createdAt: new Date().toISOString(),
    };

    // §15 Validation: every generated plan passes schema validation.
    const validation = validatePlan(plan);
    if (!validation.valid) {
      return this.degrade(request, `generated plan rejected: ${validation.reason}`, validation.issues);
    }
    return validation.plan;
  }

  private async degrade(
    request: PlanRequest,
    reason: string,
    issues: Array<{ path: string; message: string }> = [],
  ): Promise<Plan> {
    if (this.options.fallback) {
      this.log.warn(`${reason} — using the heuristic fallback planner.`);
      return this.options.fallback.plan(request);
    }
    // Structured error: the caller sees exactly what was rejected (§15).
    throw new PlannerError("PLAN_INVALID", `Planner failed: ${reason}.`, {
      details: { reason, issues },
    });
  }
}

export type PlanJsonResult =
  | { ok: true; goal: string; summary: string; steps: PlanStep[]; risks?: string[]; notes?: string[] }
  | { ok: false; reason: string; issues: Array<{ path: string; message: string }> };

/** Extracts and validates plan JSON from arbitrary model output (§15). */
export function parsePlanJson(text: string): PlanJsonResult {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, reason: "planner output contained no JSON object", issues: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    return {
      ok: false,
      reason: `planner output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      issues: [],
    };
  }
  const parsed = planJsonSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "planner output did not match the plan schema",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  const steps: PlanStep[] = parsed.data.steps
    .map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      title: step.title,
      description: step.description,
      order: step.order ?? index + 1,
      targets: step.targets,
      acceptanceCriteria: step.acceptance_criteria,
      dependsOn: step.depends_on,
      sourceFindings: step.source_findings,
    }))
    .sort((a, b) => a.order - b.order);
  return {
    ok: true,
    goal: parsed.data.goal,
    summary: parsed.data.summary,
    steps,
    risks: parsed.data.risks,
    notes: parsed.data.notes,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
