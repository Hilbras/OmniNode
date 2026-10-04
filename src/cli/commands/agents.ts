import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { notImplemented } from "./providers.js";

export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage CLI agents registered with OmniNode.");

  agent
    .command("list")
    .description("List configured agents.")
    .action(async () => {
      const config = loadConfig();
      const agents = config.project.agents;
      if (agents.length === 0) {
        console.log("No agents configured. Add one under `project.agents` in omninode.yaml.");
        return;
      }
      for (const agent of agents) {
        const command = agent.command ?? "(no command)";
        console.log(
          `${agent.name}  integration=${agent.integration}  command=${command}`,
        );
      }
    });

  agent
    .command("add")
    .description("Register an agent (planned for Phase 3 — CLI Agent System).")
    .action(() => {
      throw notImplemented("omninode agent add", "Phase 3 (CLI Agent System)");
    });
}
