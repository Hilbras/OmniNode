/**
 * HeuristicPlanner: a deterministic, dependency-free planner that derives an
 * implementation plan from recommendations and significant findings.
 * Used as the no-model option and as the graceful fallback when a model's
 * output is rejected (§15).
 */
import { randomBytes } from "node:crypto";
import type { Plan, PlanStep } from "../types/plan.js";
import type { Finding, FindingSeverity } from "../types/report.js";
import type { IPlanner, PlanRequest } from "./types.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

interface ContributedFinding {
  finding: Finding;
  agent: string;
}

export class HeuristicPlanner implements IPlanner {
  readonly name = "heuristic";

  async plan(request: PlanRequest): Promise<Plan> {
    const steps: PlanStep[] = [];

    // One step per distinct recommendation (deduped by text).
    const recommendations = dedupe(request.reports.flatMap((r) => r.recommendations));
    for (const text of recommendations) {
      steps.push({
        id: `step-${steps.length + 1}`,
        title: truncate(text, 120),
        order: steps.length + 1,
        ...(steps.length > 0 ? { dependsOn: [`step-${steps.length}`] } : {}),
      });
    }

    // Remediation steps for significant findings, most severe first. Aggregated
    // findings (with consensus/conflicts) take precedence when available.
    const contributed: ContributedFinding[] = request.aggregated
      ? request.aggregated.findings.map((finding) => ({
          finding: {
            id: `agg-${slug(finding.title)}`,
            title: finding.title,
            detail: finding.details[0] ?? finding.title,
            ...(finding.severity ? { severity: finding.severity } : {}),
            ...(finding.recommendations && finding.recommendations.length > 0
              ? { recommendation: finding.recommendations[0] }
              : {}),
          },
          agent: finding.sources.map((s) => s.agent).join("+"),
        }))
      : request.reports.flatMap((report) =>
          report.findings.map((finding) => ({ finding, agent: report.agent })),
        );

    const significant = contributed
      .filter(({ finding }) =>
        finding.severity ? SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high : false,
      )
      .sort(
        (a, b) =>
          SEVERITY_RANK[b.finding.severity ?? "info"] - SEVERITY_RANK[a.finding.severity ?? "info"],
      );
    for (const { finding } of significant) {
      steps.push(remediationStep(finding, steps.length + 1));
    }

    if (steps.length === 0) {
      steps.push({
        id: "step-1",
        title: "Gather additional information",
        description:
          "The research reports contained no actionable recommendations or significant findings. " +
          "Investigate the objective further before planning implementation work.",
        order: 1,
      });
    }

    const risks = significant
      .filter(({ finding }) => finding.severity === "critical")
      .map(({ finding }) => `Critical finding unaddressed until its step completes: ${finding.title}`);
    const conflicts = request.aggregated?.conflicts ?? [];
    if (conflicts.length > 0) {
      risks.push(
        `${conflicts.length} unresolved agent disagreement(s): ${conflicts.map((c) => c.findingTitle).join("; ")}`,
      );
    }

    return {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      objective: request.objective,
      goal: request.aggregated?.title ?? truncate(request.objective, 120),
      summary:
        `Derived from ${request.reports.length} report(s): ` +
        `${recommendations.length} recommendation step(s), ${significant.length} remediation step(s).`,
      steps,
      ...(risks.length > 0 ? { risks } : {}),
      ...(request.constraints !== undefined && request.constraints.length > 0
        ? { constraints: request.constraints }
        : {}),
      generatedBy: "heuristic",
      ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      ...(request.pipelineRunId !== undefined ? { pipelineRunId: request.pipelineRunId } : {}),
      createdAt: new Date().toISOString(),
    };
  }
}

function remediationStep(finding: Finding, order: number): PlanStep {
  return {
    id: `step-${order}`,
    title: `Fix: ${truncate(finding.title, 100)}`,
    description: finding.detail,
    order,
    dependsOn: order > 1 ? [`step-${order - 1}`] : [],
    sourceFindings: [finding.id],
    ...(finding.recommendation ? { recommendation: finding.recommendation } : {}),
  };
}

function dedupe(texts: string[]): string[] {
  return [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 0))];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
