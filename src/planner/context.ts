/**
 * Planner context builder (§15, Planner Input): assembles the original task,
 * project context, agent reports, aggregated findings, relevant memory and
 * constraints into one structured input, in that order.
 */
import type { PlanRequest } from "./types.js";
import type { Report } from "../types/report.js";

export function buildPlannerContext(request: PlanRequest): string {
  const parts: string[] = [`# Task\n${request.objective}`];

  if (request.projectContext) {
    parts.push(`# Project context\n${request.projectContext}`);
  }

  if (request.role) {
    const roleLines = [`# Role\n${request.role.name} (${request.role.id})`];
    if (request.role.responsibilities.length > 0) {
      roleLines.push("Responsibilities:", ...request.role.responsibilities.map((r) => `- ${r}`));
    }
    if (request.role.expectedOutputs.length > 0) {
      roleLines.push("Expected outputs:", ...request.role.expectedOutputs.map((o) => `- ${o}`));
    }
    parts.push(roleLines.join("\n"));
  }

  if (request.reports.length > 0) {
    const agents = [...new Set(request.reports.map((r) => r.agent))].join(", ");
    const findingLines = request.reports.flatMap((report: Report) =>
      report.findings.map(
        (finding) =>
          `- [${finding.severity ?? "info"}] ${finding.title} (source: ${report.agent}, finding: ${finding.id})` +
          (finding.detail ? ` — ${finding.detail}` : ""),
      ),
    );
    parts.push(
      `# Agent reports (${request.reports.length} by ${agents})\n` +
        (findingLines.length > 0 ? findingLines.join("\n") : "(no findings reported)"),
    );

    const recommendationLines = request.reports.flatMap((report) =>
      report.recommendations.map((text) => `- ${text} (source: ${report.agent})`),
    );
    if (recommendationLines.length > 0) {
      parts.push(`# Recommendations\n${recommendationLines.join("\n")}`);
    }
  }

  if (request.aggregated) {
    const aggregatedLines = [
      `- findings: ${request.aggregated.findings.length} (agreements: ${request.aggregated.agreements.length}, conflicts: ${request.aggregated.conflicts.length})`,
      ...request.aggregated.findings.map(
        (finding) =>
          `- [${finding.severity ?? "info"}] ${finding.title} (x${finding.occurrences})`,
      ),
      // Conflicts stay visible to the planner — it must plan around disagreement.
      ...request.aggregated.conflicts.map(
        (conflict) => `- CONFLICT (${conflict.type}) on "${conflict.findingTitle}": ${conflict.note}`,
      ),
    ];
    parts.push(`# Aggregated findings\n${aggregatedLines.join("\n")}`);
  }

  if (request.memory && request.memory.length > 0) {
    parts.push(
      `# Relevant memory\n` +
        request.memory.map((entry) => `- [${entry.scope}] ${entry.content}`).join("\n"),
    );
  }

  if (request.constraints && request.constraints.length > 0) {
    parts.push(`# Constraints\n${request.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (request.context) {
    parts.push(`# Research context\n${request.context}`);
  }

  return parts.join("\n\n");
}
