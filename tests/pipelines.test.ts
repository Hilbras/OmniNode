import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PipelineEngine, type ChatFn } from "../src/pipelines/engine.js";
import { FilePipelineRunStore, type PipelineRunStore } from "../src/pipelines/store.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore, type TaskStore } from "../src/tasks/store.js";
import { FilePlanStore, type PlanStore } from "../src/planner/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import type { IAgent, AgentInfo, AgentTaskInput, AgentTaskOutput } from "../src/types/agent.js";
import type { PipelineDefinition } from "../src/types/pipeline.js";
import type { ChatMessage } from "../src/types/chat.js";
import type { Report } from "../src/types/report.js";

class FakeAgent implements IAgent {
  info: AgentInfo;
  readonly received: AgentTaskInput[] = [];

  constructor(name: string, private readonly outcome: Partial<AgentTaskOutput> = {}) {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    this.received.push(input);
    return {
      taskId: input.taskId,
      status: "completed",
      summary: `${this.info.name}-summary-${this.received.length}`,
      ...this.outcome,
    };
  }

  async cancel(): Promise<void> {}
}

class FlakyAgent implements IAgent {
  info: AgentInfo;
  attempts = 0;

  constructor(name: string, private readonly failTimes: number) {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    this.attempts += 1;
    if (this.attempts <= this.failTimes) {
      return { taskId: input.taskId, status: "failed", error: "flaky failure" };
    }
    return { taskId: input.taskId, status: "completed", summary: "recovered" };
  }
}

function report(id: string): Report {
  return { id, taskId: "t", agent: "a", summary: `report ${id}`, findings: [], recommendations: [], createdAt: new Date().toISOString() };
}

function tmpStores(): { dir: string; tasks: TaskStore; runs: PipelineRunStore; plans: PlanStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-pipe-"));
  return {
    dir,
    tasks: new FileTaskStore(dir),
    runs: new FilePipelineRunStore(dir),
    plans: new FilePlanStore(dir),
  };
}

function makeEngine(
  agents: IAgent[],
  chat?: ChatFn,
  stores = tmpStores(),
): { engine: PipelineEngine; tasks: TaskEngine; plans: PlanStore } {
  const registry = new AgentRegistry();
  for (const agent of agents) registry.register(agent);
  const roles = new RoleRegistry();
  roles.register({ id: "planner", name: "Planner", responsibilities: [], expectedOutputs: [] });
  const tasks = new TaskEngine({ agents: registry, roles, store: stores.tasks });
  const engine = new PipelineEngine({
    tasks,
    agents: registry,
    roles,
    providers: [{ name: "gw", type: "openai-compatible", baseUrl: "http://gw.test" }],
    store: stores.runs,
    plans: stores.plans,
    ...(chat ? { chat } : {}),
  });
  return { engine, tasks, plans: stores.plans };
}

const baseDef: PipelineDefinition = {
  id: "audit",
  role: "planner",
  steps: [
    { id: "research", kind: "research", agents: ["a", "b"] },
    { id: "collect", kind: "collect" },
    { id: "plan", kind: "plan", model: "gw:gpt-x" },
    { id: "execute", kind: "execute", agent: "exec" },
  ],
};

describe("PipelineEngine validation", () => {
  it.each([
    ["duplicate step ids", [{ id: "s", kind: "collect" as const }, { id: "s", kind: "plan" as const }]],
    [
      "unknown dependency",
      [{ id: "s", kind: "collect" as const, dependsOn: ["ghost"] }],
    ],
    [
      "cycle",
      [
        { id: "a", kind: "collect" as const, dependsOn: ["b"] },
        { id: "b", kind: "collect" as const, dependsOn: ["a"] },
      ],
    ],
    ["research without agents", [{ id: "r", kind: "research" as const }]],
    ["execute without agent", [{ id: "e", kind: "execute" as const }]],
  ])("rejects %s", (_name, steps) => {
    const { engine } = makeEngine([new FakeAgent("a")]);
    expect(() => engine.validate({ id: "p", steps })).toThrow(
      expect.objectContaining({ code: "PIPELINE_INVALID" }),
    );
  });

  it("rejects a run without an objective", async () => {
    const { engine } = makeEngine([new FakeAgent("a")]);
    await expect(
      engine.run({ id: "p", steps: [{ id: "s", kind: "collect" }] }),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID" });
  });

  it("rejects runs referencing unregistered agents", async () => {
    const { engine } = makeEngine([new FakeAgent("a")]);
    await expect(
      engine.run(
        { id: "p", objective: "x", steps: [{ id: "r", kind: "research", agents: ["ghost"] }] },
        { objective: "x" },
      ),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID", message: expect.stringContaining("ghost") });
  });
});

describe("PipelineEngine run", () => {
  it("runs research → collect → plan → execute and threads context through", async () => {
    const agentA = new FakeAgent("a", { reports: [report("r1")] });
    const agentB = new FakeAgent("b");
    const executor = new FakeAgent("exec");
    const chatCalls: Array<{ modelRef: string; messages: ChatMessage[] }> = [];
    const chat: ChatFn = async (modelRef, messages) => {
      chatCalls.push({ modelRef, messages });
      return "FINAL PLAN\n1. do the thing";
    };
    const { engine, plans } = makeEngine([agentA, agentB, executor], chat);

    const run = await engine.run(baseDef, { objective: "audit everything" });

    expect(run.status).toBe("completed");
    expect(run.stepRuns.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // Research fan-out created one task per agent.
    expect(agentA.received).toHaveLength(1);
    expect(agentB.received).toHaveLength(1);
    // Reports from research tasks flow up into the run.
    expect(run.reports).toHaveLength(1);
    // The planner saw both research summaries.
    const planInput = chatCalls[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(planInput).toContain("a-summary");
    expect(planInput).toContain("b-summary");
    expect(chatCalls[0]?.modelRef).toBe("gw:gpt-x");
    // The executor received the plan through its context.
    expect(executor.received[0]?.context).toContain("# Implementation Plan");
    expect(executor.received[0]?.role).toMatchObject({ id: "planner" });
    // §28 — the objective and the final result are persisted on the run.
    expect(run.objective).toBe("audit everything");
    expect(run.resultSummary).toContain("exec-summary");
    const reread = await engine.get(run.id);
    expect(reread?.objective).toBe("audit everything");
    expect(reread?.resultSummary).toContain("exec-summary");
    // The produced plan was persisted and linked to the run.
    expect(run.planId).toBeDefined();
    const stored = await plans.get(run.planId!);
    expect(stored?.steps.length).toBeGreaterThan(0);
    expect(stored?.pipelineRunId).toBe(run.id);
  });

  it("creates parallel research tasks in the task store", async () => {
    const { engine, tasks } = makeEngine([new FakeAgent("a"), new FakeAgent("b")]);
    const run = await engine.run(
      { id: "p", steps: [{ id: "research", kind: "research", agents: ["a", "b"] }] },
      { objective: "obj" },
    );
    expect(run.status).toBe("completed");
    const all = await tasks.list();
    expect(all).toHaveLength(2);
    expect(run.stepRuns[0]?.taskIds).toHaveLength(2);
  });

  it("fails the pipeline and skips downstream steps when research fails", async () => {
    const failing = new FakeAgent("bad", {});
    failing.run = async (input) => ({ taskId: input.taskId, status: "failed", error: "agent exploded" });
    const executor = new FakeAgent("exec");
    const { engine } = makeEngine([failing, executor]);
    const run = await engine.run(
      {
        id: "p",
        steps: [
          { id: "research", kind: "research", agents: ["bad"] },
          { id: "execute", kind: "execute", agent: "exec" },
        ],
      },
      { objective: "x" },
    );
    expect(run.status).toBe("failed");
    expect(run.stepRuns[0]?.status).toBe("failed");
    expect(run.stepRuns[1]?.status).toBe("cancelled"); // on-success skip
    expect(executor.received).toHaveLength(0);
  });

  it("runs on-failure steps after a failure and always steps regardless", async () => {
    const failing = new FakeAgent("bad", {});
    failing.run = async (input) => ({ taskId: input.taskId, status: "failed", error: "boom" });
    const handler = new FakeAgent("handler");
    const cleanup = new FakeAgent("cleanup");
    const { engine } = makeEngine([failing, handler, cleanup]);
    const run = await engine.run(
      {
        id: "p",
        steps: [
          { id: "research", kind: "research", agents: ["bad"] },
          { id: "alert", kind: "analyze", agent: "handler", condition: "on-failure" },
          { id: "cleanup", kind: "analyze", agent: "cleanup", condition: "always" },
        ],
      },
      { objective: "x" },
    );
    expect(run.status).toBe("failed");
    expect(run.stepRuns.find((s) => s.stepId === "alert")?.status).toBe("completed");
    expect(run.stepRuns.find((s) => s.stepId === "cleanup")?.status).toBe("completed");
  });

  it("retries failed steps when retries is configured", async () => {
    const flaky = new FlakyAgent("flaky", 1);
    const { engine } = makeEngine([flaky]);
    const run = await engine.run(
      {
        id: "p",
        steps: [{ id: "work", kind: "analyze", agent: "flaky", retries: 1 }],
      },
      { objective: "x" },
    );
    expect(run.status).toBe("completed");
    expect(flaky.attempts).toBe(2);
  });

  it("plan steps without a model pass through with the full planner arriving in Phase 8", async () => {
    const { engine } = makeEngine([new FakeAgent("a")]);
    const run = await engine.run(
      { id: "p", steps: [{ id: "plan", kind: "plan" }] },
      { objective: "x" },
    );
    expect(run.status).toBe("completed");
  });

  it("persists runs so they can be inspected later", async () => {
    const stores = tmpStores();
    const { engine } = makeEngine([new FakeAgent("a")], undefined, stores);
    await engine.run({ id: "p", steps: [{ id: "s", kind: "collect" }] }, { objective: "persist me" });
    const listed = await stores.runs.list({ pipelineId: "p" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("completed");
    expect(await stores.runs.get(listed[0]!.id)).toBeDefined();
  });
});
