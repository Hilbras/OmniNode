import { existsSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { OmniNodeError } from "../../errors/index.js";
import { defaultProjectConfigYaml } from "../../config/index.js";

export async function runInit(options: { force?: boolean; name?: string }): Promise<void> {
  const target = `${process.cwd()}/omninode.yaml`;
  if (!options.force && existsSync(target)) {
    throw new OmniNodeError(
      "CLI_USAGE",
      `${target} already exists. Use --force to overwrite it.`,
    );
  }
  writeFileSync(target, defaultProjectConfigYaml(options.name), "utf8");
  console.log(`Created ${target}`);
  console.log("\nNext steps:");
  console.log("  1. Add a provider under `project.providers` (see omninode.yaml.example).");
  console.log("  2. Register CLI agents under `project.agents`.");
  console.log("  3. Run `omninode provider list` to validate the configuration.");
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create an omninode.yaml project configuration in the current directory.")
    .option("-f, --force", "Overwrite an existing omninode.yaml.")
    .option("-n, --name <name>", "Project name to write into the configuration.", "My Project")
    .action(async (options: { force?: boolean; name: string }) => runInit(options));
}
