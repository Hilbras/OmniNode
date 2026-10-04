import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalMemoryProvider } from "../src/memory/local.js";
import { MemoryService } from "../src/memory/service.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import type { IAgent, AgentInfo, AgentTaskInput, AgentTaskOutput } from "../src/types/agent.js";

class CapturingAgent implements IAgent {
  info: AgentInfo;
  readonly received: AgentTaskInput[] = [];

  constructor(name: string) {
    this.info = { name, integration: "process", status: "ready" };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    this.received.push(input);
    return { taskId: input.taskId, status: "completed", summary: `${this.info.name} finished the objective` };
  }

  async cancel(): Promise<void> {}
}

function makeEngineWithMemory(agent: IAgent): { engine: TaskEngine; memory: MemoryService; provider: LocalMemoryProvider } {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-memeng-"));
  const provider = new LocalMemoryProvider(dir);
  const memory = new MemoryService(provider);
  const agents = new AgentRegistry();
  agents.register(agent);
  const roles = new RoleRegistry();
  roles.register({ id: "planner", name: "Planner", responsibilities: [], expectedOutputs: [] });
  const engine = new TaskEngine({ agents, roles, store: new FileTaskStore(dir), memory });
  return { engine, memory, provider };
}

describe("TaskEngine memory integration (§20)", () => {
  it("injects relevant memory into the agent's context", async () => {
    const agent = new CapturingAgent("worker");
    const { engine, provider } = makeEngineWithMemory(agent);

    // Seed memory with an entry relevant to the objective, and an irrelevant one.
    await provider.write({
      key: "known:auth",
      scope: "project",
      content: "Known problem: the authentication module has a failing rate limiter",
      tags: ["known-problem"],
    });
    await provider.write({
      key: "note:deploy",
      scope: "project",
      content: "Deployment uses blue-green releases",
    });

    await engine.create({ objective: "fix the authentication module rate limiter", agent: "worker" });
    const tasks = await engine.list();
    const finished = await engine.run(tasks[0]!.id);

    expect(finished.status).toBe("completed");
    expect(agent.received[0]?.context).toContain("Relevant memory (project)");
    expect(agent.received[0]?.context).toContain("rate limiter");
    expect(agent.received[0]?.context).not.toContain("blue-green");
  });

  it("records task outcomes back into memory", async () => {
    const agent = new CapturingAgent("worker");
    const { engine, provider } = makeEngineWithMemory(agent);
    await engine.create({ objective: "audit the repository structure", agent: "worker" });
    const tasks = await engine.list();
    await engine.run(tasks[0]!.id);

    const entries = await provider.query({ text: "audit repository" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe("task");
    expect(entries[0]?.content).toContain("audit the repository structure");
    expect(entries[0]?.content).toContain("worker finished the objective");
  });

  it("persists high-severity findings as known problems", async () => {
    const agent: IAgent = {
      info: { name: "scanner", integration: "process", status: "ready" },
      async run(input) {
        return {
          taskId: input.taskId,
          status: "completed",
          summary: "scan done",
          reports: [
            {
              id: `${input.taskId}-report`,
              taskId: input.taskId,
              agent: "scanner",
              summary: "scan done",
              findings: [
                { id: "f1", title: "Broken JWT validation", detail: "tokens accepted unsigned", severity: "critical" },
                { id: "f2", title: "Cosmetic typo in footer", detail: "typo" },
              ],
              recommendations: [],
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
      async cancel() {},
    };
    const { engine, provider } = makeEngineWithMemory(agent);
    await engine.create({ objective: "scan the authentication code for vulnerabilities", agent: "scanner" });
    const tasks = await engine.list();
    await engine.run(tasks[0]!.id);

    const known = await provider.query({ text: "broken jwt validation vulnerability", scope: "project" });
    expect(known).toHaveLength(1);
    expect(known[0]?.tags).toContain("known-problem");
    expect(known[0]?.content).toContain("[critical] Broken JWT validation");
    // Low-severity findings are not promoted to project memory.
    expect(await provider.query({ text: "cosmetic typo footer", scope: "project" })).toEqual([]);
  });

  it("continues without memory when the provider fails (best-effort)", async () => {
    const agent = new CapturingAgent("worker");
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-memfail-"));
    const failingProvider = new LocalMemoryProvider(dir);
    failingProvider.query = async () => {
      throw new Error("disk exploded");
    };
    const memory = new MemoryService(failingProvider);
    const agents = new AgentRegistry();
    agents.register(agent);
    const roles = new RoleRegistry();
    const engine = new TaskEngine({ agents, roles, store: new FileTaskStore(dir), memory });

    await engine.create({ objective: "anything", agent: "worker" });
    const tasks = await engine.list();
    const finished = await engine.run(tasks[0]!.id);
    expect(finished.status).toBe("completed");
    expect(agent.received[0]?.context).toBeUndefined();
  });
});
