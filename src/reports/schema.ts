/**
 * Report validation and normalization (roadmap §13, Report Validation).
 *
 * Reports are machine-readable objects: they are schema-validated before they
 * can enter aggregation, and legacy string evidence / `detail` fields are
 * normalized into the v2 shape on the way in.
 */
import { z } from "zod";
import type { Confidence, Evidence, EvidenceInput, Finding, Report } from "../types/report.js";

const evidenceSchema = z.union([
  z.string().transform((excerpt): Evidence => ({ kind: "observation", excerpt })),
  z.object({
    kind: z.enum(["file", "line", "url", "command", "observation", "artifact"]),
    ref: z.string().optional(),
    line: z.number().int().optional(),
    excerpt: z.string().optional(),
    agent: z.string().optional(),
  }),
]);

const findingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().default(""),
  description: z.string().optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  evidence: z.array(evidenceSchema).optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.object({ agent: z.string().optional(), reportId: z.string().optional(), pipelineRunId: z.string().optional() }).optional(),
  recommendation: z.string().optional(),
});

const artifactSchema = z.object({
  kind: z.enum(["file", "patch", "log", "screenshot", "document", "data"]),
  ref: z.string().min(1),
  description: z.string().optional(),
  mediaType: z.string().optional(),
  bytes: z.number().int().optional(),
});

const reportSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  agent: z.string().min(1),
  agentId: z.string().optional(),
  pipelineRunId: z.string().optional(),
  model: z.string().optional(),
  summary: z.string(),
  findings: z.array(findingSchema),
  recommendations: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  evidence: z.array(evidenceSchema).optional(),
  artifacts: z.array(artifactSchema).optional(),
  createdAt: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export interface ReportValidationIssue {
  path: string;
  message: string;
}

export type ReportValidationResult =
  | { valid: true; report: Report }
  | { valid: false; issues: ReportValidationIssue[]; reason: string };

/** Validates (and normalizes) a report; malformed reports are rejected. */
export function validateReport(value: unknown): ReportValidationResult {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    return {
      valid: false,
      issues,
      reason: `report failed schema validation (${issues.length} issue(s))`,
    };
  }
  const report = parsed.data as Report;
  // Cross-field normalization: description mirrors detail, source carries provenance.
  report.findings = report.findings.map((finding) => ({
    ...finding,
    description: finding.description ?? finding.detail,
    ...(finding.source === undefined
      ? { source: { agent: report.agent, reportId: report.id, ...(report.pipelineRunId !== undefined ? { pipelineRunId: report.pipelineRunId } : {}) } }
      : {}),
  }));
  return { valid: true, report };
}

/** Normalizes evidence entries (strings or objects) to typed evidence. */
export function normalizeEvidence(input: EvidenceInput[] | undefined): Evidence[] | undefined {
  if (input === undefined) return undefined;
  return input.map((item) =>
    typeof item === "string" ? { kind: "observation" as const, excerpt: item } : item,
  );
}

export function normalizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    description: finding.description ?? finding.detail,
    evidence: normalizeEvidence(finding.evidence),
  };
}

export type { Confidence };