/**
 * v2 Phase 5 tests — Pipeline Lifecycle (roadmap §9): cancellation (§9.2),
 * attempt bookkeeping (§9.1), validation hardening (§9.5) and interrupted-run
 * recovery awareness (§9.6).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { AgentError } from "../src/errors/index.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-pipelifecycle-"));
}

/** An agent that takes a while and can be cancelled mid-run. */
class SlowAgent implements IAgent {
  info: AgentInfo;
  readonly cancelledTasks: string[] = [];
  private gate?: () => void;

  constructor(private readonly ms = 300, name = "slow") {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    await new Promise<void>((resolve) => {
      this.gate = resolve;
      setTimeout(resolve, this.ms);
    });
    return { taskId: input.taskId, status: "completed", summary: `${this.info.name} finished` };
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelledTasks.push(taskId);
    this.gate?.();
  }
}

function makeEngine(agents: IAgent[], providers: Array<{ name: string; type: "openai-compatible"; baseUrl: string }> = []) {
  const dir = tmp();
  const registry = new AgentRegistry();
  for (const agent of agents) registry.register(agent);
  const tasks = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
  const engine = new PipelineEngine({
    tasks,
    agents: registry,
    roles: new RoleRegistry(),
    providers,
    store: new FilePipelineRunStore(dir),
  });
  return { engine, tasks };
}

describe("pipeline cancellation (§9.2)", () => {
  it("stops scheduling, cancels running tasks and persists cancelled state", async () => {
    const slow = new SlowAgent(300, "slow");
    const second = new SlowAgent(300, "second");
    const { engine } = makeEngine([slow, second]);

    const running = engine.run(
      {
        id: "cancel-me",
        steps: [
          { id: "first", kind: "analyze", agent: "slow" },
          { id: "second", kind: "analyze", agent: "slow" },
        ],
      },
      { objective: "long job" },
    );

    // Let the first step start, then cancel the run.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await engine.cancel((await engine.listRuns({ pipelineId: "cancel-me" }))[0]!.id);

    const run = await running;
    expect(run.status).toBe("cancelled");
    expect(run.cancellationRequested).toBe(true);
    expect(run.cancellationRequestedAt).toBeDefined();
    // Running task was told to cancel.
    expect(slow.cancelledTasks.length).toBeGreaterThan(0);
  }, 20_000);

  it("cancelling an unknown run raises PIPELINE_NOT_FOUND", async () => {
    const { engine } = makeEngine([]);
    await expect(engine.cancel("run-nope")).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  });

  it("a run not executing locally still records the cancellation request", async () => {
    const { engine } = makeEngine([new SlowAgent(10)]);
    const runs = engine.store;
    // Persist a run that no process owns.
    await runs.save({
      id: "run-external", pipelineId: "p", attempt: 1, status: "running",
      startedAt: new Date().toISOString(), stepRuns: [],
    });
    await engine.cancel("run-external");
    expect((await runs.get("run-external"))?.cancellationRequested).toBe(true);
  });
});

describe("attempt bookkeeping (§9.1)", () => {
  it("step runs record which attempt produced them", async () => {
    let calls = 0;
    const flaky: IAgent = {
      info: { name: "flaky", integration: "process", status: "ready" },
      async run(input) {
        calls += 1;
        if (calls === 1) throw new AgentError("AGENT_FAILED", "first attempt fails");
        return { taskId: input.taskId, status: "completed", summary: "second attempt wins" };
      },
      async cancel() {},
    };
    const { engine } = makeEngine([flaky]);
    const run = await engine.run(
      { id: "retries", steps: [{ id: "work", kind: "analyze", agent: "flaky", retries: 1 }] },
      { objective: "retry me" },
    );
    expect(run.status).toBe("completed");
    expect(run.stepRuns[0]?.attempt).toBe(2);
  }, 15_000);

  it("runs record attempt number and per-attempt history", async () => {
    const { engine } = makeEngine([new SlowAgent(10)]);
    const run = await engine.run(
      { id: "history", steps: [{ id: "work", kind: "analyze", agent: "slow" }] },
      { objective: "x" },
    );
    expect(run.attempt).toBe(1);
    expect(run.attempts?.at(-1)).toMatchObject({ attempt: 1, status: "completed" });
  }, 15_000);
});

describe("validation hardening (§9.5)", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["unknown dependency", { id: "p", steps: [{ id: "a", kind: "collect", dependsOn: ["ghost"] }] }, /unknown step/],
    ["duplicate step ids", { id: "p", steps: [{ id: "a", kind: "collect" }, { id: "a", kind: "plan" }] }, /Duplicate/],
    ["cycle", { id: "p", steps: [{ id: "a", kind: "collect", dependsOn: ["b"] }, { id: "b", kind: "collect", dependsOn: ["a"] }] }, /cycle/],
    ["research without agents", { id: "p", steps: [{ id: "r", kind: "research" }] }, /at least one agent/],
    ["execute without agent", { id: "p", steps: [{ id: "e", kind: "execute" }] }, /needs an agent/],
  ];

  it.each(cases)("rejects %s", (_name, def, pattern) => {
    const { engine } = makeEngine([]);
    expect(() => engine.validate(def as never)).toThrow(pattern);
  });

  it("rejects unregistered agents at run time, before any step executes", async () => {
    const { engine } = makeEngine([]);
    await expect(
      engine.run({ id: "p", steps: [{ id: "a", kind: "analyze", agent: "ghost" }] }, { objective: "x" }),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID", message: expect.stringContaining("ghost") });
  });

  it("rejects plan steps whose model provider is not configured", async () => {
    const { engine } = makeEngine([], []);
    await expect(
      engine.run(
        { id: "p", steps: [{ id: "plan", kind: "plan", model: "missing-provider:model-x" }] },
        { objective: "x" },
      ),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID", message: expect.stringContaining("missing-provider") });
  });

  it("accepts a valid definition", () => {
    const { engine } = makeEngine([]);
    expect(() =>
      engine.validate({ id: "ok", steps: [{ id: "research", kind: "research", agents: ["a"] }, { id: "plan", kind: "plan" }] }),
    ).not.toThrow();
  });
});

describe("interrupted-run recovery awareness (§9.6)", () => {
  it("a run persisted as running with no finishedAt is understood as interrupted", async () => {
    const dir = tmp();
    const runs = new FilePipelineRunStore(dir);
    await runs.save({
      id: "run-stale", pipelineId: "p", attempt: 1, status: "running",
      startedAt: new Date().toISOString(), stepRuns: [],
    });
    const found = await runs.get("run-stale");
    expect(found?.status).toBe("running");
    expect(found?.finishedAt).toBeUndefined(); // interrupted: retry is the recovery path
    rmSync(dir, { recursive: true, force: true });
  });
});