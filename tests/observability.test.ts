/**
 * v2 Phase 14 tests — Audit & Observability (roadmap §18): correlated audit
 * events, provider-error auditing, JSON log format, and inspect diagnostics.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAuditLog, type AuditEvent } from "../src/audit/index.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { HeuristicPlanner } from "../src/planner/heuristic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import { Logger } from "../src/logger/index.js";
import { createProgram } from "../src/cli/index.js";
import type { AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-obs-"));
}

class ScriptAgent implements IAgent {
  info: AgentInfo = { name: "worker", integration: "process", status: "ready" };
  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    return { taskId: input.taskId, status: "completed", summary: "done" };
  }
  async cancel(): Promise<void> {}
}

describe("correlated audit events (§18)", () => {
  it("task lifecycle events carry task, agent, pipeline and execution ids", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    const agents = new AgentRegistry();
    agents.register(new ScriptAgent());
    const engine = new TaskEngine({
      agents,
      roles: new RoleRegistry(),
      store: new FileTaskStore(dir),
      audit,
    });

    const created = await engine.create({
      objective: "audit auth",
      agent: "worker",
      pipelineId: "run-42",
      project: "demo",
    });
    await engine.run(created.id);

    const events = await audit.recent(50);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("task.created");
    expect(actions).toContain("agent.started");
    expect(actions).toContain("agent.completed");
    expect(actions).toContain("task.completed");

    const started = events.find((e) => e.action === "agent.started")!;
    expect(started.taskId).toBe(created.id);
    expect(started.agentId).toBe("worker");
    expect(started.pipelineId).toBe("run-42");
    expect(started.executionId).toMatch(/^exec-/);
    expect(started.detail).toMatchObject({ attempt: 1 });

    const createdEvent = events.find((e) => e.action === "task.created")!;
    expect(createdEvent.project).toBe("demo");
    expect(createdEvent.pipelineId).toBe("run-42");
    rmSync(dir, { recursive: true, force: true });
  });

  it("pipeline runs emit started/finished (or failed/cancelled) with the pipeline id", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    const agents = new AgentRegistry();
    agents.register(new ScriptAgent());
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir), audit });
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
      planner: new HeuristicPlanner(),
      audit,
    });

    await engine.run(
      { id: "flow", steps: [{ id: "do", kind: "execute", agent: "worker" }] },
      { objective: "fix it" },
    );

    const events = await audit.recent(50);
    const started = events.find((e) => e.action === "pipeline.run.started")!;
    const finished = events.find((e) => e.action === "pipeline.run.finished")!;
    expect(started.pipelineId).toBe("flow");
    expect(finished.pipelineId).toBe("flow");
    expect(finished.detail).toMatchObject({ status: "completed" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("providers record provider.error with the normalized kind", async () => {
    const dir = tmp();
    const events: AuditEvent[] = [];
    const provider = new OpenAICompatibleProvider(
      { name: "gw", type: "openai-compatible", baseUrl: "https://gw.test/v1" },
      undefined,
      {},
      { record: async (event) => { events.push(event); } },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })),
    );
    await expect(provider.listModels()).rejects.toBeDefined();
    const errorEvent = events.find((e) => e.action === "provider.error")!;
    expect(errorEvent.providerId).toBe("gw");
    expect(errorEvent.detail).toMatchObject({ operation: "listModels", kind: "RATE_LIMIT_ERROR" });
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("structured logs (§18)", () => {
  it("json format emits machine-readable lines", () => {
    const lines: string[] = [];
    const log = new Logger({
      format: "json",
      level: "info",
      sink: { write: (_level, line) => lines.push(line) },
    }).child({ component: "test" });
    log.info("hello", { taskId: "t1" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: "info", message: "hello", component: "test", taskId: "t1" });
    expect(typeof parsed.at).toBe("string");
  });

  it("text format stays human-readable by default", () => {
    const lines: string[] = [];
    const log = new Logger({ sink: { write: (_level, line) => lines.push(line) } });
    log.warn("careful");
    expect(lines[0]).toContain("WARN careful");
  });
});

describe("CLI inspect diagnostics (§18)", () => {
  let workDir: string;
  let previousCwd: string;

  beforeEach(() => {
    workDir = tmp();
    previousCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("task inspect shows executions and results; --json emits the record", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker", "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('done')",
    ]);
    await createProgram().parseAsync(["node", "omninode", "task", "create", "audit", "--agent", "worker"]);
    const tasks = JSON.parse(
      (await import("node:fs")).readFileSync(path.join(workDir, ".omninode/tasks.json"), "utf8"),
    ) as { items: Array<{ id: string }> };
    const taskId = tasks.items[0]!.id;

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "task", "run", taskId]);
    log.mockClear();

    await createProgram().parseAsync(["node", "omninode", "task", "inspect", taskId]);
    const output = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain(`Task ${taskId}`);
    expect(output).toContain("agent:     worker");
    expect(output).toContain("executions:");
    expect(output).toMatch(/#1 completed \(exec-/);
  }, 20_000);

  it("pipeline inspect lists steps and artifacts", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker", "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('done')",
    ]);
    const configPath = path.join(workDir, "omninode.yaml");
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "roles: []",
        "roles: []\n\n  pipelines:\n    - id: flow\n      steps:\n        - id: do\n          kind: execute\n          agent: worker",
      ),
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "pipeline", "run", "flow", "do the thing"]);
    log.mockClear();
    const runs = JSON.parse(readFileSync(path.join(workDir, ".omninode/pipelines.json"), "utf8")) as {
      items: Array<{ id: string }>;
    };

    await createProgram().parseAsync(["node", "omninode", "pipeline", "inspect", runs.items[0]!.id]);
    const output = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain("steps:");
    expect(output).toContain("do");
    expect(output).toMatch(/do\s+completed/);
  }, 20_000);

  it("agent and provider inspect report effective configuration", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "isolated", "--command", "node", "--env-policy", "explicit",
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "agent", "inspect", "isolated"]);
    expect(log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n")).toContain("env policy:  explicit");
    log.mockClear();

    await createProgram().parseAsync([
      "node", "omninode", "provider", "add", "--name", "gw",
      "--base-url", "https://gw.test/v1", "--api-key-env-var", "GW_KEY",
    ]);
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw"]);
    const output = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain("auth:          bearer ($GW_KEY)");
    expect(output).toContain("credentials:");
  });
});
