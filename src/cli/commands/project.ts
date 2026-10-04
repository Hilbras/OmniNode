import type { Command } from "commander";
import { runInit } from "./init.js";

export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Project-level operations.");

  project
    .command("init")
    .description("Alias of `omninode init`.")
    .option("-f, --force", "Overwrite an existing omninode.yaml.")
    .option("-n, --name <name>", "Project name to write into the configuration.", "My Project")
    .action(async (options: { force?: boolean; name: string }) => runInit(options));
}
