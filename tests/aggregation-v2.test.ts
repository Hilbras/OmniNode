/**
 * v2 Phase 10 tests — Aggregation Improvements (roadmap §14): agreement
 * tracking, conflict detection with both positions preserved, confidence
 * preservation, provenance-rich output, and determinism.
 */
import { describe, expect, it } from "vitest";
import { aggregateReports, detectConflicts } from "../src/reports/aggregate.js";
import { validateReport } from "../src/reports/schema.js";
import type { Finding, Report } from "../src/types/report.js";

function report(agent: string, findings: Finding[], recommendations: string[] = []): Report {
  const result = validateReport({
    id: `rep-${agent}`,
    taskId: "t1",
    agent,
    summary: `${agent} summary`,
    findings,
    recommendations,
    createdAt: new Date().toISOString(),
  });
  if (!result.valid) throw new Error("fixture must be valid");
  return result.report;
}

const injection = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  title: "SQL injection in the login handler",
  detail: "the login query is concatenated",
  ...over,
});

describe("agreements (§14)", () => {
  it("records multi-agent consensus with the same severity", () => {
    const combined = aggregateReports([
      report("kimi", [injection({ severity: "high" })]),
      report("gemini", [injection({ id: "f2", severity: "high" })]),
    ]);
    expect(combined.agreements).toHaveLength(1);
    expect(combined.agreements[0]?.occurrences).toBe(2);
    expect(combined.conflicts).toHaveLength(0);
  });

  it("a single-agent finding is not an agreement", () => {
    const combined = aggregateReports([report("kimi", [injection({ severity: "high" })])]);
    expect(combined.agreements).toHaveLength(0);
    expect(combined.findings).toHaveLength(1);
  });
});

describe("conflict detection (§14)", () => {
  it("preserves both positions when agents disagree on severity", () => {
    const combined = aggregateReports([
      report("kimi", [injection({ severity: "critical" })]),
      report("gemini", [injection({ id: "f2", severity: "low" })]),
    ]);
    expect(combined.conflicts).toHaveLength(1);
    const conflict = combined.conflicts[0]!;
    expect(conflict.type).toBe("severity");
    expect(conflict.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "kimi", severity: "critical" }),
        expect.objectContaining({ agent: "gemini", severity: "low" }),
      ]),
    );
    // Both positions survive; nothing was silently discarded.
    expect(conflict.positions).toHaveLength(2);
    expect(combined.findings[0]?.severityBySource).toEqual({ kimi: "critical", gemini: "low" });
  });

  it("flags divergent recommended fixes for the same finding", () => {
    const combined = aggregateReports([
      report("kimi", [injection({ severity: "high", recommendation: "parameterize the query" })]),
      report("gemini", [injection({ id: "f2", severity: "high", recommendation: "add an ORM layer" })]),
    ]);
    const recommendationConflict = combined.conflicts.find((c) => c.type === "recommendation");
    expect(recommendationConflict).toBeDefined();
    expect(recommendationConflict?.note).toContain("none was discarded");
  });

  it("detectConflicts works standalone over aggregated findings", () => {
    const { findings } = aggregateReports([
      report("a", [injection({ severity: "high" })]),
      report("b", [injection({ id: "f2", severity: "critical" })]),
    ]);
    expect(detectConflicts(findings)).toHaveLength(1);
  });
});

describe("confidence preservation (§14)", () => {
  it("keeps the strongest confidence and records per-source values", () => {
    const combined = aggregateReports([
      report("kimi", [injection({ severity: "high", confidence: "low" })]),
      report("gemini", [injection({ id: "f2", severity: "high", confidence: "high" })]),
    ]);
    expect(combined.findings[0]?.confidence).toBe("high");
    expect(combined.findings[0]?.confidenceBySource).toEqual({ kimi: "low", gemini: "high" });
  });
});

describe("output shape and determinism (§14)", () => {
  it("carries provenance-rich metadata and lists both sections", () => {
    const combined = aggregateReports(
      [
        report("kimi", [injection({ severity: "high" }), { id: "f9", title: "Outdated dependency", detail: "left-pad 1.2" }], ["Bump left-pad"]),
        report("gemini", [injection({ id: "f2", severity: "critical" })]),
      ],
      { objective: "audit auth" },
    );
    expect(combined.findings).toHaveLength(2);
    expect(combined.sources.sort()).toEqual(["gemini", "kimi"]);
    expect(combined.reportIds.sort()).toEqual(["rep-gemini", "rep-kimi"]);
    expect(combined.metadata).toMatchObject({
      agents: 2,
      reports: 2,
      rawFindings: 3,
      findingGroups: 2,
      conflicts: 1,
    });
    expect(combined.recommendations).toHaveLength(1);
  });

  it("is deterministic: identical input yields identical structure", () => {
    const inputs = () => [
      report("kimi", [injection({ severity: "high" })]),
      report("gemini", [injection({ id: "f2", severity: "low" })]),
    ];
    const first = aggregateReports(inputs());
    const second = aggregateReports(inputs());
    expect({ ...first, id: "", createdAt: "" }).toEqual({ ...second, id: "", createdAt: "" });
  });
});