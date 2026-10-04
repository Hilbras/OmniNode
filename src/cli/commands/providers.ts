import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { OmniNodeError } from "../../errors/index.js";

export function registerProviderCommands(program: Command): void {
  const provider = program
    .command("provider")
    .description("Manage AI providers configured in omninode.yaml.");

  provider
    .command("list")
    .description("List configured providers.")
    .action(async () => {
      const config = loadConfig();
      const providers = config.project.providers;
      if (providers.length === 0) {
        console.log(
          "No providers configured. Add one under `project.providers` in omninode.yaml.",
        );
        return;
      }
      for (const provider of providers) {
        const key = provider.apiKeyEnvVar ? `$${provider.apiKeyEnvVar}` : "none";
        const enabled = provider.enabled === false ? "  (disabled)" : "";
        console.log(
          `${provider.name}  type=${provider.type}  base_url=${provider.baseUrl}  key=${key}${enabled}`,
        );
      }
    });

  provider
    .command("add")
    .description("Add a provider (planned for Phase 1 — Provider Infrastructure).")
    .action(() => {
      throw notImplemented("omninode provider add", "Phase 1 (Provider Infrastructure)");
    });
}

export function notImplemented(command: string, phase: string): OmniNodeError {
  return new OmniNodeError(
    "NOT_IMPLEMENTED",
    `${command} is planned for ${phase}. Edit omninode.yaml directly for now.`,
  );
}
