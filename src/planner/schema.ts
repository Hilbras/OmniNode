/**
 * Plan validation (roadmap §15, Validation): every generated plan passes
 * schema validation. Invalid plans are rejected with structured issues and
 * — where a fallback is configured — fall back to heuristic planning.
 */
import { z } from "zod";
import type { Plan } from "../types/plan.js";

const planStepSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  order: z.number().int().optional(),
  targets: z.array(z.string()).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  source_findings: z.array(z.string()).optional(),
});

export const planJsonSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().min(1),
  steps: z.array(planStepSchema).min(1),
  risks: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

export interface PlanValidationIssue {
  path: string;
  message: string;
}

export type PlanValidationResult =
  | { valid: true; plan: Plan }
  | { valid: false; issues: PlanValidationIssue[]; reason: string };

/** Validates a plan object (ids/order filled by the caller). */
export function validatePlan(plan: Plan): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const stepIds = new Set<string>();

  for (const [index, step] of plan.steps.entries()) {
    if (stepIds.has(step.id)) {
      issues.push({ path: `steps.${index}.id`, message: `duplicate step id "${step.id}"` });
    }
    stepIds.add(step.id);
    if (!step.title || step.title.trim().length === 0) {
      issues.push({ path: `steps.${index}.title`, message: "title must not be empty" });
    }
    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep) && !plan.steps.some((s) => s.id === dep)) {
        issues.push({ path: `steps.${index}.dependsOn`, message: `unknown step dependency "${dep}"` });
      }
    }
  }

  if (plan.steps.length === 0) {
    issues.push({ path: "steps", message: "a plan needs at least one step" });
  }
  if (!plan.summary || plan.summary.trim().length === 0) {
    issues.push({ path: "summary", message: "summary must not be empty" });
  }

  return issues.length > 0
    ? { valid: false, issues, reason: `plan failed validation (${issues.length} issue(s))` }
    : { valid: true, plan };
}

/** Builds the parser input type for model-produced plan JSON. */
export type PlanJsonInput = z.input<typeof planJsonSchema>;
