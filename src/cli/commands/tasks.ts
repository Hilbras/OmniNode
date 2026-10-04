import type { Command } from "commander";
import { notImplemented } from "./providers.js";

export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("Create, run and inspect tasks (Phase 4+).");

  task
    .command("create")
    .description("Create a task (planned for Phase 4 — Roles & Tasks).")
    .action(() => {
      throw notImplemented("omninode task create", "Phase 4 (Roles & Tasks)");
    });

  task
    .command("run <objective>")
    .description("Run a task or pipeline (planned for Phase 5 — Pipeline Engine).")
    .action(() => {
      throw notImplemented("omninode task run", "Phase 5 (Pipeline Engine)");
    });

  task
    .command("status <task-id>")
    .description("Show task status (planned for Phase 4 — Roles & Tasks).")
    .action(() => {
      throw notImplemented("omninode task status", "Phase 4 (Roles & Tasks)");
    });
}
