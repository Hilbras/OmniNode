import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { Command } from "commander";
import { OMNINODE_VERSION } from "../version.js";
import { isOmniNodeError } from "../errors/index.js";
import { configureLogger } from "../logger/index.js";
import { exitCodeFor } from "./exit-codes.js";
import { findConfigFile, loadConfig } from "../config/index.js";
import { registerInitCommand } from "./commands/init.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProviderCommands } from "./commands/providers.js";
import { registerAgentCommands } from "./commands/agents.js";
import { registerRoleCommands } from "./commands/roles.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerReportCommands } from "./commands/reports.js";
import { registerPipelineCommands, registerRunAlias } from "./commands/pipelines.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerPlanCommands } from "./commands/plan.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerSecurityCommand } from "./commands/security.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerModelsCommand } from "./commands/models.js";

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
  registerStatusCommand(program);
  registerAuditCommand(program);
  registerMigrateCommand(program);
  registerSecurityCommand(program);
  registerConfigCommands(program);
  registerRunAlias(program);

  return program;
}

function applyLoggingConfig(): void {
  // Best effort: `init` and `--help` must work without a valid configuration.
  try {
    if (findConfigFile()) {
      const logging = loadConfig().logging;
      if (logging) configureLogger(logging);
    }
  } catch {
    // Configuration problems surface when the command actually needs it.
  }
}

export async function run(argv: string[]): Promise<void> {
  applyLoggingConfig();
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleError(error);
  }
}

export function handleError(error: unknown): never {
  const code = exitCodeFor(error);
  if (isOmniNodeError(error)) {
    console.error(`error: [${error.code}] ${error.message}`);
    if (error.details !== undefined) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exit(code);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(code);
}

const entry = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === entry) {
  run(process.argv).catch((error) => handleError(error));
}
