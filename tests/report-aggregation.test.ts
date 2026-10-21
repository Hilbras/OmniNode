/**
 * v3 audit — report aggregation semantics.
 *
 * Two defects in `src/reports/aggregate.ts`:
 *   1. "agreement" was counted per report OCCURRENCE, not per distinct
 *      agent, so one agent that reported the same finding twice created a
 *      fake consensus;
 *   2. when agents proposed conflicting fixes, every agent's position was
 *      attributed the FIRST agent's recommendation.
 */
import { describe, expect, it } from "vitest";
import { aggregateReports, detectConflicts } from "../src/reports/aggregate.js";
import type { Report } from "../src/types/report.js";

function report(agent: string, findings: Report["findings"], id = `task-${agent}`): Report {
  return {
    id: `${id}-report`,
    taskId: id,
    agent,
    summary: `${agent} report`,
    findings,
    recommendations: [],
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

const finding = (overrides: Partial<Report["findings"][number]> = {}) => ({
  id: "f-1",
  title: "SQL injection in the login handler",
  detail: "unsanitised query parameter",
  severity: "critical" as const,
  confidence: "high" as const,
  ...overrides,
});

describe("agreement needs two distinct agents", () => {
  it("does not count one agent reporting twice as an agreement", () => {
    const combined = aggregateReports([
      report("alpha", [finding()], "task-1"),
      report("alpha", [finding()], "task-2"),
    ]);

    expect(combined.agreements).toHaveLength(0);
  });

  it("counts two agents reporting the same finding as an agreement", () => {
    const combined = aggregateReports([
      report("alpha", [finding()], "task-1"),
      report("beta", [finding()], "task-2"),
    ]);

    expect(combined.agreements).toHaveLength(1);
  });

  it("does not count an agreement when the agents disagree on severity", () => {
    const combined = aggregateReports([
      report("alpha", [finding({ severity: "critical" })], "task-1"),
      report("beta", [finding({ severity: "low" })], "task-2"),
    ]);

    expect(combined.agreements).toHaveLength(0);
    expect(combined.conflicts.some((c) => c.type === "severity")).toBe(true);
  });
});

describe("a conflict attributes each agent's own fix", () => {
  it("keeps every agent's recommendation in its own position", () => {
    const combined = aggregateReports([
      report("alpha", [finding({ recommendation: "use parameterised queries" })], "task-1"),
      report("beta", [finding({ recommendation: "sanitise the input" })], "task-2"),
    ]);

    const conflict = combined.conflicts.find((c) => c.type === "recommendation");
    expect(conflict).toBeDefined();
    const positions = conflict!.positions;
    expect(positions.find((p) => p.agent === "alpha")?.recommendation).toBe(
      "use parameterised queries",
    );
    expect(positions.find((p) => p.agent === "beta")?.recommendation).toBe("sanitise the input");
  });

  it("records the per-agent recommendation on the aggregated finding", () => {
    const combined = aggregateReports([
      report("alpha", [finding({ recommendation: "use parameterised queries" })], "task-1"),
      report("beta", [finding({ recommendation: "sanitise the input" })], "task-2"),
    ]);

    const aggregated = combined.findings.find((f) => f.title.includes("SQL injection"));
    expect(aggregated?.recommendationBySource?.alpha).toBe("use parameterised queries");
    expect(aggregated?.recommendationBySource?.beta).toBe("sanitise the input");
  });

  it("a single agent's recommendation is not treated as a conflict", () => {
    const combined = aggregateReports([
      report("alpha", [finding({ recommendation: "use parameterised queries" })], "task-1"),
    ]);

    expect(combined.conflicts.filter((c) => c.type === "recommendation")).toHaveLength(0);
  });
});

describe("detectConflicts on a hand-built group", () => {
  it("does not attribute one agent's recommendation to another", () => {
    const conflicts = detectConflicts([
      {
        title: "finding",
        details: ["d"],
        sources: [
          { agent: "alpha", reportId: "r1" },
          { agent: "beta", reportId: "r2" },
        ],
        occurrences: 2,
        severity: "high",
        severityBySource: { alpha: "high", beta: "high" },
        recommendations: ["alpha fix", "beta fix"],
        recommendationBySource: { alpha: "alpha fix", beta: "beta fix" },
        evidence: [],
      },
    ]);

    const conflict = conflicts.find((c) => c.type === "recommendation");
    expect(conflict).toBeDefined();
    expect(conflict!.positions.find((p) => p.agent === "beta")?.recommendation).toBe("beta fix");
  });
});
