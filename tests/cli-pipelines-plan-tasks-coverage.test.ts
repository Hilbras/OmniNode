/**
 * Coverage tests for the pipeline, plan and task CLI command groups
 * (src/cli/commands/pipelines.ts, plan.ts, tasks.ts).
 *
 * The existing CLI suites exercise the happy path of these groups; this file
 * covers the remaining branches: empty stores, missing configuration,
 * duplicate ids, unreadable definition files, interrupted runs, cancellation
 * requests, status hints, stale-task recovery and the repeatable `--file`
 * option.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import type { PipelineRun } from "../src/types/pipeline.js";
import type { Task } from "../src/types/task.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-clippt-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env.OMNINODE_USER_CONFIG;
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof capture>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function configPath(): string {
  return path.join(workDir, "omninode.yaml");
}

/** Reads a persisted JSON store (task/pipeline run/plan store). */
function readStore<T>(file: string): T[] {
  const target = path.join(workDir, ".omninode", file);
  if (!existsSync(target)) return [];
  const parsed = JSON.parse(readFileSync(target, "utf8")) as T[] | { items: T[] };
  return Array.isArray(parsed) ? parsed : parsed.items;
}

function writeStore<T>(file: string, items: T[]): void {
  mkdirSync(path.join(workDir, ".omninode"), { recursive: true });
  writeFileSync(
    path.join(workDir, ".omninode", file),
    `${JSON.stringify({ schemaVersion: 2, items }, null, 2)}\n`,
    "utf8",
  );
}

/** Rewrites the project configuration with an extra YAML fragment. */
function patchConfig(fragment: string): void {
  const raw = readFileSync(configPath(), "utf8");
  writeFileSync(configPath(), raw.replace("roles: []", `roles: []\n${fragment}`), "utf8");
}

async function initProject(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init"]);
}

describe("CLI pipeline commands — uncovered paths", () => {
  it("lists nothing when no pipelines are configured", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "list"]);
    expect(outputOf(log)).toContain(
      "No pipelines configured. Add one under `project.pipelines` in omninode.yaml.",
    );
  });

  it("names the available pipelines when the requested one is unknown", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: alpha
      steps:
        - id: only
          kind: collect
    - id: beta
      steps:
        - id: only
          kind: collect
`);
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "run", "ghost"]),
    ).rejects.toMatchObject({
      code: "PIPELINE_NOT_FOUND",
      message: expect.stringContaining("Configured pipelines: alpha, beta"),
    });
  });

  it("reports an empty pipeline list as '(none)' when nothing is configured", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "run", "ghost"]),
    ).rejects.toMatchObject({
      code: "PIPELINE_NOT_FOUND",
      message: expect.stringContaining("Configured pipelines: (none)"),
    });
  });

  it("validates a configured pipeline and prints each step's dependencies", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: flow
      steps:
        - id: first
          kind: collect
        - id: second
          kind: collect
          depends_on: [first]
`);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "validate", "flow"]);
    const output = outputOf(log);
    expect(output).toContain('Pipeline "flow" is valid (2 step(s)).');
    expect(output).toContain("first  kind=collect  depends_on=(previous step)");
    expect(output).toContain("second  kind=collect  depends_on=first");
  });

  it("refuses to validate a pipeline that is not configured", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "validate", "ghost"]),
    ).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  });

  it("reports that a pipeline has no recorded runs", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: flow
      steps:
        - id: only
          kind: collect
`);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "runs", "flow"]);
    expect(outputOf(log)).toContain('No recorded runs for pipeline "flow".');
  });

  it("marks a run that is still 'running' without finishedAt as interrupted", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: flow
      steps:
        - id: only
          kind: collect
`);
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-stuck",
        pipelineId: "flow",
        attempt: 1,
        status: "running",
        startedAt: "2024-01-01T00:00:00.000Z",
        stepRuns: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "runs", "flow"]);
    const output = outputOf(log);
    expect(output).toContain("run-stuck");
    expect(output).toContain("(interrupted — process gone before finish)");

    // `pipeline status` shows the same interruption warning.
    const statusLog = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "status", "run-stuck"]);
    const statusOutput = outputOf(statusLog);
    expect(statusOutput).toContain("note:       this run looks interrupted (no finishedAt) — retry with `pipeline retry`");
  });

  it("shows a recorded run's cancellation request in `pipeline status`", async () => {
    await initProject();
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-cancelled",
        pipelineId: "flow",
        attempt: 1,
        status: "cancelled",
        startedAt: "2024-01-01T00:00:00.000Z",
        finishedAt: "2024-01-01T00:05:00.000Z",
        cancellationRequested: true,
        cancellationRequestedAt: "2024-01-01T00:04:00.000Z",
        stepRuns: [{ stepId: "only", status: "cancelled" }],
        reports: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "status", "run-cancelled"]);
    const output = outputOf(log);
    expect(output).toContain("cancellation requested at 2024-01-01T00:04:00.000Z");
    expect(output).toContain("finished:   2024-01-01T00:05:00.000Z");
    expect(output).toContain("[only] cancelled");
  });

  it("prints a '?' for a run without a start time and without a cancellation timestamp", async () => {
    await initProject();
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-bare",
        pipelineId: "flow",
        attempt: 2,
        status: "running",
        cancellationRequested: true,
        stepRuns: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "status", "run-bare"]);
    const output = outputOf(log);
    expect(output).toContain("started:    ?");
    expect(output).toContain("cancellation requested at ?");
  });

  it("shows a '?' for a listed run without a start time", async () => {
    await initProject();
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-unstarted",
        pipelineId: "flow",
        attempt: 1,
        status: "pending",
        stepRuns: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "runs", "flow"]);
    const output = outputOf(log);
    expect(output).toContain("run-unstarted");
    expect(output).toContain("pending");
    expect(output).toContain("?");
  });

  it("raises PIPELINE_NOT_FOUND for an unknown run id", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "status", "run-ghost"]),
    ).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  });

  it("requests cancellation of a recorded run", async () => {
    await initProject();
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-live",
        pipelineId: "flow",
        attempt: 1,
        status: "running",
        startedAt: "2024-01-01T00:00:00.000Z",
        stepRuns: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "cancel", "run-live"]);
    const output = outputOf(log);
    expect(output).toContain("Cancellation requested for run run-live.");
    expect(output).toContain("A run executing in another process stops at its next check point.");

    const runs = readStore<PipelineRun>("pipelines.json");
    expect(runs[0]?.cancellationRequested).toBe(true);
    expect(runs[0]?.cancellationRequestedAt).toBeTruthy();
  });

  it("raises PIPELINE_NOT_FOUND when retrying an unknown run", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "retry", "run-ghost"]),
    ).rejects.toMatchObject({
      code: "PIPELINE_NOT_FOUND",
      message: expect.stringContaining('run-ghost'),
    });
  });

  it("raises PIPELINE_NOT_FOUND when a recorded run's pipeline is no longer configured", async () => {
    await initProject();
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-orphan",
        pipelineId: "removed-pipeline",
        attempt: 1,
        status: "failed",
        startedAt: "2024-01-01T00:00:00.000Z",
        stepRuns: [],
      },
    ]);

    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "retry", "run-orphan"]),
    ).rejects.toMatchObject({
      code: "PIPELINE_NOT_FOUND",
      message: expect.stringContaining("removed-pipeline"),
    });
  });

  it("re-runs a recorded pipeline run, reusing its objective", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: flow
      steps:
        - id: only
          kind: collect
`);
    writeStore<PipelineRun>("pipelines.json", [
      {
        id: "run-previous",
        pipelineId: "flow",
        attempt: 1,
        status: "failed",
        objective: "the original objective",
        startedAt: "2024-01-01T00:00:00.000Z",
        stepRuns: [],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "retry", "run-previous"]);
    const output = outputOf(log);
    expect(output).toContain('Running pipeline "flow" (1 step(s)) — "the original objective"...');
    expect(output).toContain("Pipeline completed.");

    // The retry produced a NEW run; the previous one is untouched.
    const runs = readStore<PipelineRun>("pipelines.json");
    expect(runs).toHaveLength(2);
    expect(runs.filter((r) => r.id === "run-previous")).toHaveLength(1);
  });

  it("runs a pipeline without an explicit objective and without a default one", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: gather
      steps:
        - id: only
          kind: collect
`);
    const log = capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "run", "gather"]),
    ).rejects.toMatchObject({
      code: "PIPELINE_INVALID",
      message: expect.stringContaining("needs an objective"),
    });
    // The failure is announced before the engine runs.
    expect(outputOf(log)).toContain('Running pipeline "gather" (1 step(s))...');
  });

  it("appends a created pipeline to an existing pipeline list", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: existing
      steps:
        - id: only
          kind: collect
`);
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(
      definition,
      "objective: default objective\nsteps:\n  - id: do\n    kind: collect\n",
      "utf8",
    );

    const log = capture();
    await createProgram().parseAsync([
      "node", "omninode", "pipeline", "create", "added", "--from", definition,
    ]);
    expect(outputOf(log)).toContain('Created pipeline "added" (1 step(s))');

    const raw = readFileSync(configPath(), "utf8");
    expect(raw).toContain("id: existing");
    expect(raw).toContain("id: added");
  });

  it("refuses to create a pipeline whose id already exists", async () => {
    await initProject();
    patchConfig(`
  pipelines:
    - id: duplicate
      steps:
        - id: only
          kind: collect
`);
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(definition, "steps:\n  - id: do\n    kind: collect\n", "utf8");

    capture();
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "pipeline", "create", "duplicate", "--from", definition,
      ]),
    ).rejects.toMatchObject({
      code: "PIPELINE_INVALID",
      message: expect.stringContaining('A pipeline named "duplicate" already exists'),
    });
  });

  it("refuses to create a pipeline from a file that cannot be read", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "pipeline", "create", "flow", "--from",
        path.join(workDir, "missing.yaml"),
      ]),
    ).rejects.toMatchObject({
      code: "PIPELINE_INVALID",
      message: expect.stringContaining("Could not read pipeline definition from"),
    });
  });

  it("refuses to create a pipeline from an invalid definition", async () => {
    await initProject();
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(definition, "bogus: true\nsteps:\n  - id: do\n    kind: collect\n", "utf8");

    capture();
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "pipeline", "create", "flow", "--from", definition,
      ]),
    ).rejects.toMatchObject({
      code: "PIPELINE_INVALID",
      message: expect.stringContaining("(root): Unrecognized key(s) in object: 'bogus'"),
    });
    // The configuration was not touched.
    expect(readFileSync(configPath(), "utf8")).not.toContain("flow");
  });

  it("refuses to create a pipeline when no project configuration exists", async () => {
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(definition, "steps:\n  - id: do\n    kind: collect\n", "utf8");

    capture();
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "pipeline", "create", "flow", "--from", definition,
      ]),
    ).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      message: expect.stringContaining("No omninode.yaml found"),
    });
  });

  it("refuses to create a pipeline that would make the configuration invalid", async () => {
    // The raw document is valid on its own, but the composed configuration
    // (profile overlay + project file) is not — so the pipeline must not be
    // written.
    writeFileSync(
      configPath(),
      [
        "profile: testing",
        "profiles:",
        "  testing:",
        "    project:",
        "      name: FromProfile",
        "project:",
        "  pipelines: []",
        "",
      ].join("\n"),
      "utf8",
    );
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(definition, "steps:\n  - id: do\n    kind: collect\n", "utf8");

    capture();
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "pipeline", "create", "flow", "--from", definition,
      ]),
    ).rejects.toMatchObject({
      code: "PIPELINE_INVALID",
      message: expect.stringContaining("would produce an invalid configuration"),
    });
    // Nothing was written to the configuration file.
    expect(readFileSync(configPath(), "utf8")).not.toContain("id: flow");
  });
});

describe("CLI plan commands — uncovered paths", () => {
  it("reports that no plans are stored yet", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "plan", "list"]);
    expect(outputOf(log)).toContain(
      "No plans stored yet. Run a pipeline with a plan step to generate one.",
    );
  });

  it("lists stored plans and filters them by pipeline run", async () => {
    await initProject();
    writeStore("plans.json", [
      {
        id: "plan-a",
        objective: "objective A",
        summary: "summary A",
        steps: [{ id: "s1", title: "Step A", order: 1 }],
        generatedBy: "heuristic",
        pipelineRunId: "run-1",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "plan-b",
        objective: "objective B",
        summary: "summary B",
        steps: [{ id: "s1", title: "Step B", order: 1 }],
        generatedBy: "model:gw:gpt-test",
        pipelineRunId: "run-2",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "plan", "list"]);
    const output = outputOf(log);
    expect(output).toContain("plan-a  1 step(s)  by heuristic  summary A");
    expect(output).toContain("plan-b  1 step(s)  by model:gw:gpt-test  summary B");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "plan", "list", "--run", "run-2"]);
    const filteredOutput = outputOf(log);
    expect(filteredOutput).toContain("plan-b");
    expect(filteredOutput).not.toContain("plan-a");
  });

  it("shows a stored plan in full, including descriptions and acceptance criteria", async () => {
    await initProject();
    writeStore("plans.json", [
      {
        id: "plan-detailed",
        objective: "harden the parser",
        summary: "Two things to fix",
        steps: [
          {
            id: "s2",
            title: "Second step",
            description: "A long description that will be truncated because it exceeds the hundred character limit used by the plan viewer.",
            order: 2,
            acceptanceCriteria: ["criterion two"],
          },
          {
            id: "s1",
            title: "First step",
            order: 1,
            targets: ["src/parser.ts", "src/lexer.ts"],
            acceptanceCriteria: ["criterion one"],
          },
        ],
        risks: ["a risk worth noting"],
        generatedBy: "heuristic",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "plan", "show", "plan-detailed"]);
    const output = outputOf(log);
    expect(output).toContain("Plan plan-detailed");
    expect(output).toContain("objective: harden the parser");
    expect(output).toContain("by:        heuristic");
    expect(output).toContain("summary:   Two things to fix");
    // Steps are printed in `order` sequence, not store order.
    expect(output.indexOf("1. First step")).toBeLessThan(output.indexOf("2. Second step"));
    expect(output).toContain("First step [src/parser.ts, src/lexer.ts]");
    expect(output).toContain("accept: criterion one");
    expect(output).toContain("accept: criterion two");
    expect(output).toContain("risks:");
    expect(output).toContain("- a risk worth noting");
  });

  it("shows a plan without risks, targets or acceptance criteria", async () => {
    await initProject();
    writeStore("plans.json", [
      {
        id: "plan-bare",
        objective: "look around",
        summary: "Nothing to do",
        steps: [{ id: "s1", title: "Only step", order: 1 }],
        generatedBy: "heuristic",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "plan", "show", "plan-bare"]);
    const output = outputOf(log);
    expect(output).toContain("Plan plan-bare");
    expect(output).toContain("1. Only step");
    // No risks, no targets and no acceptance criteria were printed.
    expect(output).not.toContain("risks:");
    expect(output).not.toContain("accept:");
    expect(output).not.toContain("[");
  });

  it("raises PLAN_INVALID for an unknown plan id", async () => {
    await initProject();
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "plan", "show", "plan-ghost"]),
    ).rejects.toMatchObject({
      code: "PLAN_INVALID",
      message: expect.stringContaining('Plan "plan-ghost" was not found'),
    });
  });
});

describe("CLI task commands — uncovered paths", () => {
  it("runs a task and reports the outcome of the agent", async () => {
    await initProject();
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker",
      "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('WORK DONE')",
    ]);
    capture();
    await createProgram().parseAsync([
      "node", "omninode", "task", "create", "do the work", "--agent", "worker",
    ]);
    const tasks = readStore<Task>("tasks.json");
    const taskId = tasks[0]!.id;

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "run", taskId]);
    const output = outputOf(log);
    expect(output).toContain(`Running task ${taskId}...`);
    expect(output).toContain("status:  completed");
    expect(output).toContain("summary: WORK DONE");
    expect(process.exitCode).toBe(0);
  });

  it("cancels a task that has not started", async () => {
    await initProject();
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker",
      "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('NEVER RUNS')",
    ]);
    capture();
    await createProgram().parseAsync([
      "node", "omninode", "task", "create", "cancel me", "--agent", "worker",
    ]);
    const tasks = readStore<Task>("tasks.json");
    const taskId = tasks[0]!.id;

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "cancel", taskId]);
    expect(outputOf(log)).toContain(`Task ${taskId} is now "cancelled".`);

    const after = readStore<Task>("tasks.json");
    expect(after[0]?.status).toBe("cancelled");
  });

  it("reports that no tasks were found", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "list"]);
    expect(outputOf(log)).toContain("No tasks found. Create one with `omninode task create`.");
  });

  it("attaches repeated --file options to a created task", async () => {
    await initProject();
    const program = createProgram();
    const create = program.commands
      .find((command) => command.name() === "task")!
      .commands.find((command) => command.name() === "create")!;
    // Commander only calls the custom parser with a previous value when the
    // option already holds one; seeding it enables the repeatable form.
    create.setOptionValue("file", [] as string[]);

    const log = capture();
    await program.parseAsync([
      "node", "omninode", "task", "create", "review the code",
      "--file", "src/a.ts", "--file", "src/b.ts",
    ]);
    expect(outputOf(log)).toContain("files:     src/a.ts, src/b.ts");

    const tasks = readStore<Task>("tasks.json");
    expect(tasks[0]?.context?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports that no stale running tasks were found", async () => {
    await initProject();
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "recover"]);
    expect(outputOf(log)).toContain("No stale running tasks.");
  });

  it("recovers a stale running task as unknown", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-stale",
        objective: "stale work",
        status: "running",
        attempt: 1,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "recover"]);
    const output = outputOf(log);
    expect(output).toContain("task-stale  running → unknown");
    expect(output).toContain("Inspect each task and use `task retry <id> --run` to re-execute if safe.");

    const tasks = readStore<Task>("tasks.json");
    expect(tasks[0]?.status).toBe("unknown");
  });

  it("warns about an unknown previous execution when retrying", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-unknown",
        objective: "unprovable work",
        status: "unknown",
        attempt: 1,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastError: "the outcome could not be proven",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "retry", "task-unknown"]);
    const output = outputOf(log);
    expect(output).toContain(
      "⚠ The previous execution ended in an unknown state. Retrying may duplicate side effects.",
    );
    expect(output).toContain('Task task-unknown reset to "created".');
    // Without --run the task is only reset, never executed.
    expect(output).not.toContain("Running task task-unknown...");

    const tasks = readStore<Task>("tasks.json");
    expect(tasks[0]?.status).toBe("created");
  });

  it("shows the status hint and the previous error of a failed task", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-failed",
        objective: "doomed work",
        status: "failed",
        attempt: 2,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        lastError: "the agent crashed",
        executions: [
          { executionId: "exec-1", attempt: 1, startedAt: "2024-01-01T00:00:00.000Z", finishedAt: "2024-01-01T00:00:10.000Z", outcome: "failed" },
        ],
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "status", "task-failed"]);
    const output = outputOf(log);
    expect(output).toContain("status:  failed");
    expect(output).toContain("error:   the agent crashed");
    expect(output).toContain("project: (none)");
    expect(output).toContain("attempt: 2");
    expect(output).toContain("executions: #1:failed");
  });

  it("prints the hint that explains an unprovable outcome", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-unknown",
        objective: "unprovable work",
        status: "unknown",
        attempt: 1,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        project: "Demo",
        role: "planner",
        agent: "worker",
        context: { files: ["src/a.ts"] },
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "status", "task-unknown"]);
    const output = outputOf(log);
    expect(output).toContain("hint:    the execution may have happened, but its outcome could not be proven");
    expect(output).toContain("project: Demo");
    expect(output).toContain("role:    planner");
    expect(output).toContain("agent:   worker");
    expect(output).toContain("files:   src/a.ts");
    expect(output).toContain("objective: unprovable work");
  });

  it("truncates a long objective in `task list`", async () => {
    await initProject();
    const long = "x".repeat(80);
    writeStore<Task>("tasks.json", [
      {
        id: "task-long",
        objective: long,
        status: "created",
        attempt: 0,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "list"]);
    const output = outputOf(log);
    expect(output).toContain("task-long  created    ");
    // The objective is cut short and marked with an ellipsis.
    const objective = output.slice(output.indexOf("created") + "created".length).trim();
    expect(objective).toBe(`${"x".repeat(59)}…`);
    expect(output).not.toContain(long);
  });

  it("counts the structured reports a task produced", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-reported",
        objective: "collect findings",
        status: "completed",
        attempt: 1,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        result: {
          summary: "found two problems",
          finishedAt: "2024-01-01T00:01:00.000Z",
          reports: [
            {
              id: "rep-1",
              taskId: "task-reported",
              agent: "worker",
              summary: "first report",
              findings: [],
              recommendations: [],
              createdAt: "2024-01-01T00:01:00.000Z",
            },
            {
              id: "rep-2",
              taskId: "task-reported",
              agent: "worker",
              summary: "second report",
              findings: [],
              recommendations: [],
              createdAt: "2024-01-01T00:01:00.000Z",
            },
          ],
        },
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "status", "task-reported"]);
    const output = outputOf(log);
    expect(output).toContain("summary: found two problems");
    expect(output).toContain("reports: 2 structured report(s)");
    expect(output).toContain("ended:   2024-01-01T00:01:00.000Z");
  });

  it("omits the end timestamp of a result that never finished", async () => {
    await initProject();
    writeStore<Task>("tasks.json", [
      {
        id: "task-open",
        objective: "still running",
        status: "running",
        attempt: 1,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:01:00.000Z",
        result: { summary: "partial output" },
      },
    ]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "status", "task-open"]);
    const output = outputOf(log);
    expect(output).toContain("summary: partial output");
    expect(output).not.toContain("ended:");
  });
});
