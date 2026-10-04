import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { OmniNodeError } from "../../errors/index.js";
import { createProvider } from "../../providers/index.js";
import { ModelRegistry } from "../../registry/index.js";
import type { ModelCapabilities } from "../../types/model.js";

const CAPABILITIES: readonly (keyof ModelCapabilities)[] = [
  "chat",
  "coding",
  "tools",
  "vision",
  "embeddings",
];

export function registerModelsCommand(program: Command): void {
  program
    .command("models")
    .description("Discover and list models from configured providers (model registry, §8).")
    .argument("[provider]", "Only discover from this provider.")
    .option("-c, --capability <capability>", `Filter by capability: ${CAPABILITIES.join(", ")}.`)
    .action(async (providerName: string | undefined, options: { capability?: string }) => {
      const capability = options.capability as keyof ModelCapabilities | undefined;
      if (capability !== undefined && !CAPABILITIES.includes(capability)) {
        throw new OmniNodeError(
          "CLI_USAGE",
          `Unknown capability "${options.capability}". Valid capabilities: ${CAPABILITIES.join(", ")}.`,
        );
      }

      const config = loadConfig();
      const selected = config.project.providers.filter((p) =>
        providerName ? p.name === providerName : true,
      );
      if (selected.length === 0) {
        throw new OmniNodeError(
          "PROVIDER_NOT_FOUND",
          providerName
            ? `Provider "${providerName}" is not configured.`
            : "No providers configured. Add one with `omninode provider add`.",
        );
      }

      const registry = new ModelRegistry();
      for (const providerConfig of selected) {
        try {
          const provider = createProvider(providerConfig);
          const discovered = await registry.discoverFrom(provider);
          console.log(`${providerConfig.name}: ${discovered.length} model(s)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`${providerConfig.name}: discovery failed — ${message}`);
        }
      }

      const models = registry.list({
        ...(providerName !== undefined ? { provider: providerName } : {}),
        ...(capability !== undefined ? { capability } : {}),
      });
      if (models.length === 0) {
        console.log("No models found.");
        return;
      }
      console.log("");
      for (const model of models) {
        console.log(`${model.provider}:${model.id}`);
      }
    });
}
