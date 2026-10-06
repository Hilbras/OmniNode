/**
 * v2.0.3 Fix 02 — audit failure isolation.
 *
 * A broken (throwing) audit sink must be purely observational: every execution
 * path keeps its real outcome. Success stays success, failure stays failure,
 * retry/cancel/recover/pipeline behave correctly, audit errors are logged, and
 * no task state is corrupted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore, type TaskStore } from "../src/tasks/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FilePipelineRunStore, type PipelineRunStore } from "../src/pipelines/store.js";
import { FilePlanStore, type PlanStore } from "../src/planner/store.js";
import { Logger } from "../src/logger/index.js";
import type { AuditSink, AuditEvent } from "../src/audit/index.js";
import type { IAgent, AgentInfo, AgentTaskInput, AgentTaskOutput } from "../src/types/agent.js";
import type { PipelineDefinition } from "../src/types/pipeline.js";

class FakeAgent implements IAgent {
  info: AgentInfo;
  constructor(name: string, private readonly outcome: Partial<AgentTaskOutput> = {}) {
    this.info = { name, integration: "process", status: "ready" };
  }
  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    return { taskId: input.taskId, status: "completed", summary: "ok", ...this.outcome };
  }
  async cancel(): Promise<void> {}
}

class ThrowingSink implements AuditSink {
  recorded: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.recorded.push(event);
    throw new Error(`audit sink broken (${event.action})`);
  }
}

/** Logger that captures emitted lines so we can assert audit failures were logged. */
function capturingLogger(): { log: Logger; lines: () => string[] } {
  const lines: string[] = [];
  const log = new Logger({ level: "debug", sink: { write: (_level, line) => void lines.push(line) } });
  return { log, lines: () => lines };
}

function tmpStores(): { tasks: TaskStore; runs: PipelineRunStore; plans: PlanStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-audit-"));
  return {
    tasks: new FileTaskStore(dir),
    runs: new FilePipelineRunStore(dir),
    plans: new FilePlanStore(dir),
  };
}

function makeTaskEngine(agent: IAgent, store: TaskStore, audit?: AuditSink, log?: Logger): TaskEngine {
  const agents = new AgentRegistry();
  agents.register(agent);
  const roles = new RoleRegistry();
  roles.register({ id: "planner", name: "Planner", responsibilities: [], expectedOutputs: [] });
  return new TaskEngine({ agents, roles, store, ...(audit ? { audit } : {}), ...(log ? { log } : {}) });
}

function makePipelineEngine(
  agent: IAgent,
  stores: { tasks: TaskStore; runs: PipelineRunStore; plans: PlanStore },
  audit?: AuditSink,
  log?: Logger,
): { engine: PipelineEngine; tasks: TaskEngine } {
  const agents = new AgentRegistry();
  agents.register(agent);
  const roles = new RoleRegistry();
  roles.register({ id: "planner", name: "Planner", responsibilities: [], expectedOutputs: [] });
  const tasks = makeTaskEngine(agent, stores.tasks, audit, log);
  const engine = new PipelineEngine({
    tasks,
    agents,
    roles,
    providers: [{ name: "gw", type: "openai-compatible", baseUrl: "http://gw.test" }],
    store: stores.runs,
    plans: stores.plans,
    ...(audit ? { audit } : {}),
    ...(log ? { log } : {}),
  });
  return { engine, tasks };
}

const pipelineDef: PipelineDefinition = {
  id: "p",
  role: "planner",
  steps: [{ id: "e", kind: "execute", agent: "a" }],
};

describe("Fix 02: audit isolation in task execution", () => {
  it("keeps a successful task successful and logs the audit failure", async () => {
    const sink = new ThrowingSink();
    const { log, lines } = capturingLogger();
    const engine = makeTaskEngine(new FakeAgent("a"), tmpStores().tasks, sink, log);

    const task = await engine.create({ objective: "do it", agent: "a" });
    const result = await engine.run(task.id);

    expect(result.status).toBe("completed");
    // The audit path ran for every transition despite the sink throwing.
    expect(sink.recorded.some((e) => e.action === "agent.started")).toBe(true);
    expect(sink.recorded.some((e) => e.action === "agent.completed")).toBe(true);
    // Errors were logged, not swallowed silently.
    expect(lines().join("\n")).toContain("Audit write failed");
  });

  it("keeps a failed task failed", async () => {
    const failingAgent = {
      info: { name: "bad", integration: "process", status: "ready" } satisfies AgentInfo,
      run: async (): Promise<AgentTaskOutput> => ({ taskId: "t", status: "failed", error: "boom" }),
      cancel: async () => undefined,
    } satisfies IAgent;
    const { log } = capturingLogger();
    const engine = makeTaskEngine(failingAgent, tmpStores().tasks, new ThrowingSink(), log);

    const task = await engine.create({ objective: "do it", agent: "bad" });
    const result = await engine.run(task.id);

    expect(result.status).toBe("failed");
    expect(result.result?.error).toBe("boom");
  });

  it("keeps retry behavior correct", async () => {
    const { log } = capturingLogger();
    const engine = makeTaskEngine(
      new FakeAgent("a", { status: "failed", error: "flaky" }),
      tmpStores().tasks,
      new ThrowingSink(),
      log,
    );
    const task = await engine.create({ objective: "do it", agent: "a" });
    const failed = await engine.run(task.id);
    expect(failed.status).toBe("failed");

    const reset = await engine.retry(task.id);
    expect(reset.status).toBe("created");
    expect(reset.lastResult?.error).toBe("flaky"); // history preserved
  });

  it("keeps cancellation and recovery correct", async () => {
    const { log } = capturingLogger();
    const engine = makeTaskEngine(new FakeAgent("a"), tmpStores().tasks, new ThrowingSink(), log);
    const task = await engine.create({ objective: "do it", agent: "a" });
    await engine.queue(task.id);
    const cancelled = await engine.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");

    // Simulate a stale running task, then recover it.
    await engine.store.save({ ...cancelled, status: "running", lastError: undefined });
    const recovered = await engine.recoverStaleTasks();
    expect(recovered[0]?.status).toBe("unknown");
  });
});

describe("Fix 02: audit isolation in pipeline execution", () => {
  it("keeps pipeline success correct and logs audit failures", async () => {
    const sink = new ThrowingSink();
    const { log, lines } = capturingLogger();
    const stores = tmpStores();
    const { engine } = makePipelineEngine(new FakeAgent("a"), stores, sink, log);

    const run = await engine.run(pipelineDef, { objective: "go" });
    expect(run.status).toBe("completed");
    expect(sink.recorded.some((e) => e.action === "pipeline.run.finished")).toBe(true);
    expect(lines().join("\n")).toContain("Audit write failed");
  });

  it("keeps a pipeline coherent when a cancellation is requested under a broken sink", async () => {
    const sink = new ThrowingSink();
    const { log } = capturingLogger();
    const stores = tmpStores();
    const { engine } = makePipelineEngine(new FakeAgent("a"), stores, sink, log);

    const run = await engine.run(pipelineDef, { objective: "go" });
    expect(run.status).toBe("completed");

    await engine.cancel(run.id);
    const after = await engine.get(run.id);
    expect(after?.cancellationRequested).toBe(true);
    expect(after?.status).toBe("completed"); // state not corrupted by the broken sink
    expect(sink.recorded.length).toBeGreaterThan(0);
  });
});
