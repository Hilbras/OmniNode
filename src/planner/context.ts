/**
 * Planner context builder (§18): assembles everything the planner needs —
 * the objective, the combined findings from the AI reports (with source
 * attribution), relevant memory and the role definition — into one
 * structured text.
 */
import type { PlanRequest } from "./types.js";
import type { Report } from "../types/report.js";

export function buildPlannerContext(request: PlanRequest): string {
  const parts: string[] = [`# Objective\n${request.objective}`];

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
      `# Findings (${request.reports.length} report(s) by ${agents})\n` +
        (findingLines.length > 0 ? findingLines.join("\n") : "(no findings reported)"),
    );

    const recommendationLines = request.reports.flatMap((report) =>
      report.recommendations.map((text) => `- ${text} (source: ${report.agent})`),
    );
    if (recommendationLines.length > 0) {
      parts.push(`# Recommendations\n${recommendationLines.join("\n")}`);
    }

    const summaryLines = request.reports.map((report) => `- [${report.agent}] ${report.summary}`);
    parts.push(`# Report summaries\n${summaryLines.join("\n")}`);
  }

  if (request.memory && request.memory.length > 0) {
    parts.push(
      `# Relevant memory\n` +
        request.memory.map((entry) => `- [${entry.scope}] ${entry.content}`).join("\n"),
    );
  }

  if (request.context && request.context.length > 0) {
    parts.push(`# Research context\n${request.context}`);
  }

  return parts.join("\n\n");
}
