import type { Command } from "commander";
import { TaskError } from "../../errors/index.js";
import { createTaskEngine } from "../../tasks/index.js";
import type { Task } from "../../types/task.js";
import { registerTaskInspect } from "./inspect.js";
import { exitCodeForStatus } from "../exit-codes.js";
import { loadProjectConfig } from "../options.js";
const collectFiles = (value: string, previous: string[]): string[] => [...previous, value];

export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("Create, run and inspect tasks (§13).");

  task
    .command("create <objective>")
    .description("Create a task. Assign a role and/or agent; run it with `omninode task run`.")
    .option("-r, --role <roleId>", "Role id from project.roles (validated at creation).")
    .option("-a, --agent <name>", "Agent name from project.agents (validated at creation).")
    .option("-f, --file <path>", "File or glob relevant to the task (repeatable).", collectFiles)
    .action(async (objective: string, options: { role?: string; agent?: string; file?: string[] }) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const created = await engine.create({
        objective,
        project: config.project.name,
        ...(options.role !== undefined ? { role: options.role } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.file !== undefined && options.file.length > 0
          ? { context: { files: options.file } }
          : {}),
      });
      console.log(`Created task ${created.id} (${created.status})`);
      console.log(`  objective: ${created.objective}`);
      if (created.role) console.log(`  role:      ${created.role}`);
      if (created.agent) console.log(`  agent:     ${created.agent}`);
      if (created.context?.files) console.log(`  files:     ${created.context.files.join(", ")}`);
      console.log(`Run \`omninode task run ${created.id}\` to execute it.`);
    });

  task
    .command("run <task-id>")
    .description("Run a task through its assigned agent.")
    .action(async (taskId: string) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      console.log(`Running task ${taskId}...`);
      const finished = await engine.run(taskId);
      printOutcome(finished);
      process.exitCode = exitCodeForStatus(finished.status);
    });

  task
    .command("status <task-id>")
    .description("Show task details and current status.")
    .action(async (taskId: string) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const found = await engine.get(taskId);
      if (!found) {
        throw new TaskError(
          "TASK_NOT_FOUND",
          `Task "${taskId}" does not exist in this project's task store.`,
        );
      }
      printOutcome(found, { verbose: true });
    });

  task
    .command("list")
    .description("List tasks in the project's task store.")
    .option(
      "-s, --status <status>",
      "Filter by status (created, queued, running, waiting, completed, failed, timed_out, cancelled, unknown, partially_completed).",
    )
    .option("--json", "Emit tasks as JSON.")
    .action(async (options: { status?: string; json?: boolean }) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const tasks = await engine.list(
        options.status !== undefined ? { status: options.status as Task["status"] } : {},
      );
      if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }
      if (tasks.length === 0) {
        console.log("No tasks found. Create one with `omninode task create`.");
        return;
      }
      for (const t of tasks) {
        console.log(`${t.id}  ${t.status.padEnd(10)} ${truncate(t.objective, 60)}`);
      }
    });

  task
    .command("cancel <task-id>")
    .description("Cancel a task that has not finished yet.")
    .action(async (taskId: string) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const cancelled = await engine.cancel(taskId);
      console.log(`Task ${cancelled.id} is now "${cancelled.status}".`);
    });

  task
    .command("recover")
    .description("Mark tasks stuck in `running` (e.g. after a crash) as unknown, per §23 Fix 02.")
    .action(async () => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const recovered = await engine.recoverStaleTasks();
      if (recovered.length === 0) {
        console.log("No stale running tasks.");
        return;
      }
      for (const task of recovered) {
        console.log(`${task.id}  running → unknown`);
      }
      console.log("Inspect each task and use `task retry <id> --run` to re-execute if safe.");
    });

  task
    .command("retry <task-id>")
    .description("Reset a failed, timed out, unknown or cancelled task to created; combine with --run to execute it again.")
    .option("--run", "Run the task again immediately after resetting it.")
    .action(async (taskId: string, options: { run?: boolean }) => {
      const config = loadProjectConfig();
      const engine = createTaskEngine(config);
      const previous = await engine.get(taskId);
      const reset = await engine.retry(taskId);
      if (previous?.status === "unknown") {
        console.log("⚠ The previous execution ended in an unknown state. Retrying may duplicate side effects.");
      }
      console.log(`Task ${reset.id} reset to "${reset.status}".`);
      if (!options.run) return;
      console.log(`Running task ${reset.id}...`);
      const finished = await engine.run(reset.id);
      printOutcome(finished);
      process.exitCode = exitCodeForStatus(finished.status);
    });
  registerTaskInspect(task);
}

/**
 * One-line explanations for states whose meaning is not obvious from the name
 * (v2.0.3 Fix 05 — the CLI documents the actual state machine).
 */
const STATUS_HINTS: Partial<Record<Task["status"], string>> = {
  unknown:
    "the execution may have happened, but its outcome could not be proven — inspect results before retrying (a retry may duplicate side effects)",
  timed_out: "the execution exceeded its configured timeout",
  partially_completed: "some of the work completed while other work did not",
  cancelled: "execution was explicitly cancelled",
};

function printOutcome(task: Task, options: { verbose?: boolean } = {}): void {
  console.log(`  id:      ${task.id}`);
  console.log(`  status:  ${task.status}`);
  const hint = STATUS_HINTS[task.status];
  if (hint) console.log(`  hint:    ${hint}`);
  console.log(`  created: ${task.createdAt}`);
  if (options.verbose) {
    console.log(`  project: ${task.project ?? "(none)"}`);
    if (task.role) console.log(`  role:    ${task.role}`);
    if (task.agent) console.log(`  agent:   ${task.agent}`);
    if (task.context?.files) console.log(`  files:   ${task.context.files.join(", ")}`);
    console.log(`  objective: ${task.objective}`);
  }
  if (options.verbose && task.attempt > 0) {
    console.log(`  attempt: ${task.attempt}`);
  }
  if (task.lastError) console.log(`  error:   ${task.lastError}`);
  if (options.verbose && task.executions && task.executions.length > 0) {
    console.log(
      `  executions: ${task.executions
        .map((e) => `#${e.attempt}:${e.outcome}`)
        .join(", ")}`,
    );
  }
  const result = task.result;
  if (!result) return;
  if (result.summary) console.log(`  summary: ${result.summary}`);
  if (result.reports && result.reports.length > 0) {
    console.log(`  reports: ${result.reports.length} structured report(s)`);
  }
  if (result.error) console.log(`  error:   ${result.error}`);
  if (result.finishedAt) console.log(`  ended:   ${result.finishedAt}`);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
