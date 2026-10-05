/**
 * v2 Phase 20 tests — Performance & Resource Management (roadmap §24):
 * bounded memory, bounded disk growth, bounded scheduling, and released
 * resources.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateReports, MAX_COMBINED_FINDINGS } from "../src/reports/aggregate.js";
import { FileAuditLog } from "../src/audit/index.js";
import { PipelineEngine, budgetContext, DEFAULT_MAX_PARALLEL_STEPS } from "../src/pipelines/engine.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { validateReport } from "../src/reports/schema.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";
import type { Report } from "../src/types/report.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-res-"));
}

function reportWithFindings(agent: string, count: number): Report {
  const result = validateReport({
    id: `rep-${agent}`,
    taskId: "t",
    agent,
    summary: `${agent} analysis`,
    findings: Array.from({ length: count }, (_, i) => ({
      id: `${agent}-f${i}`,
      // Unique, non-similar titles: otherwise grouping (correctly) merges them.
      title: `x${agent}q${i}z${"w".repeat(8)}`,
      detail: `detail ${i}`,
      severity: "medium",
    })),
    recommendations: [],
    createdAt: new Date().toISOString(),
  });
  if (!result.valid) throw new Error("fixture must be valid");
  return result.report;
}

describe("bounded memory (§24)", () => {
  it("caps combined-report findings and records the truncation", () => {
    const reports = [reportWithFindings("a", 150), reportWithFindings("b", 150)];
    const combined = aggregateReports(reports);
    expect(combined.findings).toHaveLength(MAX_COMBINED_FINDINGS);
    expect(combined.metadata).toMatchObject({ findingsTruncated: 300 - MAX_COMBINED_FINDINGS });

    const smaller = aggregateReports(reports, { maxFindings: 10 });
    expect(smaller.findings).toHaveLength(10);
  });

  it("budgets combined context, keeping the most recent part", () => {
    const long = "x".repeat(30_000);
    const budgeted = budgetContext(long, 1_000);
    expect(budgeted.length).toBeLessThanOrEqual(1_000);
    expect(budgeted).toContain("earlier context trimmed"); // §23 Fix 08 marker
    expect(budgetContext("short", 1_000)).toBe("short");
  });
});

describe("bounded disk growth (§24)", () => {
  it("rotates the audit log past its size budget, keeping one backup", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir, undefined, 500); // tiny rotation threshold
    for (let i = 0; i < 20; i += 1) {
      await audit.record({
        at: new Date().toISOString(),
        action: "task.created",
        id: `t${i}`,
        detail: { padding: "y".repeat(100) },
      });
    }
    expect(existsSync(path.join(dir, "audit.jsonl.1"))).toBe(true);
    // The active log stays within the budget.
    expect(readFileSync(path.join(dir, "audit.jsonl"), "utf8").length).toBeLessThan(2_500);
  });
});

describe("bounded scheduling (§24)", () => {
  it("never runs more steps concurrently than maxParallelSteps", async () => {
    const dir = tmp();
    let active = 0;
    let peak = 0;
    const tracker: IAgent = {
      info: { name: "worker", integration: "process", status: "ready" },
      run: async (input: AgentTaskInput): Promise<AgentTaskOutput> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { taskId: input.taskId, status: "completed", summary: "ok" };
      },
      cancel: async () => {},
    };

    const agents = new AgentRegistry();
    agents.register(tracker);
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
      maxParallelSteps: 2,
    });

    // Four independent steps in one wave (explicit shared dependency root).
    const run = await engine.run(
      {
        id: "wide",
        steps: [
          { id: "seed", kind: "collect" },
          { id: "a", kind: "analyze", agent: "worker", dependsOn: ["seed"] },
          { id: "b", kind: "analyze", agent: "worker", dependsOn: ["seed"] },
          { id: "c", kind: "analyze", agent: "worker", dependsOn: ["seed"] },
          { id: "d", kind: "analyze", agent: "worker", dependsOn: ["seed"] },
        ],
      },
      { objective: "storm check" },
    );

    expect(run.status).toBe("completed");
    expect(peak).toBeLessThanOrEqual(2);
    expect(DEFAULT_MAX_PARALLEL_STEPS).toBeGreaterThan(0);
  }, 20_000);
});

describe("released resources (§24)", () => {
  it("releases child pipes so repeated agent runs do not accumulate handles", async () => {
    const dir = tmp();
    const { ProcessAgent } = await import("../src/agents/process/index.js");
    const agent: IAgent = new ProcessAgent({
      name: "echo",
      integration: "process",
      command: "node",
      args: ["-e", "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('ok'))"],
      timeoutMs: 5_000,
    });

    const before = process.getActiveResourcesInfo?.().length ?? 0;
    for (let i = 0; i < 25; i += 1) {
      const result = await agent.run({ taskId: `t${i}`, objective: "x" });
      expect(result.status).toBe("completed");
    }
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    // No unbounded growth: repeated runs must not keep handles around.
    expect(after - before).toBeLessThan(25);
    void dir;
  }, 30_000);

  it("keeps the audit queue serialized under concurrent writers", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit.record({ at: new Date().toISOString(), action: "task.created", id: `t${i}` }),
      ),
    );
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines.every((line) => JSON.parse(line).action === "task.created")).toBe(true);
  });

  it("store writes stay serialized under concurrent saves", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, ".keep"), "");
    const store = new FileTaskStore(dir);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        store.save({
          id: `t${i}`,
          objective: `o${i}`,
          status: "created",
          attempt: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    expect(await store.list()).toHaveLength(30);
  });
});

/** Keeps the TypeScript import of AgentInfo used in fixtures explicit. */
export type { AgentInfo };
