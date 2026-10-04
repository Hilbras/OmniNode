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
  Finding,
  FindingSeverity,
  FindingSource,
  Report,
} from "../types/report.js";

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
  const summary =
    `${reports.length} report(s) from ${sources.length > 0 ? sources.join(", ") : "no agents"}: ` +
    `${findingGroups.length} unique finding group(s) (${totalRawFindings} raw), ` +
    `${recommendationGroups.length} recommendation group(s).`;

  return {
    id: `combined-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    title: options.objective !== undefined ? truncate(options.objective, 120) : "Combined report",
    ...(options.objective !== undefined ? { objective: options.objective } : {}),
    ...(options.pipelineRunId !== undefined ? { pipelineRunId: options.pipelineRunId } : {}),
    taskIds: options.taskIds ?? [],
    summary,
    findings: findingGroups.sort((a, b) => rank(b) - rank(a)),
    recommendations: recommendationGroups,
    sources,
    reportIds: reports.map((r) => r.id),
    createdAt: new Date().toISOString(),
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
    group.evidence.push(...(finding.evidence ?? []));
    if (finding.severity && (!group.severity || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[group.severity])) {
      group.severity = finding.severity;
    }
    return;
  }
  groups.push({
    title: finding.title,
    details: [finding.detail],
    sources: [source],
    occurrences: 1,
    ...(finding.severity ? { severity: finding.severity } : {}),
    evidence: [...(finding.evidence ?? [])],
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
