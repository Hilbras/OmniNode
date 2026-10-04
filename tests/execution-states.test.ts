/**
 * v2 Phase 2 failure matrix: execution states, unknown-state semantics,
 * retry safety, execution identity and partial fan-out (roadmap §6, §17).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { AgentError, ProtocolError } from "../src/errors/index.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import type { Report } from "../src/types/report.js";
import type { AgentInfo, AgentTaskOutput, IAgent } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-exec-"));
}

class ScriptedAgent implements IAgent {
  info: AgentInfo;
  runs = 0;

  constructor(
    private readonly script: (call: number) => Promise<AgentTaskOutput> | AgentTaskOutput,
    name = "scripted",
  ) {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(): Promise<AgentTaskOutput> {
    this.runs += 1;
    return this.script(this.runs);
  }

  async cancel(): Promise<void> {}
}

function engineFor(agent: IAgent): TaskEngine {
  const dir = tmp();
  const agents = new AgentRegistry();
  agents.register(agent);
  return new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
}

describe("execution states — timeout is not failure (§6.3)", () => {
  it("a dispatched timeout lands in unknown, with the attempt recorded", async () => {
    const agent = new ScriptedAgent((call) => {
      if (call === 1) {
        throw new AgentError("AGENT_TIMEOUT", "timed out after 300ms and was killed.", {
          details: { operation: "agent.run", agent: "scripted", durationMs: 300, dispatched: true },
        });
      }
      return { taskId: "t", status: "completed", summary: "completed on a fresh attempt" };
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "side-effecting work", agent: "scripted" });

    const timedOut = await engine.run(task.id);
    expect(timedOut.status).toBe("unknown");
    expect(timedOut.lastError).toContain("timed out");
    expect(timedOut.attempt).toBe(1);
    expect(timedOut.executions?.[0]).toMatchObject({
      attempt: 1,
      outcome: "unknown",
    });
    expect(timedOut.executions?.[0]?.executionId).toMatch(/^exec-/);

    // Explicit resolution: retry starts a NEW execution (attempt 2) with its own id.
    const resolved = await engine.retry(task.id);
    expect(resolved.status).toBe("created");
    const done = await engine.run(task.id);
    expect(done.status).toBe("completed");
    expect(done.attempt).toBe(2);
    expect(done.executions?.at(-1)).toMatchObject({ attempt: 2, outcome: "completed" });
  });

  it("a timeout raised before dispatch is timed_out, not unknown", async () => {
    const agent = new ScriptedAgent(() => {
      throw new AgentError("AGENT_TIMEOUT", "connection timed out before dispatch.", {
        details: { dispatched: false, durationMs: 1000 },
      });
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "never started", agent: "scripted" });
    const result = await engine.run(task.id);
    expect(result.status).toBe("timed_out");
  });

  it("protocol violations are ordinary failures", async () => {
    const agent = new ScriptedAgent(() => {
      throw new ProtocolError("agent produced no protocol messages");
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "bad protocol", agent: "scripted" });
    const result = await engine.run(task.id);
    expect(result.status).toBe("failed");
    expect(result.executions?.at(-1)?.outcome).toBe("failed");
  });
});

describe("retry safety (§6.4)", () => {
  it("retries retryable failures up to maxAttempts and succeeds", async () => {
    const agent = new ScriptedAgent((call) => {
      if (call <= 2) throw new AgentError("AGENT_FAILED", "agent crashed");
      return { taskId: "t", status: "completed", summary: "recovered" };
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "flaky agent", agent: "scripted" });

    const result = await engine.run(task.id, { maxAttempts: 3 });
    expect(result.status).toBe("completed");
    expect(agent.runs).toBe(3);
    expect(result.attempt).toBe(3);
    expect(result.executions?.map((e) => e.outcome)).toEqual(["failed", "failed", "completed"]);
  });

  it("gives up after maxAttempts and keeps every attempt in the history", async () => {
    const agent = new ScriptedAgent(() => {
      throw new AgentError("AGENT_FAILED", "always crashes");
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "doomed", agent: "scripted" });
    const result = await engine.run(task.id, { maxAttempts: 2 });
    expect(result.status).toBe("failed");
    expect(result.executions).toHaveLength(2);
    expect(result.lastError).toContain("always crashes");
  });

  it("never auto-retries an unknown outcome (side effects may have happened)", async () => {
    const agent = new ScriptedAgent(() => {
      throw new AgentError("AGENT_TIMEOUT", "killed after dispatch", {
        details: { dispatched: true },
      });
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "side effects", agent: "scripted" });
    const result = await engine.run(task.id, { maxAttempts: 5 });
    expect(result.status).toBe("unknown");
    expect(agent.runs).toBe(1);
  });

  it("bounded execution history", async () => {
    const agent = new ScriptedAgent((call) => {
      if (call <= 11) throw new AgentError("AGENT_FAILED", "crash");
      return { taskId: "t", status: "completed", summary: "ok" };
    });
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "many attempts", agent: "scripted" });
    const result = await engine.run(task.id, { maxAttempts: 12 });
    expect(result.status).toBe("completed");
    expect(result.executions!.length).toBeLessThanOrEqual(10);
  });
});

describe("strict state machine (§6.2)", () => {
  it("rejects running terminal states and running an already-run task", async () => {
    const agent = new ScriptedAgent(() => ({ taskId: "t", status: "completed", summary: "ok" }));
    const engine = engineFor(agent);
    const task = await engine.create({ objective: "once", agent: "scripted" });
    await engine.run(task.id);
    await expect(engine.run(task.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
    await expect(engine.cancel(task.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
    await expect(engine.retry(task.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
  });

  it("retry is allowed from unknown and timed_out", async () => {
    for (const code of ["AGENT_TIMEOUT", "AGENT_FAILED"] as const) {
      const agent = new ScriptedAgent(() => {
        throw new AgentError(code, "boom", {
          ...(code === "AGENT_TIMEOUT" ? { details: { dispatched: true } } : {}),
        });
      });
      const engine = engineFor(agent);
      const task = await engine.create({ objective: "recoverable", agent: "scripted" });
      const first = await engine.run(task.id);
      const retried = await engine.retry(task.id);
      expect(["unknown", "timed_out", "failed"]).toContain(first.status);
      expect(retried.status).toBe("created");
    }
  });
});
// --- pipeline-level propagation (§9.3) -------------------------------------

class MixedOutcomeAgent implements IAgent {
  info: AgentInfo = { name: "mixed", integration: "process", status: "ready" };
  calls = 0;

  async run(): Promise<AgentTaskOutput> {
    this.calls += 1;
    // First agent: unknown outcome (timeout after dispatch). Second: succeeds.
    if (this.calls === 1) {
      throw new AgentError("AGENT_TIMEOUT", "killed after dispatch", {
        details: { dispatched: true },
      });
    }
    const report: Report = {
      id: `rep-${this.calls}`,
      taskId: "t",
      agent: "mixed",
      summary: "second opinion",
      findings: [],
      recommendations: [],
      createdAt: new Date().toISOString(),
    };
    return { taskId: "t", status: "completed", summary: "second opinion done", reports: [report] };
  }

  async cancel(): Promise<void> {}
}

describe("pipeline partial propagation (§9.3)", () => {
  it("a fan-out with one unknown agent yields a partial run, not a failed one, and downstream still runs", async () => {
    const dir = tmp();
    const agent = new MixedOutcomeAgent();
    const agents = new AgentRegistry();
    agents.register(agent);
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
    const executed: string[] = [];
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
    });

    const run = await engine.run(
      {
        id: "partial-pipeline",
        steps: [
          { id: "research", kind: "research", agents: ["mixed", "mixed"] },
          { id: "execute", kind: "execute", agent: "mixed" },
        ],
      },
      { objective: "mixed outcomes" },
    );

    expect(run.status).toBe("partial");
    const research = run.stepRuns.find((s) => s.stepId === "research");
    expect(research?.status).toBe("partially_completed");
    // Downstream work still ran — a partial dependency carries real output.
    expect(run.stepRuns.find((s) => s.stepId === "execute")).toBeDefined();
    void executed;
  });

  it("a hard failure still fails the run and skips on-success downstream steps", async () => {
    const dir = tmp();
    const failing = new ScriptedAgent(() => {
      throw new AgentError("AGENT_FAILED", "hard crash");
    }, "failing");
    const executor = new ScriptedAgent(
      () => ({ taskId: "t", status: "completed", summary: "ok" }),
      "executor",
    );
    const agents = new AgentRegistry();
    agents.register(failing);
    agents.register(executor);
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
    });

    const run = await engine.run(
      {
        id: "failing-pipeline",
        steps: [
          { id: "research", kind: "research", agents: ["failing"] },
          { id: "execute", kind: "execute", agent: "executor" },
        ],
      },
      { objective: "fails" },
    );
    expect(run.status).toBe("failed");
    expect(executor.runs).toBe(0); // downstream skipped
  });
});
