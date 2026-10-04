import { describe, expect, it } from "vitest";
import { FileTaskStore } from "../src/tasks/store.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import type { IAgent, AgentInfo, AgentTaskInput, AgentTaskOutput } from "../src/types/agent.js";
import type { RoleDefinition } from "../src/types/role.js";
import type { TaskStore } from "../src/tasks/store.js";

class FakeAgent implements IAgent {
  info: AgentInfo = { name: "fake", integration: "process", status: "ready" };
  readonly received: AgentTaskInput[] = [];
  readonly cancelled: string[] = [];

  constructor(
    private readonly outcome: Partial<AgentTaskOutput> = {},
    private readonly throws?: Error,
  ) {}

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    this.received.push(input);
    if (this.throws) throw this.throws;
    return {
      taskId: input.taskId,
      status: "completed",
      summary: "fake ok",
      ...this.outcome,
    };
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
}

const role: RoleDefinition = {
  id: "planner",
  name: "Planner",
  responsibilities: ["plan things"],
  expectedOutputs: ["a plan"],
};

function makeEngine(agent: IAgent, store: TaskStore): TaskEngine {
  const agents = new AgentRegistry();
  agents.register(agent);
  const roles = new RoleRegistry();
  roles.register(role);
  return new TaskEngine({ agents, roles, store });
}

describe("FileTaskStore", () => {
  it("saves, gets, updates and lists tasks", async () => {
    const store = new FileTaskStore("/tmp/omninode-store-test-1");
    const now = new Date().toISOString();
    await store.save({
      id: "task-1",
      objective: "first",
      status: "created",
      createdAt: now,
      updatedAt: now,
      project: "p",
    });
    await store.save({
      id: "task-2",
      objective: "second",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      project: "p",
    });

    expect((await store.get("task-1"))?.objective).toBe("first");
    expect(await store.get("nope")).toBeUndefined();

    const first = (await store.get("task-1"))!;
    await store.save({ ...first, status: "completed" });
    expect((await store.get("task-1"))?.status).toBe("completed");
    expect(await store.list()).toHaveLength(2);
    expect(await store.list({ status: "queued" }).then((t) => t.map((x) => x.id))).toEqual(["task-2"]);
    expect(await store.list({ status: "failed" })).toHaveLength(0);
  });

  it("returns an empty list when nothing is stored", async () => {
    const store = new FileTaskStore("/tmp/omninode-store-test-empty");
    expect(await store.list()).toEqual([]);
  });
});

describe("TaskEngine", () => {
  it("creates tasks with defaults and validates assignments", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-1");
    const engine = makeEngine(new FakeAgent(), store);

    const task = await engine.create({ objective: "  audit the repo  ", project: "Remembra", agent: "fake" });
    expect(task.status).toBe("created");
    expect(task.objective).toBe("audit the repo");
    expect(task.id).toMatch(/^task-/);

    await expect(engine.create({ objective: "" })).rejects.toMatchObject({ code: "TASK_INVALID" });
    await expect(engine.create({ objective: "x", role: "ghost-role" })).rejects.toMatchObject({
      code: "TASK_INVALID",
      message: expect.stringContaining("ghost-role"),
    });
    await expect(engine.create({ objective: "x", agent: "ghost-agent" })).rejects.toMatchObject({
      code: "TASK_INVALID",
      message: expect.stringContaining("ghost-agent"),
    });
  });

  it("runs a task through the agent, passing the assigned role", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-2");
    const agent = new FakeAgent({ summary: "structured summary", reports: [{ id: "r1", taskId: "x", agent: "fake", summary: "s", findings: [], recommendations: [], createdAt: new Date().toISOString() }] });
    const engine = makeEngine(agent, store);

    const created = await engine.create({ objective: "plan the audit", role: "planner", agent: "fake" });
    const finished = await engine.run(created.id);

    expect(finished.status).toBe("completed");
    expect(finished.result?.summary).toBe("structured summary");
    expect(finished.result?.finishedAt).toBeDefined();
    expect(finished.result?.reports).toHaveLength(1);
    // Role assignment reached the agent input.
    expect(agent.received[0]?.role).toMatchObject({ id: "planner", name: "Planner" });
  });

  it("marks the task failed when the agent reports failure", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-3");
    const agent = new FakeAgent({ status: "failed", error: "agent blew up" });
    const engine = makeEngine(agent, store);
    const created = await engine.create({ objective: "x", agent: "fake" });
    const finished = await engine.run(created.id);
    expect(finished.status).toBe("failed");
    expect(finished.result?.error).toBe("agent blew up");
  });

  it("marks the task failed when the agent adapter throws", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-4");
    const agent = new FakeAgent({}, new Error("timed out"));
    const engine = makeEngine(agent, store);
    const created = await engine.create({ objective: "x", agent: "fake" });
    const finished = await engine.run(created.id);
    expect(finished.status).toBe("failed");
    expect(finished.result?.error).toContain("timed out");
  });

  it("enforces lifecycle transitions", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-5");
    const engine = makeEngine(new FakeAgent(), store);
    const created = await engine.create({ objective: "x", agent: "fake" });

    const queued = await engine.queue(created.id);
    expect(queued.status).toBe("queued");

    const finished = await engine.run(queued.id);
    expect(finished.status).toBe("completed");

    // completed is terminal
    await expect(engine.run(finished.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
    await expect(engine.cancel(finished.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
  });

  it("cancels tasks and notifies the agent", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-6");
    const agent = new FakeAgent();
    const engine = makeEngine(agent, store);
    const created = await engine.create({ objective: "x", agent: "fake" });
    const cancelled = await engine.cancel(created.id);
    expect(cancelled.status).toBe("cancelled");
    expect(agent.cancelled).toEqual([created.id]);
  });

  it("refuses to run a task without an agent", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-7");
    const engine = makeEngine(new FakeAgent(), store);
    const created = await engine.create({ objective: "x" });
    await expect(engine.run(created.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
  });

  it("raises TASK_NOT_FOUND for unknown ids", async () => {
    const store = new FileTaskStore("/tmp/omninode-engine-test-8");
    const engine = makeEngine(new FakeAgent(), store);
    await expect(engine.run("task-nope")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

class FlakyTaskAgent implements IAgent {
  info: AgentInfo = { name: "flaky", integration: "process", status: "ready" };
  fail = true;

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    if (this.fail) {
      return { taskId: input.taskId, status: "failed", error: "transient failure" };
    }
    return { taskId: input.taskId, status: "completed", summary: "recovered on retry" };
  }

  async cancel(): Promise<void> {}
}

describe("TaskEngine error recovery", () => {
  it("retry resets a failed task to created and it can run again", async () => {
    const store = new FileTaskStore("/tmp/omninode-retry-test-1");
    const agent = new FlakyTaskAgent();
    const engine = makeEngine(agent, store);

    const created = await engine.create({ objective: "flaky objective", agent: "flaky" });
    const failed = await engine.run(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.result?.error).toContain("transient");

    const reset = await engine.retry(created.id);
    expect(reset.status).toBe("created");
    expect(reset.result).toBeUndefined();
    expect(reset.objective).toBe("flaky objective");
    expect(reset.id).toBe(created.id);

    agent.fail = false;
    const finished = await engine.run(created.id);
    expect(finished.status).toBe("completed");
    expect(finished.result?.summary).toBe("recovered on retry");
  });

  it("retry also works for cancelled tasks, but not for completed ones", async () => {
    const store = new FileTaskStore("/tmp/omninode-retry-test-2");
    const engine = makeEngine(new FakeAgent(), store);
    const created = await engine.create({ objective: "x", agent: "fake" });
    await engine.cancel(created.id);
    expect((await engine.retry(created.id)).status).toBe("created");

    const second = await engine.create({ objective: "y", agent: "fake" });
    await engine.run(second.id);
    await expect(engine.retry(second.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
  });
});
