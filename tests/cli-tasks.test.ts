import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadConfig } from "../src/config/index.js";


type StoredTask = { id: string; status?: string };

function readStore<T>(file: string): T[] {
  const path_ = path.join(workDir, ".omninode", file);
  if (!existsSync(path_)) return [];
  const parsed = JSON.parse(readFileSync(path_, "utf8")) as T[] | { items: T[] };
  return Array.isArray(parsed) ? parsed : parsed.items;
}

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-taskcli-"));
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
  return log.mock.calls.map((call) => call.join(" ")).join("\n");
}

async function setupProjectWithAgentAndRole(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init"]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "worker",
    "--command", "node",
    "--arg=-e", "--arg=process.stdout.write('WORK DONE')",
  ]);
  // Add a role directly to the YAML (roles come from configuration).
  const configPath = path.join(workDir, "omninode.yaml");
  const raw = readFileSync(configPath, "utf8").replace(
    "roles: []",
    `roles:
    - id: planner
      name: Planner
      responsibilities:
        - plan things`,
  );
  writeFileSync(configPath, raw, "utf8");
}

describe("CLI task commands", () => {
  it("create, run and status complete the Project → Task → Role → Agent chain", async () => {
    await setupProjectWithAgentAndRole();
    expect(loadConfig().project.roles[0]?.id).toBe("planner");

    let log = capture();
    await createProgram().parseAsync([
      "node", "omninode", "task", "create", "audit the repository",
      "--role", "planner", "--agent", "worker",
    ]);
    let output = outputOf(log);
    expect(output).toContain("Created task task-");
    const taskId = /task-[a-z0-9-]+/.exec(output)?.[0];
    expect(taskId).toBeDefined();

    log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "run", taskId!]);
    output = outputOf(log);
    expect(output).toContain("status:  completed");
    expect(output).toContain("summary: WORK DONE");

    log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "status", taskId!]);
    output = outputOf(log);
    expect(output).toContain("role:    planner");
    expect(output).toContain("agent:   worker");
    expect(output).toContain("status:  completed");
  }, 20_000);

  it("task run exits non-zero when the agent fails", async () => {
    await setupProjectWithAgentAndRole();
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "bad",
      "--command", "node",
      "--arg=-e", "--arg=process.exit(4)",
    ]);
    capture();
    await createProgram().parseAsync(["node", "omninode", "task", "create", "doomed", "--agent", "bad"]);
    const tasks = readStore<StoredTask>("tasks.json");
    expect(tasks).toHaveLength(1);
    // The command sets process.exitCode = 1; parseAsync itself resolves.
    const previousExit = process.exitCode;
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "run", tasks[0]!.id]);
    const output = outputOf(log);
    process.exitCode = previousExit;
    expect(output).toContain("status:  failed");
  });

  it("task list shows tasks with a status filter", async () => {
    await setupProjectWithAgentAndRole();
    capture();
    await createProgram().parseAsync(["node", "omninode", "task", "create", "one", "--agent", "worker"]);
    await createProgram().parseAsync(["node", "omninode", "task", "create", "two", "--agent", "worker"]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "list"]);
    expect(outputOf(log)).toMatch(/task-\S+\s+created/);
    const filtered = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "list", "--status", "created"]);
    expect(outputOf(filtered)).toContain("one");
  });

  it("validates role and agent references at creation", async () => {
    await setupProjectWithAgentAndRole();
    await expect(
      createProgram().parseAsync(["node", "omninode", "task", "create", "x", "--role", "nope"]),
    ).rejects.toMatchObject({ code: "TASK_INVALID", message: expect.stringContaining("nope") });
    await expect(
      createProgram().parseAsync(["node", "omninode", "task", "create", "x", "--agent", "nope"]),
    ).rejects.toMatchObject({ code: "TASK_INVALID", message: expect.stringContaining("nope") });
  });

  it("task status raises TASK_NOT_FOUND for unknown ids", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "task", "status", "task-ghost"]),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("task cancel moves a created task to cancelled", async () => {
    await setupProjectWithAgentAndRole();
    capture();
    await createProgram().parseAsync(["node", "omninode", "task", "create", "to be cancelled", "--agent", "worker"]);
    const tasks = readStore<StoredTask>("tasks.json");
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "task", "cancel", tasks[0]!.id]);
    expect(outputOf(log)).toContain('is now "cancelled"');
  });
});
