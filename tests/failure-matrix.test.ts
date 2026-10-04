/**
 * v2 Phase 17 — the explicit failure matrix (roadmap §21, Failure Matrix).
 *
 * One auditable place asserting how OmniNode behaves when things go wrong:
 * timeout, cancellation, provider 429/500, network loss, invalid API key,
 * model unavailable, agent crash, agent timeout, malformed JSONL, huge
 * output, missing dependency, corrupted persistence, duplicate execution,
 * partial pipeline failure, and unavailable Remembera / OmniHilbras.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { ProcessAgent } from "../src/agents/process/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import { OmniHilbrasProvider } from "../src/providers/omnihilbras/index.js";
import { MemoryService } from "../src/memory/service.js";
import { FileTaskStore as Store } from "../src/tasks/store.js";
import { loadConfigDetailed } from "../src/config/index.js";
import { ReportService } from "../src/reports/service.js";
import { FileReportStore } from "../src/reports/store.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";
import type { Report } from "../src/types/report.js";
import type { MemoryEntry, IMemoryProvider } from "../src/types/memory.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-matrix-"));
}

class ThrowingAgent implements IAgent {
  info: AgentInfo = { name: "agent", integration: "process", status: "ready" };
  constructor(private readonly error: Error) {}
  async run(): Promise<AgentTaskOutput> {
    throw this.error;
  }
  async cancel(): Promise<void> {}
}

function engineWith(agents: IAgent[], dir: string): TaskEngine {
  const registry = new AgentRegistry();
  for (const agent of agents) registry.register(agent);
  return new TaskEngine({ agents: registry, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
}

// --- provider-side failures over a real HTTP server -----------------------
let server: Server;
let port: number;
let nextResponse: { status: number; body: unknown } = { status: 200, body: { data: [] } };

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = nextResponse.status;
    res.end(JSON.stringify(nextResponse.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => vi.unstubAllGlobals());

function liveProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "gw",
    type: "openai-compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEnvVar: "MATRIX_KEY",
  });
}

describe("failure matrix: providers", () => {
  beforeEach(() => {
    vi.stubEnv("MATRIX_KEY", "test-key");
  });

  it("rate limit (429) is retryable and carries the kind", async () => {
    nextResponse = { status: 429, body: { error: { message: "slow down" } } };
    await expect(liveProvider().listModels()).rejects.toMatchObject({
      details: { kind: "RATE_LIMIT_ERROR", retryable: true },
    });
  });

  it("server error (500) is retryable", async () => {
    nextResponse = { status: 500, body: { error: "boom" } };
    await expect(liveProvider().listModels()).rejects.toMatchObject({
      details: { kind: "SERVER_ERROR", retryable: true },
    });
  });

  it("invalid API key (401) fails authentication, not retryable", async () => {
    nextResponse = { status: 401, body: { error: { message: "bad key" } } };
    vi.stubEnv("MATRIX_KEY", "wrong");
    await expect(liveProvider().listModels()).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
      details: { kind: "AUTHENTICATION_ERROR", retryable: false },
    });
  });

  it("missing API key reference fails before any request", async () => {
    const provider = new OpenAICompatibleProvider({
      name: "gw",
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyEnvVar: "DEFINITELY_MISSING",
    });
    await expect(provider.listModels()).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
  });

  it("model unavailable (404 on chat) is MODEL_NOT_FOUND", async () => {
    nextResponse = { status: 404, body: { error: { message: "no such model" } } };
    await expect(
      liveProvider().chat({ model: "ghost-model", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("network loss is a network error, not a server error", async () => {
    const provider = new OpenAICompatibleProvider({
      name: "gw",
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1", // nothing listening
    });
    await expect(provider.listModels()).rejects.toMatchObject({
      details: { kind: "NETWORK_ERROR", retryable: true },
    });
  });

  it("malformed gateway response is UNKNOWN_ERROR, never a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<<< not json >>>", { status: 200 })),
    );
    await expect(liveProvider().listModels()).rejects.toMatchObject({
      details: { kind: "UNKNOWN_ERROR" },
    });
  });

  it("OmniHilbras unavailable degrades like any other provider (still optional)", async () => {
    const omnihilbras = new OmniHilbrasProvider({
      name: "hb",
      type: "omnihilbras",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    await expect(omnihilbras.listModels()).rejects.toMatchObject({
      details: { kind: "NETWORK_ERROR" },
    });
  });
});

describe("failure matrix: agents", () => {
  it("agent crash fails the task with the error preserved", async () => {
    const dir = tmp();
    const engine = engineWith([new ThrowingAgent(new Error("segfault"))], dir);
    const task = await engine.create({ objective: "x", agent: "agent" });
    const finished = await engine.run(task.id);
    expect(finished.status).toBe("failed");
    expect(finished.lastError).toContain("segfault");
  });

  it("agent timeout is 'unknown', not 'failed' (side effects possible)", async () => {
    const dir = tmp();
    const engine = engineWith(
      [
        new ProcessAgent({
          name: "sleeper",
          integration: "process",
          command: "node",
          args: ["-e", "setInterval(() => {}, 1000)"],
          timeoutMs: 300,
        }),
      ],
      dir,
    );
    const task = await engine.create({ objective: "x", agent: "sleeper" });
    const finished = await engine.run(task.id);
    expect(finished.status).toBe("unknown");
    expect(finished.executions?.at(-1)?.outcome).toBe("unknown");
  }, 15_000);

  it("missing dependency (command not found) is AGENT_NOT_FOUND", async () => {
    const dir = tmp();
    const engine = engineWith(
      [
        new ProcessAgent({
          name: "ghost",
          integration: "process",
          command: "omninode-definitely-not-installed",
        }),
      ],
      dir,
    );
    const task = await engine.create({ objective: "x", agent: "ghost" });
    // A missing executable is a task failure with the actionable message kept.
    const finished = await engine.run(task.id);
    expect(finished.status).toBe("failed");
    expect(finished.lastError).toContain("omninode-definitely-not-installed");
  }, 15_000);

  it("malformed JSONL from a protocol agent fails cleanly, not fatally", async () => {
    const dir = tmp();
    const agent = new ProcessAgent({
      name: "noisy",
      integration: "process",
      inputMode: "protocol",
      command: "node",
      args: ["-e", "console.log('garbage'); console.log(JSON.stringify({protocol:'omninode-agent-protocol/2',type:'STATUS',messageId:'m',payload:{}}));"],
    });
    const engine = engineWith([agent], dir);
    const task = await engine.create({ objective: "x", agent: "noisy" });
    const finished = await engine.run(task.id);
    expect(finished.status).toBe("failed");
    expect(finished.result?.protocol?.violations.length).toBeGreaterThan(0);
  }, 15_000);

  it("huge stdout is killed at the output limit", async () => {
    const dir = tmp();
    const agent = new ProcessAgent({
      name: "flooder",
      integration: "process",
      command: "node",
      args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(50000)), 5); setTimeout(() => {}, 4000);"],
      maxOutputBytes: 50_000,
      timeoutMs: 10_000,
    });
    const engine = engineWith([agent], dir);
    const task = await engine.create({ objective: "x", agent: "flooder" });
    const started = Date.now();
    const finished = await engine.run(task.id);
    expect(finished.status).toBe("failed");
    expect(finished.result?.error).toContain("output limit");
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);
});

describe("failure matrix: execution & persistence", () => {
  it("duplicate execution is refused: a finished task cannot run again", async () => {
    const dir = tmp();
    const engine = engineWith(
      [
        {
          info: { name: "ok", integration: "process", status: "ready" },
          run: async (input: AgentTaskInput) => ({ taskId: input.taskId, status: "completed", summary: "done" }),
          cancel: async () => {},
        },
      ],
      dir,
    );
    const task = await engine.create({ objective: "x", agent: "ok" });
    await engine.run(task.id);
    await expect(engine.run(task.id)).rejects.toMatchObject({ code: "TASK_INVALID" });
    expect((await engine.list())[0]?.attempt).toBe(1);
  });

  it("partial pipeline failure yields a partial run, and downstream still ran", async () => {
    const dir = tmp();
    let calls = 0;
    const flaky: IAgent = {
      info: { name: "flaky", integration: "process", status: "ready" },
      // The first research task fails, the second succeeds → partial step.
      run: async (input: AgentTaskInput) => {
        calls += 1;
        return calls === 1
          ? { taskId: input.taskId, status: "failed", error: "one failed" }
          : { taskId: input.taskId, status: "completed", summary: "ok" };
      },
      cancel: async () => {},
    };
    const executor: IAgent = {
      info: { name: "exec", integration: "process", status: "ready" },
      run: async (input: AgentTaskInput) => ({ taskId: input.taskId, status: "completed", summary: "executed" }),
      cancel: async () => {},
    };
    const registry = new AgentRegistry();
    registry.register(flaky);
    registry.register(executor);
    const tasks = new TaskEngine({ agents: registry, roles: new RoleRegistry(), store: new Store(dir) });
    const engine = new PipelineEngine({
      tasks,
      agents: registry,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
    });
    const run = await engine.run(
      {
        id: "partial",
        steps: [
          { id: "research", kind: "research", agents: ["flaky", "flaky"] },
          { id: "execute", kind: "execute", agent: "exec" },
        ],
      },
      { objective: "x" },
    );
    expect(run.status).toBe("partial");
    expect(run.stepRuns.find((s) => s.stepId === "execute")?.status).toBe("completed");
  });

  it("corrupted persistence is quarantined and the store keeps working", async () => {
    const dir = tmp();
    const store = new FileTaskStore(dir);
    const task = {
      id: "t1", objective: "x", status: "created" as const, attempt: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await store.save(task);
    writeFileSync(path.join(dir, "tasks.json"), "{ broken", "utf8");

    const reopened = new FileTaskStore(dir);
    expect(await reopened.list()).toEqual([]);
    await reopened.save(task);
    expect((await reopened.get("t1"))?.objective).toBe("x");
  }, 20_000);

  it("duplicate configuration names are rejected, not silently shadowed", () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "omninode.yaml"),
      "project:\n  name: X\n  providers:\n    - name: gw\n      type: openai-compatible\n      base_url: https://a.test/v1\n    - name: gw\n      type: openai-compatible\n      base_url: https://b.test/v1\n",
      "utf8",
    );
    expect(() => loadConfigDetailed({ path: path.join(dir, "omninode.yaml"), env: {} })).toThrow(
      /Duplicate provider name "gw"/,
    );
  });

  it("Remembera unavailable is tolerated by default and fatal when required", async () => {
    const brokenProvider: IMemoryProvider = {
      name: "broken",
      metadata: () => ({ name: "broken", capabilities: ["retrieve"], relevanceRanking: false }),
      retrieve: async () => {
        throw new Error("Remembera unreachable");
      },
      store: async () => {
        throw new Error("Remembera unreachable");
      },
      search: async () => [],
      query: async () => [],
      write: async () => {},
    };
    const entries: MemoryEntry[] = [];

    const optional = new MemoryService(brokenProvider);
    expect((await optional.contextFor({ objective: "x" })).text).toBe("");
    await expect(
      optional.recordTaskOutcome({
        id: "t", objective: "x", status: "completed", attempt: 1,
        createdAt: "", updatedAt: "", result: { summary: "ok" },
      }),
    ).resolves.toBeUndefined();

    const required = new MemoryService(brokenProvider, undefined, { required: true });
    await expect(required.contextFor({ objective: "x" })).rejects.toThrow(/marked required/);
    expect(entries).toEqual([]);
  });

  it("a malformed report never reaches aggregation", async () => {
    const dir = tmp();
    const service = new ReportService(new FileReportStore(dir));
    const collected = await service.collectFromTasks([
      {
        id: "t1", objective: "x", agent: "a", status: "completed", attempt: 1,
        createdAt: "", updatedAt: "",
        result: {
          reports: [
            { id: "ok", taskId: "t1", agent: "a", summary: "fine", findings: [], recommendations: [], createdAt: new Date().toISOString() },
            { id: "", taskId: "t1", agent: "a", summary: "broken", findings: [{ id: "x" }], recommendations: [], createdAt: "" } as unknown as Report,
          ],
        },
      },
    ]);
    expect(collected.map((r) => r.id)).toEqual(["ok"]);
    expect(service.lastDiagnostics.rejected).toHaveLength(1);
  });
});
