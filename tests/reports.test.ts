import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractReportFromText } from "../src/reports/extract.js";
import { aggregateReports, similar } from "../src/reports/aggregate.js";
import { ReportService } from "../src/reports/service.js";
import { FileReportStore, type ReportStore } from "../src/reports/store.js";
import type { Report } from "../src/types/report.js";
import type { Task } from "../src/types/task.js";

function report(partial: Partial<Report> & { id: string; agent: string }): Report {
  return {
    taskId: "t1",
    summary: `summary of ${partial.id}`,
    findings: [],
    recommendations: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function task(id: string, agent: string, result: Task["result"]): Task {
  const now = new Date().toISOString();
  return { id, objective: "obj", agent, status: "completed", createdAt: now, updatedAt: now, result };
}

describe("extractReportFromText", () => {
  it("extracts findings, recommendations and evidence from markdown sections", () => {
    const raw = `# Summary
The auth module needs work.

# Findings
- SQL injection in the login handler
- Minor: missing rate limiting on /login

# Recommendations
- Use parameterized queries

# Evidence
- logs/auth.log lines 40-55`;

    const extracted = extractReportFromText(raw, { taskId: "task-1", agent: "auditor" });
    expect(extracted.summary).toBe("The auth module needs work.");
    expect(extracted.findings).toHaveLength(2);
    expect(extracted.findings[0]).toMatchObject({
      id: "task-1-f-1",
      title: "SQL injection in the login handler",
    });
    expect(extracted.findings[1]?.severity).toBe("low");
    expect(extracted.recommendations).toEqual(["Use parameterized queries"]);
    expect(extracted.metadata?.evidence).toEqual(["logs/auth.log lines 40-55"]);
  });

  it("falls back to a summary-only report for unstructured output", () => {
    const extracted = extractReportFromText("RESEARCH-OK\nsecond line", {
      taskId: "task-2",
      agent: "echo",
    });
    expect(extracted.summary).toBe("RESEARCH-OK");
    expect(extracted.findings).toEqual([]);
    expect(extracted.recommendations).toEqual([]);
  });
});

describe("aggregateReports", () => {
  const first = report({
    id: "rep-a",
    agent: "kimi",
    findings: [
      {
        id: "f1",
        title: "SQL injection in the login handler",
        detail: "login query is concatenated",
        severity: "high",
        evidence: ["logs/auth.log:40"],
      },
      { id: "f2", title: "Outdated dependency left-pad", detail: "left-pad 1.2.0 is old" },
    ],
    recommendations: ["Use parameterized queries"],
  });
  const second = report({
    id: "rep-b",
    agent: "gemini",
    findings: [
      {
        id: "f3",
        title: "sql injection in the login handler",
        detail: "same issue, different wording",
        severity: "critical",
      },
      { id: "f4", title: "Cache never invalidated", detail: "cache entries live forever" },
    ],
    recommendations: ["Use parameterized queries"],
  });

  it("merges duplicate and similar findings, preserving sources", () => {
    const combined = aggregateReports([first, second], { objective: "audit auth" });
    expect(combined.sources.sort()).toEqual(["gemini", "kimi"]);
    expect(combined.findings).toHaveLength(3); // merged injection + 2 distinct

    const injection = combined.findings.find((f) => f.title.includes("SQL injection"));
    expect(injection).toMatchObject({
      occurrences: 2,
      severity: "critical", // highest of high/critical
    });
    expect(injection?.sources.map((s) => s.agent).sort()).toEqual(["gemini", "kimi"]);
    expect(injection?.details).toHaveLength(2);
    expect(injection?.evidence).toEqual(["logs/auth.log:40"]);
  });

  it("merges duplicate recommendations", () => {
    const combined = aggregateReports([first, second]);
    expect(combined.recommendations).toHaveLength(1);
    expect(combined.recommendations[0]).toMatchObject({
      occurrences: 2,
      text: "Use parameterized queries",
    });
  });

  it("keeps distinct findings separate below the similarity threshold", () => {
    expect(similar("SQL injection in the login handler", "Cache never invalidated", 0.7)).toBe(false);
    expect(similar("SQL injection in the login handler", "sql injection in the login handler", 0.7)).toBe(true);
  });

  it("sorts findings by severity", () => {
    const combined = aggregateReports([first, second]);
    expect(combined.findings[0]?.severity).toBe("critical");
  });
});

describe("ReportService", () => {
  it("collects structured reports when present and synthesizes from text otherwise", async () => {
    const store = new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-rep-")));
    const service = new ReportService(store);
    const structuredTask = task("task-1", "proto", {
      summary: "structured",
      reports: [report({ id: "task-1-report", agent: "proto" })],
    });
    const textTask = task("task-2", "echo", {
      summary: "RESEARCH-OK",
      rawOutput: "# Findings\n- Major: broken auth flow",
    });
    const collected = await service.collectFromTasks([structuredTask, textTask]);

    expect(collected).toHaveLength(2);
    expect(collected[0]?.id).toBe("task-1-report"); // structured passes through
    expect(collected[1]?.findings[0]?.severity).toBe("high"); // extracted from text
  });

  it("roundtrips reports and combined reports through the store", async () => {
    const store: ReportStore = new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-rep2-")));
    const service = new ReportService(store);
    const reports = [
      report({ id: "rep-a", agent: "kimi", taskId: "task-1" }),
      report({ id: "rep-b", agent: "gemini", taskId: "task-2" }),
    ];
    await service.saveReports(reports);
    const combined = await service.generateCombined(reports, {
      objective: "audit",
      pipelineRunId: "run-1",
      taskIds: ["task-1", "task-2"],
    });

    expect(combined).toBeDefined();
    expect((await store.listReports({ agent: "kimi" })).map((r) => r.id)).toEqual(["rep-a"]);
    expect((await store.listCombined({ pipelineRunId: "run-1" })).map((c) => c?.id)).toEqual([
      combined!.id,
    ]);
    expect((await store.getCombined(combined!.id))?.summary).toContain("2 report(s)");
    expect(await store.getCombined("nope")).toBeUndefined();
  });

  it("returns undefined when combining an empty set", async () => {
    const service = new ReportService(new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-rep3-"))));
    expect(await service.generateCombined([])).toBeUndefined();
  });
});
