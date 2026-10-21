/**
 * Coverage tests for the planner heuristic, provider error normalization,
 * the report schema/service and the role registry.
 *
 * These reach the paths the feature suites do not: aggregated findings
 * without severity, HTTP vs. transport failures, oversized and malformed
 * reports, and role ordering.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HeuristicPlanner } from "../src/planner/heuristic.js";
import {
  extractMessage,
  isNetworkError,
  isRetryable,
  isTimeoutError,
  kindFromStatus,
  parseRetryAfter,
  providerHttpError,
  providerTransportError,
} from "../src/providers/errors.js";
import { normalizeEvidence, normalizeFinding, validateReport } from "../src/reports/schema.js";
import { MAX_REPORT_BYTES, ReportService } from "../src/reports/service.js";
import { FileReportStore } from "../src/reports/store.js";
import { Logger, type LogSink } from "../src/logger/index.js";
import { RoleRegistry, buildRoleRegistry } from "../src/roles/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CombinedReport, Report } from "../src/types/report.js";
import type { Plan, PlanStep } from "../src/types/plan.js";
import type { RoleDefinition } from "../src/types/role.js";
import type { Task } from "../src/types/task.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The planner echoes `constraints` through, but the published Plan type omits it. */
type PlanWithConstraints = Plan & { constraints?: string[] };
/** The planner emits a per-step `recommendation`, which PlanStep omits. */
type PlanStepWithRecommendation = PlanStep & { recommendation?: string };

function report(over: Partial<Report> = {}): Report {
  return {
    id: "rep-a",
    taskId: "t1",
    agent: "kimi",
    summary: "research done",
    findings: [],
    recommendations: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function task(id: string, result?: Task["result"], agent?: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    objective: "audit the service",
    ...(agent !== undefined ? { agent } : {}),
    status: "completed",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    ...(result !== undefined ? { result } : {}),
  };
}

/** A logger that keeps every emitted line so warnings can be asserted. */
function capturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink: LogSink = {
    write(level, line) {
      lines.push(`${level}: ${line}`);
    },
  };
  return { log: new Logger({ level: "debug", sink }), lines };
}

/* ------------------------------------------------------------------ */
/* planner heuristic                                                   */
/* ------------------------------------------------------------------ */

describe("HeuristicPlanner branch coverage", () => {
  const longRecommendation =
    "Add comprehensive input validation to every endpoint that accepts user supplied payloads and answers with structured errors";

  const aggregated: CombinedReport = {
    id: "combined-1",
    title: "Aggregated audit",
    taskIds: ["t1"],
    summary: "two agents looked",
    findings: [
      {
        // No severity, no details, no recommendations.
        title: "Missing rate limiting",
        details: [],
        sources: [{ agent: "kimi", reportId: "r1" }],
        occurrences: 1,
        evidence: [],
      },
      {
        title: "Weak token expiry",
        details: ["tokens never expire"],
        sources: [{ agent: "gemini", reportId: "r2" }],
        occurrences: 1,
        severity: "critical",
        recommendations: ["Rotate the signing key"],
        evidence: [],
      },
      {
        title: "Session fixation",
        details: ["the session id never rotates"],
        sources: [{ agent: "kimi", reportId: "r1" }],
        occurrences: 1,
        severity: "high",
        evidence: [],
      },
    ],
    agreements: [],
    conflicts: [],
    recommendations: [],
    sources: ["gemini", "kimi"],
    reportIds: ["r1", "r2"],
    createdAt: new Date().toISOString(),
  };

  it("chains recommendation steps, truncates long text and keeps constraints", async () => {
    const plan = (await new HeuristicPlanner().plan({
      objective: "harden auth",
      reports: [
        report({
          id: "rep-long",
          findings: [
            {
              id: "f1",
              title: "Unsigned tokens accepted",
              detail: "the verifier skips the signature",
              severity: "critical",
              recommendation: "Rotate the signing key",
            },
          ],
          recommendations: [longRecommendation, "Rate limit the login endpoint"],
        }),
      ],
      constraints: ["no breaking API changes"],
      taskId: "task-77",
      pipelineRunId: "run-9",
    })) as PlanWithConstraints;

    expect(plan.steps).toHaveLength(3);
    // The first step has no dependency, the second depends on the first.
    expect(plan.steps[0]?.dependsOn).toBeUndefined();
    expect(plan.steps[1]?.dependsOn).toEqual(["step-1"]);
    // A recommendation longer than 120 characters is truncated: the first
    // 119 characters plus a single ellipsis character (U+2026).
    expect(plan.steps[0]?.title.endsWith("\u2026")).toBe(true);
    expect(plan.steps[0]?.title).toHaveLength(120);
    expect(plan.steps[1]?.title).toBe("Rate limit the login endpoint");
    // The remediation step follows the recommendation steps and carries the fix.
    const remediation = plan.steps[2] as PlanStepWithRecommendation;
    expect(remediation.id).toBe("step-3");
    expect(remediation.dependsOn).toEqual(["step-2"]);
    expect(remediation.sourceFindings).toEqual(["f1"]);
    expect(remediation.recommendation).toBe("Rotate the signing key");
    // Optional request fields are echoed back.
    expect(plan.constraints).toEqual(["no breaking API changes"]);
    expect(plan.taskId).toBe("task-77");
    expect(plan.pipelineRunId).toBe("run-9");
    expect(plan.goal).toBe("harden auth");
    expect(plan.summary).toBe(
      "Derived from 1 report(s): 2 recommendation step(s), 1 remediation step(s).",
    );
  });

  it("plans from aggregated findings, tolerating missing severity, details and recommendations", async () => {
    const plan = (await new HeuristicPlanner().plan({
      objective: "harden auth",
      reports: [],
      aggregated,
    })) as PlanWithConstraints;

    expect(plan.goal).toBe("Aggregated audit");
    // Only the critical and high aggregated findings are significant.
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.title).toBe("Fix: Weak token expiry");
    expect(plan.steps[0]?.description).toBe("tokens never expire");
    expect((plan.steps[0] as PlanStepWithRecommendation).recommendation).toBe(
      "Rotate the signing key",
    );
    // The first remediation step has no dependency, the second depends on it.
    expect(plan.steps[0]?.dependsOn).toEqual([]);
    expect(plan.steps[1]?.title).toBe("Fix: Session fixation");
    expect(plan.steps[1]?.dependsOn).toEqual(["step-1"]);
    expect(plan.summary).toContain("2 remediation step(s)");
    // The critical finding is surfaced as a risk.
    expect(plan.risks?.join(" ")).toContain("Critical finding unaddressed");
  });

  it("ignores findings without severity when scoring significance", async () => {
    const plan = (await new HeuristicPlanner().plan({
      objective: "x",
      reports: [
        report({
          id: "rep-soft",
          findings: [
            { id: "f-soft", title: "Style nit", detail: "prefer tabs" },
            { id: "f-low", title: "Typo", detail: "misspelt", severity: "low" },
          ],
        }),
      ],
    })) as PlanWithConstraints;

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.title).toBe("Gather additional information");
    expect(plan.risks).toBeUndefined();
  });
});
