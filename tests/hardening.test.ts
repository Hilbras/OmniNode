/**
 * Phase 10 hardening tests: audit logging, agent environment isolation,
 * store write-safety under concurrency, and wide research fan-out.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditLog } from "../src/audit/index.js";
import { ProcessAgent } from "../src/agents/process/index.js";
import { buildChildEnv } from "../src/agents/env.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { FileReportStore } from "../src/reports/store.js";
import { FilePlanStore } from "../src/planner/store.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { HeuristicPlanner } from "../src/planner/heuristic.js";
import { ReportService } from "../src/reports/service.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-hard-"));
}

class QuickAgent implements IAgent {
  info: AgentInfo;
  constructor(name: string) {
    this.info = { name, integration: "process", status: "ready" };
  }
  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    return { taskId: input.taskId, status: "completed", summary: `${this.info.name} ok` };
  }
  async cancel(): Promise<void> {}
}

describe("audit logging (§24)", () => {
  it("appends JSONL events and reads them back", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    await audit.record({ at: "2026-01-01T00:00:00.000Z", action: "task.created", id: "t1", detail: { objective: "x" } });
    await audit.record({ at: "2026-01-01T00:00:01.000Z", action: "task.completed", id: "t1" });

    const events = await audit.recent();
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("task.created");
    expect(events[0]?.detail).toEqual({ objective: "x" });
    expect(existsSync(path.join(dir, "audit.jsonl"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when nothing was logged", async () => {
    const audit = new FileAuditLog(tmp());
    expect(await audit.recent()).toEqual([]);
  });

  it("records task lifecycle events through the engine", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    const agents = new AgentRegistry();
    agents.register(new QuickAgent("a"));
    const roles = new RoleRegistry();
    const engine = new TaskEngine({ agents, roles, store: new FileTaskStore(dir), audit });

    const created = await engine.create({ objective: "audited task", agent: "a" });
    await engine.run(created.id);
    const events = await audit.recent();
    const actions = events.map((e) => e.action);
    expect(actions).toContain("task.created");
    expect(actions).toContain("task.running");
    expect(actions).toContain("task.completed");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("agent environment isolation", () => {
  it("inherits the full environment by default", () => {
    const env = buildChildEnv({ name: "a", integration: "process", command: "x", env: { FOO: "bar" } });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.FOO).toBe("bar");
  });

  it("with inheritEnv false only PATH/HOME and configured vars are passed", () => {
    const env = buildChildEnv({
      name: "a",
      integration: "process",
      command: "x",
      inheritEnv: false,
      env: { ALLOWED: "1" },
    });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.ALLOWED).toBe("1");
    // Secrets from the parent environment are not leaked.
    expect(env.SOME_RANDOM_PARENT_VAR).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["ALLOWED", "HOME", "PATH"]);
  });

  it("env isolation is a per-agent config option", () => {
    const agent = new ProcessAgent({
      name: "isolated",
      integration: "process",
      command: "node",
      inheritEnv: false,
    });
    expect(agent.info.name).toBe("isolated");
  });
});

describe("store reliability under concurrency", () => {
  it("concurrent task saves do not lose updates", async () => {
    const dir = tmp();
    const store = new FileTaskStore(dir);
    const now = new Date().toISOString();
    // 40 concurrent saves, as parallel research fan-out would produce.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.save({
          id: `task-${i}`,
          objective: `objective ${i}`,
          status: "created",
          attempt: 0,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
    const all = await store.list();
    expect(all).toHaveLength(40);
    rmSync(dir, { recursive: true, force: true });
  });

  it("concurrent report and plan saves are also serialized safely", async () => {
    const dir = tmp();
    const reports = new FileReportStore(dir);
    const plans = new FilePlanStore(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reports.saveReports([
          {
            id: `r-${i}`,
            taskId: "t",
            agent: "a",
            summary: `s${i}`,
            findings: [],
            recommendations: [],
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        plans.save({
          id: `p-${i}`,
          objective: "o",
          summary: "s",
          steps: [],
          generatedBy: "heuristic",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    expect(await reports.listReports()).toHaveLength(20);
    expect(await plans.list()).toHaveLength(20);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("wide research fan-out", () => {
  it("handles a 5-agent research step end to end", async () => {
    const dir = tmp();
    const agents = new AgentRegistry();
    for (const name of ["a1", "a2", "a3", "a4", "a5"]) agents.register(new QuickAgent(name));
    const roles = new RoleRegistry();
    const tasks = new TaskEngine({ agents, roles, store: new FileTaskStore(dir) });
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles,
      providers: [],
      store: new FilePipelineRunStore(dir),
      plans: new FilePlanStore(dir),
      reports: new ReportService(new FileReportStore(dir)),
      planner: new HeuristicPlanner(),
    });

    const run = await engine.run(
      {
        id: "wide",
        steps: [
          { id: "research", kind: "research", agents: ["a1", "a2", "a3", "a4", "a5"] },
          { id: "plan", kind: "plan" },
        ],
      },
      { objective: "wide fan-out" },
    );

    expect(run.status).toBe("completed");
    expect(run.stepRuns[0]?.taskIds).toHaveLength(5);
    expect(run.planId).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});