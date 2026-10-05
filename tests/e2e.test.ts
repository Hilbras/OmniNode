/**
 * End-to-end workflow test (§28): User → OmniNode → project context → memory →
 * research agents → reports → aggregation → planner → implementation plan →
 * execution agent → result — plus error recovery, all through the real CLI.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import type { Task } from "../src/types/task.js";

let workDir: string;
let previousCwd: string;
let server: Server;
let port: number;

const PLAN_JSON = JSON.stringify({
  goal: "harden the authentication module",
  summary: "Final analysis: authentication weaknesses require prioritized fixes.",
  steps: [
    {
      id: "s1",
      title: "Add signature verification",
      order: 1,
      targets: ["src/auth/verify.ts"],
      acceptance_criteria: ["unsigned tokens rejected"],
    },
    { id: "s2", title: "Add regression tests", order: 2, depends_on: ["s1"] },
  ],
  risks: ["test coverage gap in auth"],
});

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: PLAN_JSON }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        );
      });
      return;
    }
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-e2e-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof capture>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function readStore<T>(file: string): T[] {
  const path_ = path.join(workDir, ".omninode", file);
  if (!existsSync(path_)) return [];
  const parsed = JSON.parse(readFileSync(path_, "utf8")) as T[] | { items: T[] };
  return Array.isArray(parsed) ? parsed : parsed.items;
}

const ECHO_SCRIPT = (marker: string) =>
  `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('${marker}\\n'+b))`;

async function setupProject(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init", "--name", "E2E"]);
  await createProgram().parseAsync([
    "node", "omninode", "provider", "add",
    "--name", "gw", "--type", "openai-compatible",
    "--base-url", `http://127.0.0.1:${port}/v1`,
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "researcher1",
    "--command", "node", "--arg=-e", `--arg=${ECHO_SCRIPT("R1")}`,
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "researcher2",
    "--command", "node", "--arg=-e", `--arg=${ECHO_SCRIPT("R2")}`,
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "executor",
    "--command", "node", "--arg=-e", "--arg=process.stdout.write('EXECUTION DONE')",
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "flaky",
    "--command", "node", "--arg=-e",
    "--arg=process.exit(require('fs').existsSync('FAIL') ? 1 : 0)",
  ]);

  const configPath = path.join(workDir, "omninode.yaml");
  const raw = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    raw.replace(
      "roles: []",
      `roles:
    - id: security-reviewer
      name: Security Reviewer
      responsibilities:
        - find vulnerabilities

  memory:
    provider: local

  planner:
    kind: model
    model: gw:gpt-test

  pipelines:
    - id: audit
      name: Auth audit
      steps:
        - id: research
          kind: research
          agents: [researcher1, researcher2]
        - id: plan
          kind: plan
          model: gw:gpt-test
        - id: execute
          kind: execute
          agent: executor
    - id: broken
      steps:
        - id: execute
          kind: execute
          agent: flaky`,
    ),
    "utf8",
  );
}

describe("End-to-end workflow (§28)", () => {
  it("runs User → memory → research → reports → plan → execution → result", async () => {
    await setupProject();

    // The single-command workflow (top-level `run` alias).
    let log = capture();
    await createProgram().parseAsync([
      "node", "omninode", "run", "audit", "audit the authentication module",
    ]);
    const runOutput = outputOf(log);
    expect(runOutput).toContain("[research] completed");
    expect(runOutput).toContain("[plan] completed");
    expect(runOutput).toContain("[execute] completed");
    expect(runOutput).toContain("combined report: combined-");
    expect(runOutput).toContain("plan: plan-");
    expect(runOutput).toContain("result: EXECUTION DONE");
    expect(runOutput).toContain("Pipeline completed");

    // Every stage persisted its state.
    const tasks = readStore<Task>("tasks.json");
    expect(tasks.filter((t) => t.status === "completed")).toHaveLength(3);

    const reports = readStore<{ kind: string }>("reports.json");
    const raw = reports.filter((r) => r.kind === "report");
    const combined = reports.filter((r) => r.kind === "combined");
    expect(raw).toHaveLength(2);
    expect(combined).toHaveLength(1);

    const plans = readStore<{ id: string; steps: unknown[]; risks?: string[] }>("plans.json");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.steps).toHaveLength(2);

    // Outcomes were written to memory.
    const memory = readStore<{ scope: string; content: string }>("memory.json");
    expect(memory.filter((m) => m.scope === "task").length).toBeGreaterThanOrEqual(2);

    // The plan is inspectable.
    const planMatch = /plan-[a-z0-9-]+/.exec(runOutput);
    expect(planMatch).not.toBeNull();
    const planId = planMatch![0];
    log = capture();
    await createProgram().parseAsync(["node", "omninode", "plan", "show", planId]);
    const planOutput = outputOf(log);
    expect(planOutput).toContain("Add signature verification");
    expect(planOutput).toContain("src/auth/verify.ts");
    expect(planOutput).toContain("unsigned tokens rejected");
    expect(planOutput).toContain("test coverage gap in auth");

    // Project state overview.
    log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    const statusOutput = outputOf(log);
    expect(statusOutput).toContain('project "E2E"');
    expect(statusOutput).toContain("tasks:     3 (completed 3)");
    expect(statusOutput).toContain("runs:      1 (completed 1)");
    expect(statusOutput).toContain("reports:   2 raw, 1 combined");
    expect(statusOutput).toContain("plans:     1");
    expect(statusOutput).toContain("memory:    local");

    // Memory injection: a second run of the same objective sees the first run's outcomes.
    log = capture();
    await createProgram().parseAsync([
      "node", "omninode", "run", "audit", "audit the authentication module",
    ]);
    expect(outputOf(log)).toContain("Pipeline completed");

    const allTasks = readStore<Task>("tasks.json");
    const researcherRuns = allTasks
      .filter((t) => t.agent === "researcher1")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(researcherRuns).toHaveLength(2);
    const secondRunResearch = researcherRuns[1];
    expect(secondRunResearch?.result?.rawOutput).toContain("Relevant memory (task)");
    expect(secondRunResearch?.result?.rawOutput).toContain("audit the authentication module");
  }, 30_000);
});

describe("Error recovery (§27 Phase 9)", () => {
  it("task retry re-runs a failed task after the cause is fixed", async () => {
    await setupProject();
    const previousExit = process.exitCode;
    capture();
    await createProgram().parseAsync([
      "node", "omninode", "task", "create", "flaky work", "--agent", "flaky",
    ]);
    const tasks = readStore<Task>("tasks.json");
    const taskId = tasks[0]!.id;

    writeFileSync(path.join(workDir, "FAIL"), "");
    let log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "run", taskId]);
    let output = outputOf(log);
    expect(output).toContain("status:  failed");

    rmSync(path.join(workDir, "FAIL"));
    log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "retry", taskId, "--run"]);
    output = outputOf(log);
    expect(output).toContain('reset to "created"');
    expect(output).toContain("status:  completed");
    // Restore the exit code the intentionally-failed run set.
    process.exitCode = previousExit;
  });

  it("pipeline retry re-runs a recorded failed run", async () => {
    await setupProject();
    writeFileSync(path.join(workDir, "FAIL"), "");
    const previousExit = process.exitCode;
    let log = capture();
    await createProgram().parseAsync(["node", "omninode", "run", "broken", "do the broken thing"]);
    const firstRun = outputOf(log);
    expect(firstRun).toContain("Pipeline failed");
    const failedRunId = /run-[a-z0-9-]+/.exec(firstRun)?.[0];

    rmSync(path.join(workDir, "FAIL"));
    log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "retry", failedRunId!]);
    const retryOutput = outputOf(log);
    expect(retryOutput).toContain("Pipeline completed");
    expect(retryOutput).toContain("do the broken thing");

    // Both runs are recorded.
    log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "runs", "broken"]);
    const runsOutput = outputOf(log);
    expect(runsOutput).toContain("failed");
    expect(runsOutput).toContain("completed");
    process.exitCode = previousExit;
  });
});