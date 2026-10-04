/**
 * ModelPlanner (§18): uses a chat model ("provider:model-id" through the chat
 * layer) to produce an implementation plan. The model is asked for JSON
 * matching the plan contract; unparseable output degrades gracefully to the
 * heuristic fallback rather than failing the pipeline.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PlannerError } from "../errors/index.js";
import { logger, type Logger } from "../logger/index.js";
import type { Plan, PlanStep } from "../types/plan.js";
import type { ChatMessage } from "../types/chat.js";
import type { ChatFn } from "../pipelines/index.js";
import { buildPlannerContext } from "./context.js";
import { HeuristicPlanner } from "./heuristic.js";
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

const planStepJsonSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    order: z.number().int().optional(),
    targets: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    source_findings: z.array(z.string()).optional(),
  })
  .strict();

const planJsonSchema = z
  .object({
    summary: z.string().min(1),
    steps: z.array(planStepJsonSchema).min(1),
    risks: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();

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
          '{"summary": string, "steps": [{"id": string, "title": string, "description": string, ' +
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
    if (!parsed) {
      return this.degrade(request, "planner model output was not valid plan JSON");
    }

    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      objective: request.objective,
      summary: parsed.summary,
      steps: parsed.steps,
      ...(parsed.risks !== undefined ? { risks: parsed.risks } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      generatedBy: `model:${this.options.model}`,
      model: this.options.model,
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.pipelineRunId !== undefined ? { pipelineRunId: request.pipelineRunId } : {}),
      createdAt: new Date().toISOString(),
    };
    return plan;
  }

  private async degrade(request: PlanRequest, reason: string): Promise<Plan> {
    if (this.options.fallback) {
      this.log.warn(`${reason} — using the heuristic fallback planner.`);
      return this.options.fallback.plan(request);
    }
    throw new PlannerError("PLANNER_FAILED", `Planner failed: ${reason}.`);
  }
}

/** Extracts and validates the plan JSON from arbitrary model output. */
export function parsePlanJson(
  text: string,
): { summary: string; steps: PlanStep[]; risks?: string[]; notes?: string[] } | undefined {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const json: unknown = JSON.parse(unfenced.slice(start, end + 1));
    const parsed = planJsonSchema.safeParse(json);
    if (!parsed.success) return undefined;

    const steps: PlanStep[] = parsed.data.steps.map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      title: step.title,
      description: step.description,
      order: step.order ?? index + 1,
      targets: step.targets,
      acceptanceCriteria: step.acceptance_criteria,
      dependsOn: step.depends_on,
      sourceFindings: step.source_findings,
    }));
    return {
      summary: parsed.data.summary,
      steps: steps.sort((a, b) => a.order - b.order),
      risks: parsed.data.risks,
      notes: parsed.data.notes,
    };
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
