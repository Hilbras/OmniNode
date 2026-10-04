import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { OMNINODE_VERSION } from "../version.js";
import { isOmniNodeError } from "../errors/index.js";
import { registerInitCommand } from "./commands/init.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProviderCommands } from "./commands/providers.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerAgentCommands } from "./commands/agents.js";
import { registerRoleCommands } from "./commands/roles.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerReportCommands } from "./commands/reports.js";
import { registerPipelineCommands } from "./commands/pipelines.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerPlanCommands } from "./commands/plan.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("omninode")
    .description(
      "Provider-agnostic multi-AI orchestration platform: coordinate CLI agents, " +
        "AI providers, memory, roles, reports and planning in one execution system.",
    )
    .version(OMNINODE_VERSION, "-v, --version", "Print the OmniNode version.");

  registerInitCommand(program);
  registerProjectCommands(program);
  registerProviderCommands(program);
  registerAgentCommands(program);
  registerRoleCommands(program);
  registerTaskCommands(program);
  registerReportCommands(program);
  registerModelsCommand(program);
  registerPipelineCommands(program);
  registerMemoryCommands(program);
  registerPlanCommands(program);

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleError(error);
  }
}

export function handleError(error: unknown): never {
  if (isOmniNodeError(error)) {
    console.error(`error: [${error.code}] ${error.message}`);
    if (error.details !== undefined) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const entry = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === entry) {
  run(process.argv).catch((error) => handleError(error));
}
