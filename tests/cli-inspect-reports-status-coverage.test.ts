/**
 * Coverage for the diagnostic CLI commands (src/cli/commands/inspect.ts,
 * src/cli/commands/reports.ts, src/cli/commands/status.ts).
 *
 * These commands answer "what happened?" after the fact: they read the
 * persisted task, pipeline-run, report, combined-report and plan stores and
 * print either a human summary or the raw JSON record. The tests below drive
 * the real CLI (argv in, printed output and persisted records out) inside a
 * throwaway project directory, and assert on what the user actually sees.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { cliConfigOptions } from "../src/cli/options.js";
import { FilePlanStore } from "../src/planner/store.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { FileReportStore } from "../src/reports/store.js";
import { FileTaskStore } from "../src/tasks/store.js";
import type { CombinedReport, Report } from "../src/types/report.js";
import type { PipelineRun } from "../src/types/pipeline.js";
import type { Task } from "../src/types/task.js";
import type { Plan } from "../src/types/plan.js";

let workDir: string;
let previousCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-diag-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
  // Keep the loader away from the developer's own environment and home config.
  for (const key of [
    "OMNINODE_USER_CONFIG",
    "OMNINODE_PROFILE",
    "OMNINODE_LOG_LEVEL",
    "OMNINODE_LOG_FORMAT",
    "OMNINODE_MEMORY_PROVIDER",
    "OMNINODE_MEMORY_REQUIRED",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OMNINODE_USER_CONFIG = path.join(workDir, "no-user-config.yaml");
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  cliConfigOptions.path = undefined;
  cliConfigOptions.profile = undefined;
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof capture>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

/** The `omninode.yaml` of the throwaway project. */
function configPath(): string {
  return path.join(workDir, "omninode.yaml");
}

/** Writes a project file with the given YAML body (no schema validation). */
function writeConfig(body: string): void {
  writeFileSync(configPath(), body, "utf8");
}

/** A minimal but valid project configuration. */
function baseConfig(extra = ""): string {
  return `project:
  name: Diag
  providers: []
  agents: []
  roles: []
  pipelines: []
${extra}`;
}

async function initProject(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init", "--name", "Diag"]);
}

// ---------------------------------------------------------------------------
// Store fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    objective: "Audit the auth module",
    status: "completed",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    attempt: 0,
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "report-1",
    taskId: "task-1",
    agent: "worker",
    summary: "Everything looks fine",
    findings: [],
    recommendations: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCombined(overrides: Partial<CombinedReport> = {}): CombinedReport {
  return {
    id: "combined-1",
    title: "Combined report",
    taskIds: ["task-1"],
    summary: "1 report(s) from 1 agent",
    findings: [],
    agreements: [],
    conflicts: [],
    recommendations: [],
    sources: ["worker"],
    reportIds: ["report-1"],
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run-1",
    pipelineId: "audit",
    attempt: 1,
    status: "completed",
    startedAt: "2024-01-01T00:00:00.000Z",
    stepRuns: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    objective: "Fix the auth module",
    summary: "Three steps to fix auth",
    steps: [],
    generatedBy: "heuristic",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Persists a task into the project store. */
async function seedTask(task: Task): Promise<void> {
  await new FileTaskStore().save(task);
}

/** Persists a raw report into the project store. */
async function seedReport(report: Report): Promise<void> {
  await new FileReportStore().saveReports([report]);
}

/** Persists a combined report into the project store. */
async function seedCombined(combined: CombinedReport): Promise<void> {
  await new FileReportStore().saveCombined(combined);
}

/** Persists a pipeline run into the project store. */
async function seedRun(run: PipelineRun): Promise<void> {
  await new FilePipelineRunStore().save(run);
}

/** Persists a plan into the project store. */
async function seedPlan(plan: Plan): Promise<void> {
  await new FilePlanStore().save(plan);
}

// ---------------------------------------------------------------------------
// `omninode task inspect`
// ---------------------------------------------------------------------------

describe("task inspect", () => {
  it("prints the full task record for a known task", async () => {
    await initProject();
    await seedTask(
      makeTask({
        project: "Diag",
        pipelineId: "run-1",
        role: "reviewer",
        agent: "worker",
        attempt: 2,
        lastError: "exit code 1",
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "inspect", "task-1"]);
    const output = outputOf(log);

    expect(output).toContain("Task task-1");
    expect(output).toContain("status:    completed (attempt 2)");
    expect(output).toContain("project:   Diag");
    expect(output).toContain("pipeline:  run-1");
    expect(output).toContain("objective: Audit the auth module");
    expect(output).toContain("role:      reviewer");
    expect(output).toContain("agent:     worker");
    expect(output).toContain("created:   2024-01-01T00:00:00.000Z");
    expect(output).toContain("updated:   2024-01-02T00:00:00.000Z");
    expect(output).toContain("lastError: exit code 1");
  });

  it("omits the optional fields that are not set", async () => {
    await initProject();
    await seedTask(makeTask());

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "inspect", "task-1"]);
    const output = outputOf(log);

    expect(output).toContain("status:    completed");
    expect(output).not.toContain("(attempt");
    expect(output).not.toContain("project:");
    expect(output).not.toContain("pipeline:");
    expect(output).not.toContain("role:");
    expect(output).not.toContain("agent:");
    expect(output).not.toContain("lastError:");
    expect(output).not.toContain("executions:");
    expect(output).not.toContain("summary:");
    expect(output).not.toContain("reports:");
  });

  it("prints the execution history and the report references", async () => {
    await initProject();
    await seedTask(
      makeTask({
        attempt: 2,
        executions: [
          {
            executionId: "exec-1",
            attempt: 1,
            startedAt: "2024-01-01T00:00:00.000Z",
            finishedAt: "2024-01-01T00:01:00.000Z",
            outcome: "failed",
            error: "boom",
          },
          {
            executionId: "exec-2",
            attempt: 2,
            startedAt: "2024-01-01T00:02:00.000Z",
            finishedAt: "2024-01-01T00:03:00.000Z",
            outcome: "completed",
          },
        ],
        result: {
          summary: "The module was audited",
          reports: [
            {
              id: "report-1",
              taskId: "task-1",
              agent: "worker",
              summary: "Two issues found",
              findings: [
                { id: "f-1", title: "Hardcoded secret", detail: "A secret is in the source", severity: "high" },
                { id: "f-2", title: "Missing timeout", detail: "No timeout configured" },
              ],
              recommendations: [],
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "inspect", "task-1"]);
    const output = outputOf(log);

    expect(output).toContain("executions:");
    expect(output).toContain("#1 failed (exec-1) — boom");
    expect(output).toContain("#2 completed (exec-2)");
    expect(output).toContain("summary:   The module was audited");
    expect(output).toContain("reports:   1");
    expect(output).toContain("- [worker] Two issues found");
    expect(output).toContain("· [high] Hardcoded secret");
    // A finding without a severity falls back to "info".
    expect(output).toContain("· [info] Missing timeout");
  });

  it("emits the raw task record as JSON", async () => {
    await initProject();
    await seedTask(makeTask({ agent: "worker" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "inspect", "task-1", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as Task;

    expect(parsed.id).toBe("task-1");
    expect(parsed.objective).toBe("Audit the auth module");
    expect(parsed.status).toBe("completed");
    expect(outputOf(log)).not.toContain("objective:");
  });

  it("fails with TASK_NOT_FOUND for an unknown task id", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "task", "inspect", "task-ghost"]),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// `omninode pipeline inspect`
// ---------------------------------------------------------------------------

describe("pipeline inspect", () => {
  it("prints the run with its per-step status and artifact references", async () => {
    await initProject();
    await seedRun(
      makeRun({
        attempt: 2,
        objective: "audit the code",
        finishedAt: "2024-01-01T01:00:00.000Z",
        planId: "plan-1",
        combinedReportId: "combined-1",
        resultSummary: "All steps completed",
        stepRuns: [
          { stepId: "research", status: "completed", taskIds: ["task-1", "task-2"] },
          { stepId: "analyze", status: "failed", error: "provider timeout" },
          { stepId: "report", status: "completed" },
        ],
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "inspect", "run-1"]);
    const output = outputOf(log);

    expect(output).toContain("Pipeline run run-1  (audit)");
    expect(output).toContain("status:     completed (attempt 2)");
    expect(output).toContain("objective:  audit the code");
    expect(output).toContain("started:    2024-01-01T00:00:00.000Z");
    expect(output).toContain("finished:   2024-01-01T01:00:00.000Z");
    expect(output).toContain("plan:       plan-1");
    expect(output).toContain("combined:   combined-1");
    expect(output).toContain("result:     All steps completed");
    expect(output).toContain("steps:");
    expect(output).toContain("research       completed tasks=task-1,task-2");
    expect(output).toContain("analyze        failed — provider timeout");
    // A step without task ids prints no "tasks=" part.
    expect(output).toContain("report         completed");
    expect(output).not.toContain("report         completed tasks=");
  });

  it("shows a placeholder when the run has no start time and omits unset fields", async () => {
    await initProject();
    await seedRun(makeRun({ startedAt: undefined, attempt: 1 }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "inspect", "run-1"]);
    const output = outputOf(log);

    expect(output).toContain("started:    ?");
    expect(output).not.toContain("(attempt");
    expect(output).not.toContain("objective:");
    expect(output).not.toContain("finished:");
    expect(output).not.toContain("plan:");
    expect(output).not.toContain("combined:");
    expect(output).not.toContain("result:");
  });

  it("emits the raw run record as JSON", async () => {
    await initProject();
    await seedRun(makeRun({ objective: "audit the code" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "inspect", "run-1", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as PipelineRun;

    expect(parsed.id).toBe("run-1");
    expect(parsed.pipelineId).toBe("audit");
    expect(parsed.objective).toBe("audit the code");
  });

  it("fails with PIPELINE_NOT_FOUND for an unknown run id", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "inspect", "run-ghost"]),
    ).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// `omninode agent inspect`
// ---------------------------------------------------------------------------

describe("agent inspect", () => {
  it("prints the effective configuration and the recent tasks", async () => {
    writeConfig(`project:
  name: Diag
  providers: []
  agents:
    - name: worker
      type: cli
      command: node
      input_mode: arg
      cwd: /tmp
      timeout_ms: 1234
      max_output_bytes: 4096
      allow_external_cwd: true
      env_policy: explicit
  roles: []
  pipelines: []
`);
    await seedTask(
      makeTask({
        id: "task-1",
        agent: "worker",
        status: "completed",
        updatedAt: "2024-01-05T00:00:00.000Z",
      }),
    );
    await seedTask(
      makeTask({
        id: "task-2",
        agent: "other",
        status: "failed",
        updatedAt: "2024-01-06T00:00:00.000Z",
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "inspect", "worker"]);
    const output = outputOf(log);

    expect(output).toContain("Agent worker");
    expect(output).toContain("integration: process");
    expect(output).toContain("command:     node");
    expect(output).toContain("input mode:  arg");
    expect(output).toContain("env policy:  explicit");
    expect(output).toContain("working dir: /tmp");
    expect(output).toContain("timeout:     1234ms");
    expect(output).toContain("max output:  4096 bytes/stream");
    expect(output).toContain("external cwd allowed");
    // Only tasks of this agent are listed.
    expect(output).toContain("recent tasks: task-1:completed");
    expect(output).not.toContain("task-2");
  });

  it("falls back to placeholders when the agent has no command, input mode or tasks", async () => {
    writeConfig(`project:
  name: Diag
  providers: []
  agents:
    - name: worker
      type: cli
  roles: []
  pipelines: []
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "inspect", "worker"]);
    const output = outputOf(log);

    expect(output).toContain("command:     (none)");
    expect(output).toContain("input mode:  stdin");
    expect(output).toContain("env policy:  inherit");
    expect(output).not.toContain("working dir:");
    expect(output).not.toContain("timeout:");
    expect(output).not.toContain("max output:");
    expect(output).not.toContain("external cwd allowed");
    expect(output).toContain("recent tasks: (none)");
  });

  it("emits the configuration, the env policy and the recent tasks as JSON", async () => {
    writeConfig(`project:
  name: Diag
  providers: []
  agents:
    - name: worker
      type: cli
      command: node
  roles: []
  pipelines: []
`);
    await seedTask(makeTask({ id: "task-1", agent: "worker", status: "completed" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "inspect", "worker", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      config: { name: string };
      effective: { name: string; integration: string } | undefined;
      envPolicy: string;
      recentTasks: Array<{ id: string; status: string }>;
    };

    expect(parsed.config.name).toBe("worker");
    expect(parsed.effective?.integration).toBe("process");
    expect(parsed.envPolicy).toBe("inherit");
    expect(parsed.recentTasks).toEqual([{ id: "task-1", status: "completed", updatedAt: "2024-01-02T00:00:00.000Z" }]);
  });

  it("fails with AGENT_NOT_FOUND for an unconfigured agent", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "agent", "inspect", "ghost"]),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// `omninode provider inspect`
// ---------------------------------------------------------------------------

describe("provider inspect", () => {
  it("prints the provider id, the auth method and the configured state", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
      api_key_env_var: DIAG_KEY
  agents: []
  roles: []
  pipelines: []
`);
    process.env.DIAG_KEY = "secret-value";

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw"]);
    const output = outputOf(log);

    expect(output).toContain("Provider gw");
    expect(output).toContain("providerId:    gw");
    expect(output).toContain("type:          openai-compatible");
    expect(output).toContain("base URL:      https://example.com/v1");
    expect(output).toContain("auth:          bearer ($DIAG_KEY)");
    expect(output).toContain("credentials:   configured");
    // No capabilities declared for this provider.
    expect(output).not.toContain("capabilities:");
  });

  it("reports a missing credential and prints the declared capabilities", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
      api_key_env_var: DIAG_MISSING_KEY
  agents: []
  roles: []
  pipelines: []
`);
    delete process.env.DIAG_MISSING_KEY;

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw"]);
    const output = outputOf(log);

    expect(output).toContain("auth:          bearer ($DIAG_MISSING_KEY)");
    expect(output).toContain("credentials:   MISSING");
  });

  it("prints a keyless provider and its capabilities", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: local
      type: local
      base_url: http://127.0.0.1:11434/v1
  agents: []
  roles: []
  pipelines: []
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "local"]);
    const output = outputOf(log);

    expect(output).toContain("auth:          none");
    expect(output).toContain("credentials:   configured");
    expect(output).not.toContain("capabilities:");
  });

  it("emits the provider record and the role count as JSON", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
  agents: []
  roles:
    - id: reviewer
      name: Reviewer
    - id: auditor
      name: Auditor
  pipelines: []
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      config: { name: string };
      providerId: string;
      authentication: { method: string; configured: boolean };
      capabilities: string[];
      memoryConfigured: undefined;
      memoryEntries: undefined;
      roles: number;
    };

    expect(parsed.config.name).toBe("gw");
    expect(parsed.providerId).toBe("gw");
    expect(parsed.authentication.method).toBe("none");
    expect(parsed.authentication.configured).toBe(true);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.memoryConfigured).toBeUndefined();
    expect(parsed.memoryEntries).toBeUndefined();
    expect(parsed.roles).toBe(2);
  });

  it("reports the memory provider and its entry count", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
  agents: []
  roles: []
  pipelines: []
  memory:
    provider: local
    required: true
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      memoryConfigured: { provider: string; required: boolean } | undefined;
      memoryEntries: number | undefined;
    };

    expect(parsed.memoryConfigured).toEqual({ provider: "local", required: true });
    expect(parsed.memoryEntries).toBe(0);
  });

  it("treats a memory section without `required` as not required", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
  agents: []
  roles: []
  pipelines: []
  memory:
    provider: local
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "inspect", "gw", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      memoryConfigured: { provider: string; required: boolean } | undefined;
    };

    expect(parsed.memoryConfigured).toEqual({ provider: "local", required: false });
  });

  it("fails with PROVIDER_NOT_FOUND for an unconfigured provider", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "provider", "inspect", "ghost"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// `omninode report list`
// ---------------------------------------------------------------------------

describe("report list", () => {
  it("says so when no report is stored", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);
    expect(outputOf(log)).toContain("No reports stored yet. Run a pipeline to collect some.");
  });

  it("lists the stored reports", async () => {
    await initProject();
    await seedReport(makeReport({ id: "report-1", agent: "worker", summary: "Short summary" }));
    await seedReport(makeReport({ id: "report-2", agent: "helper", summary: "Other summary" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);
    const output = outputOf(log);

    expect(output).toContain("report-1");
    expect(output).toContain("worker");
    expect(output).toContain("Short summary");
    expect(output).toContain("report-2");
    expect(output).toContain("helper");
  });

  it("truncates a long summary to 60 characters with an ellipsis", async () => {
    await initProject();
    const longSummary = "x".repeat(80);
    await seedReport(makeReport({ id: "report-1", agent: "worker", summary: longSummary }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);
    const output = outputOf(log);

    expect(output).toContain("x".repeat(59) + "\u2026");
    expect(output).not.toContain("x".repeat(60));
  });

  it("filters the list by task and by agent", async () => {
    await initProject();
    await seedReport(makeReport({ id: "report-1", taskId: "task-1", agent: "worker" }));
    await seedReport(makeReport({ id: "report-2", taskId: "task-2", agent: "helper" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list", "--task", "task-1"]);
    const byTask = outputOf(log);
    expect(byTask).toContain("report-1");
    expect(byTask).not.toContain("report-2");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "report", "list", "--agent", "helper"]);
    const byAgent = outputOf(log);
    expect(byAgent).toContain("report-2");
    expect(byAgent).not.toContain("report-1");
  });

  it("emits the reports as JSON", async () => {
    await initProject();
    await seedReport(makeReport({ id: "report-1", agent: "worker" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as Report[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("report-1");
    expect(parsed[0]?.agent).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// `omninode report combined`
// ---------------------------------------------------------------------------

describe("report combined", () => {
  it("says so when no combined report is stored", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "combined"]);
    expect(outputOf(log)).toContain(
      "No combined reports stored yet. Run a pipeline to generate one.",
    );
  });

  it("lists the combined reports with their finding and source counts", async () => {
    await initProject();
    await seedCombined(
      makeCombined({
        id: "combined-1",
        findings: [
          {
            title: "Issue",
            details: [],
            sources: [{ agent: "worker", reportId: "report-1" }],
            occurrences: 1,
            evidence: [],
          },
        ],
        sources: ["worker"],
        pipelineRunId: "run-1",
      }),
    );
    await seedCombined(
      makeCombined({
        id: "combined-2",
        conflicts: [
          {
            type: "severity",
            findingTitle: "Issue",
            positions: [],
            note: "note",
          },
        ],
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "combined"]);
    const output = outputOf(log);

    expect(output).toContain("combined-1  1 finding(s) from 1 source(s)  run=run-1");
    expect(output).toContain("combined-2  0 finding(s) from 1 source(s)  1 CONFLICT(S)");
  });

  it("filters the combined reports by pipeline run", async () => {
    await initProject();
    await seedCombined(makeCombined({ id: "combined-1", pipelineRunId: "run-1" }));
    await seedCombined(makeCombined({ id: "combined-2", pipelineRunId: "run-2" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "combined", "--run", "run-2"]);
    const output = outputOf(log);

    expect(output).toContain("combined-2");
    expect(output).not.toContain("combined-1");
  });

  it("emits the combined reports as JSON", async () => {
    await initProject();
    await seedCombined(makeCombined({ id: "combined-1" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "combined", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as CombinedReport[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("combined-1");
  });
});

// ---------------------------------------------------------------------------
// `omninode report show`
// ---------------------------------------------------------------------------

describe("report show", () => {
  it("shows a stored raw report in full", async () => {
    await initProject();
    await seedReport(
      makeReport({
        id: "report-1",
        agent: "worker",
        model: "gpt-x",
        taskId: "task-1",
        summary: "Two problems found",
        findings: [
          {
            id: "f-1",
            title: "Hardcoded secret",
            detail: "A secret is in the source",
            severity: "critical",
            evidence: ["src/config.ts:12", { kind: "file", ref: "src/other.ts" }],
          },
          { id: "f-2", title: "Missing timeout", detail: "No timeout configured" },
        ],
        recommendations: ["Move the secret into an env var", "Add a timeout"],
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "show", "report-1"]);
    const output = outputOf(log);

    expect(output).toContain("Report report-1");
    expect(output).toContain("agent:     worker (gpt-x)");
    expect(output).toContain("task:      task-1");
    expect(output).toContain("summary:   Two problems found");
    expect(output).toContain("findings:");
    expect(output).toContain("- [critical] Hardcoded secret");
    expect(output).toContain("evidence: src/config.ts:12");
    expect(output).toContain("evidence: [object Object]");
    expect(output).toContain("- [info] Missing timeout");
    expect(output).toContain("recommendations:");
    expect(output).toContain("- Move the secret into an env var");
    expect(output).toContain("- Add a timeout");
  });

  it("shows a report without a model, findings or recommendations", async () => {
    await initProject();
    await seedReport(makeReport({ id: "report-1", agent: "worker", model: undefined }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "show", "report-1"]);
    const output = outputOf(log);

    expect(output).toContain("agent:     worker");
    expect(output).not.toContain("findings:");
    expect(output).not.toContain("recommendations:");
  });

  it("shows a stored combined report in full", async () => {
    await initProject();
    await seedCombined(
      makeCombined({
        id: "combined-1",
        sources: ["helper", "worker"],
        reportIds: ["report-1", "report-2"],
        pipelineRunId: "run-1",
        summary: "2 report(s) from 2 agents",
        agreements: [
          {
            title: "Agreed issue",
            details: [],
            sources: [{ agent: "worker", reportId: "report-1" }],
            occurrences: 2,
            evidence: [],
          },
        ],
        conflicts: [
          {
            type: "severity",
            findingTitle: "Disputed issue",
            positions: [
              { agent: "worker", reportId: "report-1", severity: "high", recommendation: "fix it" },
              { agent: "helper", reportId: "report-2" },
            ],
            note: "Agents disagree on severity (high, low).",
          },
        ],
        findings: [
          {
            title: "Grouped issue",
            details: [],
            sources: [
              { agent: "worker", reportId: "report-1" },
              { agent: "helper", reportId: "report-2" },
            ],
            occurrences: 2,
            severity: "medium",
            evidence: [],
          },
        ],
        recommendations: [
          {
            text: "Refactor the module",
            sources: [{ agent: "worker", reportId: "report-1" }],
            occurrences: 2,
          },
        ],
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "show", "combined-1"]);
    const output = outputOf(log);

    expect(output).toContain("Combined report combined-1");
    expect(output).toContain("sources:   helper, worker");
    expect(output).toContain("reports:   2");
    expect(output).toContain("run:       run-1");
    expect(output).toContain("summary:   2 report(s) from 2 agents");
    expect(output).toContain("CONFLICTS (1) — both positions preserved:");
    expect(output).toContain("! Disputed issue [severity]");
    expect(output).toContain("worker: severity=high fix=\"fix it\"");
    expect(output).toContain("helper: severity=unstated");
    expect(output).toContain("Agents disagree on severity (high, low).");
    expect(output).toContain("agreements: 1 (multi-agent consensus)");
    expect(output).toContain("findings (grouped, duplicates merged):");
    expect(output).toContain("- [medium] Grouped issue (x2, sources: worker, helper)");
    expect(output).toContain("recommendations:");
    expect(output).toContain("- Refactor the module (x2)");
  });

  it("shows a combined report without a run, conflicts, agreements, findings or recommendations", async () => {
    await initProject();
    await seedCombined(makeCombined({ id: "combined-1", pipelineRunId: undefined }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "show", "combined-1"]);
    const output = outputOf(log);

    expect(output).toContain("Combined report combined-1");
    expect(output).not.toContain("run:");
    expect(output).not.toContain("CONFLICTS");
    expect(output).not.toContain("agreements:");
    expect(output).not.toContain("findings (grouped");
    expect(output).not.toContain("recommendations:");
  });

  it("falls back to 'info' for a grouped finding without a severity", async () => {
    await initProject();
    await seedCombined(
      makeCombined({
        id: "combined-1",
        findings: [
          {
            title: "Unclassified issue",
            details: [],
            sources: [{ agent: "worker", reportId: "report-1" }],
            occurrences: 1,
            evidence: [],
          },
        ],
      }),
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "show", "combined-1"]);
    const output = outputOf(log);

    expect(output).toContain("- [info] Unclassified issue (x1, sources: worker)");
  });

  it("fails with REPORT_NOT_FOUND for an unknown id", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "report", "show", "report-ghost"]),
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// `omninode status`
// ---------------------------------------------------------------------------

describe("status", () => {
  it("summarises an empty project", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    const output = outputOf(log);

    expect(output).toContain("OmniNode v");
    expect(output).toContain('project "Diag"');
    expect(output).toContain("providers: none");
    expect(output).toContain("agents:    none");
    expect(output).toContain("roles:     none");
    expect(output).toContain("pipelines: none");
    expect(output).toContain("tasks:     0");
    expect(output).toContain("runs:      0");
    expect(output).toContain("reports:   0 raw, 0 combined");
    expect(output).toContain("plans:     0");
    expect(output).toContain("memory:    not configured");
  });

  it("counts tasks, runs, reports and plans and groups them by status", async () => {
    await initProject();
    await seedTask(makeTask({ id: "task-1", status: "completed" }));
    await seedTask(makeTask({ id: "task-2", status: "completed" }));
    await seedTask(makeTask({ id: "task-3", status: "failed" }));
    await seedRun(makeRun({ id: "run-1", status: "completed" }));
    await seedRun(makeRun({ id: "run-2", status: "failed" }));
    await seedReport(makeReport({ id: "report-1" }));
    await seedCombined(makeCombined({ id: "combined-1" }));
    await seedPlan(makePlan({ id: "plan-1" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    const output = outputOf(log);

    expect(output).toContain("tasks:     3 (completed 2, failed 1)");
    expect(output).toContain("runs:      2 (completed 1, failed 1)");
    expect(output).toContain("reports:   1 raw, 1 combined");
    expect(output).toContain("plans:     1");
  });

  it("lists the configured providers, agents, roles and pipelines", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
  agents:
    - name: worker
      type: cli
      command: node
  roles:
    - id: reviewer
      name: Reviewer
  pipelines:
    - id: audit
      steps:
        - id: research
          kind: research
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    const output = outputOf(log);

    expect(output).toContain("providers: gw");
    expect(output).toContain("agents:    worker");
    expect(output).toContain("roles:     reviewer");
    expect(output).toContain("pipelines: audit");
  });

  it("reports the memory provider and its entry count", async () => {
    writeConfig(`project:
  name: Diag
  providers: []
  agents: []
  roles: []
  pipelines: []
  memory:
    provider: local
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    const output = outputOf(log);

    expect(output).toContain("memory:    local, 0 entr(ies)");
  });

  it("emits a machine-readable overview as JSON", async () => {
    await initProject();
    await seedTask(makeTask({ id: "task-1", status: "completed" }));
    await seedTask(makeTask({ id: "task-2", status: "failed" }));
    await seedRun(makeRun({ id: "run-1", status: "completed" }));
    await seedReport(makeReport({ id: "report-1" }));
    await seedPlan(makePlan({ id: "plan-1" }));

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      version: string;
      project: string;
      providers: string[];
      agents: string[];
      roles: string[];
      pipelines: string[];
      tasks: { total: number; byStatus: Record<string, number> };
      runs: { total: number; byStatus: Record<string, number> };
      reports: { raw: number; combined: number };
      plans: number;
      memory?: { provider: string; entries: number };
    };

    expect(parsed.project).toBe("Diag");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.tasks.total).toBe(2);
    expect(parsed.tasks.byStatus).toEqual({ completed: 1, failed: 1 });
    expect(parsed.runs.total).toBe(1);
    expect(parsed.runs.byStatus).toEqual({ completed: 1 });
    expect(parsed.reports).toEqual({ raw: 1, combined: 0 });
    expect(parsed.plans).toBe(1);
    // Memory is not configured in this project.
    expect(parsed.memory).toBeUndefined();
  });

  it("lists the configured providers, agents, roles and pipelines in the JSON overview", async () => {
    writeConfig(`project:
  name: Diag
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://example.com/v1
  agents:
    - name: worker
      type: cli
      command: node
  roles:
    - id: reviewer
      name: Reviewer
  pipelines:
    - id: audit
      steps:
        - id: research
          kind: research
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as {
      providers: string[];
      agents: string[];
      roles: string[];
      pipelines: string[];
    };

    expect(parsed.providers).toEqual(["gw"]);
    expect(parsed.agents).toEqual(["worker"]);
    expect(parsed.roles).toEqual(["reviewer"]);
    expect(parsed.pipelines).toEqual(["audit"]);
  });

  it("includes the memory section in the JSON overview when memory is configured", async () => {
    writeConfig(`project:
  name: Diag
  providers: []
  agents: []
  roles: []
  pipelines: []
  memory:
    provider: local
`);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status", "--json"]);
    const raw = log.mock.calls.map((call: unknown[]) => call[0]).join("");
    const parsed = JSON.parse(raw) as { memory?: { provider: string; entries: number } };

    expect(parsed.memory).toEqual({ provider: "local", entries: 0 });
  });

  it("reads the project configuration from the file it was told to use", async () => {
    const otherDir = mkdtempSync(path.join(tmpdir(), "omninode-diag-alt-"));
    try {
      const altConfig = path.join(otherDir, "alt.yaml");
      writeFileSync(
        altConfig,
        `project:
  name: Alt
  providers: []
  agents: []
  roles: []
  pipelines: []
`,
        "utf8",
      );

      const log = capture();
      await createProgram().parseAsync([
        "node",
        "omninode",
        "--config",
        altConfig,
        "status",
      ]);
      expect(outputOf(log)).toContain('project "Alt"');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("keeps the untouched project configuration file byte-identical", async () => {
    await initProject();
    const before = readFileSync(configPath(), "utf8");

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "status"]);
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);

    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(outputOf(log)).toContain("tasks:     0");
  });
});
