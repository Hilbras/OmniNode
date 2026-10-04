/**
 * Report aggregation (§17): normalizes formats, groups duplicate and similar
 * findings, preserves source attribution, and produces one CombinedReport.
 * Grouping uses deterministic token-set similarity so results are testable.
 */
import { randomBytes } from "node:crypto";
import type {
  AggregatedFinding,
  AggregatedRecommendation,
  CombinedReport,
  Confidence,
  ConflictPosition,
  Finding,
  FindingSeverity,
  FindingSource,
  Report,
  ReportConflict,
} from "../types/report.js";
import { normalizeEvidence } from "./schema.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface AggregateOptions {
  objective?: string;
  pipelineRunId?: string;
  taskIds?: string[];
  /** Token-set Jaccard similarity above which findings are merged. */
  similarityThreshold?: number;
}

export function aggregateReports(reports: Report[], options: AggregateOptions = {}): CombinedReport {
  const threshold = options.similarityThreshold ?? 0.7;

  const findingGroups: AggregatedFinding[] = [];
  const recommendationGroups: AggregatedRecommendation[] = [];

  for (const report of reports) {
    for (const finding of report.findings) {
      mergeFinding(findingGroups, finding, report, threshold);
    }
    for (const text of report.recommendations) {
      mergeRecommendation(recommendationGroups, text, report, threshold);
    }
  }

  const sources = [...new Set(reports.map((r) => r.agent))].sort();
  const totalRawFindings = reports.reduce((sum, r) => sum + r.findings.length, 0);
  const conflicts = detectConflicts(findingGroups);
  // Agreement = independently reported by 2+ agents with the same severity.
  const agreements = findingGroups.filter(
    (group) =>
      group.sources.length > 1 &&
      group.severity !== undefined &&
      new Set(Object.values(group.severityBySource ?? {})).size === 1,
  );
  const disputed = conflicts.length;
  const summary =
    `${reports.length} report(s) from ${sources.length > 0 ? sources.join(", ") : "no agents"}: ` +
    `${findingGroups.length} unique finding group(s) (${totalRawFindings} raw), ` +
    `${agreements.length} agreement(s), ${disputed} conflict(s), ` +
    `${recommendationGroups.length} recommendation group(s).`;

  return {
    id: `combined-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    title: options.objective !== undefined ? truncate(options.objective, 120) : "Combined report",
    ...(options.objective !== undefined ? { objective: options.objective } : {}),
    ...(options.pipelineRunId !== undefined ? { pipelineRunId: options.pipelineRunId } : {}),
    taskIds: options.taskIds ?? [],
    summary,
    findings: findingGroups.sort((a, b) => rank(b) - rank(a)),
    agreements,
    conflicts,
    recommendations: recommendationGroups,
    sources,
    reportIds: reports.map((r) => r.id),
    createdAt: new Date().toISOString(),
    metadata: {
      agents: sources.length,
      reports: reports.length,
      rawFindings: totalRawFindings,
      findingGroups: findingGroups.length,
      agreements: agreements.length,
      conflicts: conflicts.length,
    },
  };
}

function rankConfidence(confidence: Confidence | undefined): number {
  return confidence ? { low: 1, medium: 2, high: 3 }[confidence] : 0;
}

/**
 * Conflict detection (§14): agents disagreeing about the same finding is a
 * first-class result. Both positions are preserved — OmniNode never silently
 * chooses one.
 */
export function detectConflicts(groups: AggregatedFinding[]): ReportConflict[] {
  const conflicts: ReportConflict[] = [];
  for (const group of groups) {
    if (group.sources.length < 2) continue;

    const severities = new Set(Object.values(group.severityBySource ?? {}));
    if (severities.size > 1) {
      conflicts.push({
        type: "severity",
        findingTitle: group.title,
        positions: group.sources.map((source) => position(source, group)),
        note:
          `Agents disagree on severity (${[...severities].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]).join(", ")}); ` +
          `the highest severity is shown, every position is preserved.`,
      });
    }

    const recommendations = (group.recommendations ?? []).filter((r) => r.length > 0);
    if (recommendations.length > 1) {
      conflicts.push({
        type: "recommendation",
        findingTitle: group.title,
        positions: group.sources.map((source) => position(source, group)),
        note: `Agents proposed ${recommendations.length} different fixes; none was discarded.`,
      });
    }
  }
  return conflicts;
}

function position(
  source: FindingSource,
  group: AggregatedFinding,
): ConflictPosition {
  return {
    agent: source.agent,
    reportId: source.reportId,
    ...(group.severityBySource?.[source.agent] !== undefined
      ? { severity: group.severityBySource[source.agent] }
      : {}),
    ...(group.confidenceBySource?.[source.agent] !== undefined
      ? { confidence: group.confidenceBySource[source.agent] }
      : {}),
    ...(group.recommendations?.[0] !== undefined ? { recommendation: group.recommendations[0] } : {}),
  };
}

function rank(finding: AggregatedFinding): number {
  return finding.severity ? SEVERITY_RANK[finding.severity] : -1;
}

function mergeFinding(groups: AggregatedFinding[], finding: Finding, report: Report, threshold: number): void {
  const source: FindingSource = { agent: report.agent, reportId: report.id };
  const group = groups.find((g) => similar(g.title, finding.title, threshold));
  if (group) {
    group.occurrences += 1;
    group.details.push(finding.detail);
    group.sources.push(source);
    group.evidence.push(...(normalizeEvidence(finding.evidence) ?? []));
    if (finding.severity && (!group.severity || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[group.severity])) {
      group.severity = finding.severity;
    }
    // Confidence preservation (§14): keep the strongest, and record per source.
    if (finding.confidence && rankConfidence(finding.confidence) > rankConfidence(group.confidence)) {
      group.confidence = finding.confidence;
    }
    if (finding.severity) {
      group.severityBySource = { ...group.severityBySource, [report.agent]: finding.severity };
    }
    if (finding.confidence) {
      group.confidenceBySource = { ...group.confidenceBySource, [report.agent]: finding.confidence };
    }
    if (finding.recommendation && !group.recommendations?.includes(finding.recommendation)) {
      group.recommendations = [...(group.recommendations ?? []), finding.recommendation];
    }
    return;
  }
  groups.push({
    title: finding.title,
    details: [finding.detail],
    sources: [source],
    occurrences: 1,
    ...(finding.severity ? { severity: finding.severity } : {}),
    ...(finding.confidence ? { confidence: finding.confidence } : {}),
    ...(finding.severity ? { severityBySource: { [report.agent]: finding.severity } } : {}),
    ...(finding.confidence ? { confidenceBySource: { [report.agent]: finding.confidence } } : {}),
    ...(finding.recommendation ? { recommendations: [finding.recommendation] } : {}),
    evidence: [...(normalizeEvidence(finding.evidence) ?? [])],
  });
}

function mergeRecommendation(
  groups: AggregatedRecommendation[],
  text: string,
  report: Report,
  threshold: number,
): void {
  const source: FindingSource = { agent: report.agent, reportId: report.id };
  const group = groups.find((g) => similar(g.text, text, threshold));
  if (group) {
    group.occurrences += 1;
    group.sources.push(source);
    return;
  }
  groups.push({ text, sources: [source], occurrences: 1 });
}

export function similar(a: string, b: string, threshold: number): boolean {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return intersection / union >= threshold;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
