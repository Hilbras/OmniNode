/**
 * Report normalization (§17): turns an agent's text output into a structured
 * Report by extracting findings, recommendations and evidence from
 * markdown-style sections. Deterministic heuristics; AI-assisted extraction
 * can layer on top later via the planner.
 */
import type { Finding, FindingSeverity, Report } from "../types/report.js";

export interface ExtractionMeta {
  taskId: string;
  agent: string;
  model?: string;
}

const BULLET = /^(?:[-*•]|\d+[.)])\s+(.*)$/;

interface Section {
  heading: string;
  bullets: string[];
}

function parseSections(raw: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", bullets: [] };
  for (const line of raw.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      if (current.heading.length > 0 || current.bullets.length > 0) {
        sections.push(current);
      }
      current = { heading: heading[2]?.toLowerCase() ?? "", bullets: [] };
      continue;
    }
    const bullet = BULLET.exec(line.trim());
    if (bullet && current.heading.length > 0) {
      current.bullets.push(bullet[1]?.trim() ?? "");
    }
  }
  if (current.heading.length > 0 || current.bullets.length > 0) {
    sections.push(current);
  }
  return sections;
}

function collectBullets(sections: Section[], patterns: RegExp[]): string[] {
  const matches = sections.filter((section) => patterns.some((p) => p.test(section.heading)));
  return matches.flatMap((section) => section.bullets).filter((b) => b.length > 0);
}

function guessSeverity(text: string): FindingSeverity | undefined {
  if (/critical|severe/i.test(text)) return "critical";
  if (/\bhigh\b|major/i.test(text)) return "high";
  if (/medium|moderate/i.test(text)) return "medium";
  if (/\blow\b|minor/i.test(text)) return "low";
  return undefined;
}

export function extractReportFromText(raw: string, meta: ExtractionMeta): Report {
  const trimmed = raw.trim();
  const nonEmpty = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Prefer a prose line over markdown headings/bullets for the summary.
  const proseLine =
    nonEmpty.find((line) => !line.startsWith("#") && !BULLET.test(line)) ?? nonEmpty[0] ?? "";
  const cleaned = proseLine.replace(/^#{1,6}\s+/, "").replace(BULLET, "$1");
  const summary = cleaned.length > 0 ? truncate(cleaned, 200) : "(no output)";

  const sections = parseSections(trimmed);
  const findingTexts = collectBullets(sections, [/finding/, /issue/, /problem/, /vulnerab/]);
  const recommendationTexts = collectBullets(sections, [/recommend/, /suggestion/, /next step/, /action/]);
  const evidenceTexts = collectBullets(sections, [/evidence/, /proof/, /log/]);

  const findings: Finding[] = findingTexts.map((text, index) => ({
    id: `${meta.taskId}-f-${index + 1}`,
    title: truncate(text, 120),
    detail: text,
    description: text,
    severity: guessSeverity(text),
  }));

  return {
    id: `${meta.taskId}-report`,
    taskId: meta.taskId,
    agent: meta.agent,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    summary,
    findings,
    recommendations: recommendationTexts.map((t) => truncate(t, 200)),
    ...(evidenceTexts.length > 0
      ? { evidence: evidenceTexts.map((excerpt) => ({ kind: "observation" as const, excerpt })) }
      : {}),
    metadata: evidenceTexts.length > 0 ? { evidenceCount: evidenceTexts.length } : undefined,
    createdAt: new Date().toISOString(),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
