/**
 * v3 audit M1 — task and pipeline state integrity.
 *
 * Five defects:
 *   1. a step that threw left the pipeline run persisted as `running`
 *      forever, with no `finishedAt` and a leaked `activeRuns` entry;
 *   2. two concurrent `TaskEngine.run()` calls both executed the agent;
 *   3. `cancel()` wrote a stale snapshot, destroying the in-flight attempt's
 *      result and execution history;
 *   4. the failure path overwrote a concurrent cancellation, resurrecting a
 *      cancelled task as `failed`/`unknown`;
 *   5. a memory write-back failure made `run()` reject after the task had
 *      already succeeded.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { AgentError } from "../src/errors/index.js";
import type { MemoryService } from "../src/memory/index.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";
import type { Task } from "../src/types/task.js";
import type { TaskStore } from "../src/tasks/store.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-state-"));
}

class CountingAgent implements IAgent {
  info: AgentInfo;
  runs = 0;
  private readonly gate: (() => void) | undefined;

  constructor(
    private readonly onRun?: (call: number) => Promise<void> | void,
    name = "counting",
  ) {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    this.runs += 1;
    await this.onRun?.(this.runs);
    return { taskId: input.taskId, status: "completed", summary: "done" };
  }

  async cancel(): Promise<void> {}
}

/** A task store whose `save` fails for one specific status, to simulate a
 *  write that breaks mid-run. */
class ThrowingTaskStore implements TaskStore {
  constructor(
    private readonly inner: TaskStore,
    private readonly shouldThrow: (task: Task) => boolean,
  ) {}

  async save(task: Task): Promise<void> {
    if (this.shouldThrow(task)) {
      throw new Error("simulated store write failure");
    }
    return this.inner.save(task);
  }

  get(id: string): Promise<Task | undefined> {
    return this.inner.get(id);
  }

  list(filter?: Parameters<TaskStore["list"]>[0]): Promise<Task[]> {
    return this.inner.list(filter);
  }
}

/** The two memory hooks the task engine uses. */
type MemoryHooks = Pick<MemoryService, "gatherContext" | "recordTaskOutcome">;

function taskEngineFor(agent: IAgent, extra: { memory?: MemoryHooks } = {}): TaskEngine {
  const registry = new AgentRegistry();
  registry.register(agent);
  return new TaskEngine({
    agents: registry,
    roles: new RoleRegistry(),
    store: new FileTaskStore(tmp()),
    ...(extra.memory ? { memory: extra.memory as MemoryService } : {}),
  });
}

describe("M1.1 — a step that throws leaves the run in a terminal state", () => {
  it("records the run as failed with a finishedAt instead of leaving it running", async () => {
    const dir = tmp();
    const registry = new AgentRegistry();
    const agent = new CountingAgent(undefined, "worker");
    registry.register(agent);

    // The store rejects the task record, so the step throws inside the engine.
    const taskStore = new ThrowingTaskStore(new FileTaskStore(dir), (task) => task.status === "created");
    const tasks = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store: taskStore });
    const runStore = new FilePipelineRunStore(dir);
    const engine = new PipelineEngine({
      tasks,
      agents: registry,
      roles: new RoleRegistry(),
      providers: [],
      store: runStore,
    });

    const run = await engine.run(
      { id: "p", steps: [{ id: "only", kind: "analyze", agent: "worker" }] },
      { objective: "work" },
    );

    expect(run.status).toBe("failed");
    expect(run.finishedAt).toBeDefined();
    expect(run.stepRuns[0]?.status).toBe("failed");
    expect(run.stepRuns[0]?.error).toContain("simulated store write failure");

    // The persisted run must not still be `running`.
    const persisted = await runStore.get(run.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.finishedAt).toBeDefined();
  });

  it("releases the active run so a failed run can be cancelled and re-run", async () => {
    const dir = tmp();
    const registry = new AgentRegistry();
    registry.register(new CountingAgent(undefined, "worker"));
    const taskStore = new ThrowingTaskStore(new FileTaskStore(dir), (task) => task.status === "created");
    const tasks = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store: taskStore });
    const engine = new PipelineEngine({
      tasks,
      agents: registry,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
    });

    const run = await engine.run(
      { id: "p", steps: [{ id: "only", kind: "analyze", agent: "worker" }] },
      { objective: "work" },
    );

    // Cancelling a finished run must not hang or throw an unexpected error:
    // the run is no longer active, so cancellation is a no-op on the live
    // tasks but the record is still updated.
    await expect(engine.cancel(run.id)).resolves.toBeUndefined();
  });
});

describe("M1.2 — a task cannot be run twice at once", () => {
  it("executes the agent exactly once for two concurrent run() calls", async () => {
    const agent = new CountingAgent();
    const engine = taskEngineFor(agent);
    const task = await engine.create({ objective: "work", agent: "counting" });

    // Two concurrent runs of the same task. Which of the two promises wins
    // the race is not deterministic (the store reads resolve in arbitrary
    // order), so the assertion is on the observable outcome: the agent runs
    // exactly once and the other call is refused.
    const outcomes = await Promise.allSettled([engine.run(task.id), engine.run(task.id)]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "TASK_INVALID" });
    expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("completed");
    expect(agent.runs).toBe(1);
  });

  it("refuses a second run while the first is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new CountingAgent(async () => {
      await gate;
    });
    const engine = taskEngineFor(agent);
    const task = await engine.create({ objective: "work", agent: "counting" });

    const first = engine.run(task.id);
    // Wait until the agent is actually executing, so the first run provably
    // holds the task.
    while (agent.runs === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(engine.run(task.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
    release();
    const result = await first;
    expect(result.status).toBe("completed");
    expect(agent.runs).toBe(1);
  });
});

describe("M1.3 — cancelling a running task keeps the attempt's history", () => {
  it("keeps the execution history of the in-flight attempt", async () => {
    const dir = tmp();
    const registry = new AgentRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: IAgent = {
      info: { name: "slow", integration: "process", status: "ready" },
      runs: 0,
      async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
        this.runs += 1;
        await gate;
        return { taskId: input.taskId, status: "completed", summary: "late result" };
      },
      async cancel(): Promise<void> {
        release();
      },
    } as IAgent & { runs: number };
    registry.register(agent);

    const store = new FileTaskStore(dir);
    const engine = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store });

    const task = await engine.create({ objective: "work", agent: "slow" });
    const running = engine.run(task.id);
    // Let the run reach the agent before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelled = await engine.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");

    await running.catch(() => undefined);

    const persisted = await store.get(task.id);
    expect(persisted?.status).toBe("cancelled");
    // The attempt that was in flight must not have been erased.
    expect(persisted?.executions?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("M1.4 — a cancellation is not overwritten by a failure", () => {
  it("keeps the task cancelled when the agent fails after the cancellation", async () => {
    const dir = tmp();
    const registry = new AgentRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: IAgent = {
      info: { name: "slow", integration: "process", status: "ready" },
      async run(_input: AgentTaskInput): Promise<AgentTaskOutput> {
        await gate;
        throw new AgentError("AGENT_FAILED", "the agent blew up after the cancellation");
      },
      async cancel(): Promise<void> {
        release();
      },
    };
    registry.register(agent);

    const store = new FileTaskStore(dir);
    const engine = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store });

    const task = await engine.create({ objective: "work", agent: "slow" });
    const running = engine.run(task.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await engine.cancel(task.id);
    await running.catch(() => undefined);

    const persisted = await store.get(task.id);
    expect(persisted?.status).toBe("cancelled");
  });
});

describe("M1.5 — the memory write-back is best-effort", () => {
  it("resolves with the completed task when the memory backend throws", async () => {
    const agent = new CountingAgent();
    const engine = taskEngineFor(agent, {
      memory: {
        gatherContext: async () => "",
        recordTaskOutcome: async () => {
          throw new Error("memory backend is down");
        },
      },
    });
    const task = await engine.create({ objective: "work", agent: "counting" });

    // The task succeeded — the caller must not see an exception.
    const result = await engine.run(task.id);
    expect(result.status).toBe("completed");
  });

  it("resolves with the failed task when the memory backend throws on the failure path", async () => {
    const failing: IAgent = {
      info: { name: "boom", integration: "process", status: "ready" },
      async run(_input: AgentTaskInput): Promise<AgentTaskOutput> {
        throw new AgentError("AGENT_FAILED", "nope");
      },
      async cancel(): Promise<void> {},
    };
    const engine = taskEngineFor(failing, {
      memory: {
        gatherContext: async () => "",
        recordTaskOutcome: async () => {
          throw new Error("memory backend is down");
        },
      },
    });
    const task = await engine.create({ objective: "work", agent: "boom" });

    const result = await engine.run(task.id);
    expect(result.status).toBe("failed");
  });
});
