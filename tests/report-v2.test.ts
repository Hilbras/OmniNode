/**
 * v2 Phase 9 tests — Report System v2 (roadmap §13): schema validation,
 * normalization of legacy shapes, typed evidence, and the guarantee that
 * malformed reports never enter aggregation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateReport, normalizeEvidence } from "../src/reports/schema.js";
import { ReportService } from "../src/reports/service.js";
import { FileReportStore } from "../src/reports/store.js";
import { aggregateReports } from "../src/reports/aggregate.js";
import type { Report } from "../src/types/report.js";
import type { Task } from "../src/types/task.js";

function validReport(over: Partial<Report> = {}): Report {
  return {
    id: "r1",
    taskId: "t1",
    agent: "kimi",
    summary: "found an issue",
    findings: [
      {
        id: "f1",
        title: "SQL injection",
        detail: "login query is concatenated",
        severity: "high",
        evidence: ["logs/auth.log:40"],
      },
    ],
    recommendations: ["Use parameterized queries"],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function task(id: string, result: Task["result"]): Task {
  return {
    id,
    objective: "audit",
    agent: "kimi",
    status: "completed",
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result,
  };
}

describe("report validation (§13)", () => {
  it("accepts a well-formed report and normalizes it", () => {
    const result = validateReport(validReport());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const finding = result.report.findings[0]!;
    expect(finding.description).toBe("login query is concatenated"); // mirrors detail
    expect(finding.evidence).toEqual([{ kind: "observation", excerpt: "logs/auth.log:40" }]);
    expect(finding.source).toMatchObject({ agent: "kimi", reportId: "r1" });
  });

  it("rejects malformed reports with actionable issues", () => {
    const broken = { ...validReport(), id: "", findings: [{ id: "f1" }] };
    const result = validateReport(broken);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.path === "id" || i.path.startsWith("findings"))).toBe(true);
  });

  it("preserves typed evidence objects as-is", () => {
    const result = validateReport(
      validReport({
        findings: [
          {
            id: "f1",
            title: "Leak",
            detail: "stack trace in response",
            evidence: [{ kind: "line", ref: "src/api.ts", line: 42 }, { kind: "url", ref: "https://cve.example/1" }],
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.evidence).toEqual([
      { kind: "line", ref: "src/api.ts", line: 42 },
      { kind: "url", ref: "https://cve.example/1" },
    ]);
  });

  it("normalizeEvidence converts strings and passes objects through", () => {
    expect(normalizeEvidence(["a", { kind: "file", ref: "x" }])).toEqual([
      { kind: "observation", excerpt: "a" },
      { kind: "file", ref: "x" },
    ]);
    expect(normalizeEvidence(undefined)).toBeUndefined();
  });

  it("carries artifacts and provenance", () => {
    const result = validateReport(
      validReport({
        pipelineRunId: "run-1",
        artifacts: [{ kind: "patch", ref: "fix.diff", bytes: 2048 }],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.pipelineRunId).toBe("run-1");
    expect(result.report.artifacts?.[0]?.ref).toBe("fix.diff");
    expect(result.report.findings[0]?.source?.pipelineRunId).toBe("run-1");
  });
});

describe("malformed reports never enter aggregation (§13)", () => {
  it("the service drops invalid reports and records diagnostics", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-rep-v2-"));
    const service = new ReportService(new FileReportStore(dir));

    const collected = await service.collectFromTasks([
      task("t-good", { reports: [validReport()] }),
      task("t-bad", { reports: [{ ...validReport({ id: "" }), summary: "broken" } as Report] }),
      task("t-text", { rawOutput: "# Findings\n- Plain text finding" }),
    ]);

    expect(collected).toHaveLength(2); // good + text-extracted; the broken one is dropped
    expect(service.lastDiagnostics.collected).toBe(3);
    expect(service.lastDiagnostics.accepted).toBe(2);
    expect(service.lastDiagnostics.rejected).toHaveLength(1);
    expect(collected.every((r) => r.findings.every((f) => f.description !== undefined))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregation merges typed evidence across duplicate findings", () => {
    const a = validateReport(validReport({ id: "a" }));
    const b = validateReport(
      validReport({
        id: "b",
        agent: "gemini",
        findings: [
          {
            id: "f9",
            title: "SQL injection",
            detail: "confirmed independently",
            evidence: [{ kind: "url", ref: "https://example.test/poc" }],
          },
        ],
      }),
    );
    if (!a.valid || !b.valid) throw new Error("fixtures must be valid");
    const combined = aggregateReports([a.report, b.report]);
    expect(combined.findings[0]?.occurrences).toBe(2);
    expect(combined.findings[0]?.evidence).toEqual([
      { kind: "observation", excerpt: "logs/auth.log:40" },
      { kind: "url", ref: "https://example.test/poc" },
    ]);
    expect(combined.findings[0]?.sources.map((s) => s.agent).sort()).toEqual(["gemini", "kimi"]);
  });
});