import type { Command } from "commander";
import { OmniNodeError } from "../../errors/index.js";
import { createProvider } from "../../providers/index.js";
import { ModelRegistry } from "../../registry/index.js";
import type { ModelCapabilities } from "../../types/model.js";
import { loadProjectConfig } from "../options.js";
const CAPABILITIES: readonly (keyof ModelCapabilities)[] = [
  "chat",
  "coding",
  "tools",
  "vision",
  "embeddings",
];

export function registerModelsCommand(program: Command): void {
  for (const name of ["models", "model"] as const) {
    registerModelGroup(program, name);
  }
}

function registerModelGroup(program: Command, name: "models" | "model"): void {
  program
    .command(name)
    .description("Discover and list models from configured providers (model registry, §8).")
    .argument("[provider]", "Only discover from this provider.")
    .option("-c, --capability <capability>", `Filter by capability: ${CAPABILITIES.join(", ")}.`)
    .option("--json", "Emit the discovered models as JSON.")
    .action(async (providerName: string | undefined, options: { capability?: string; json?: boolean }) => {
      const capability = options.capability as keyof ModelCapabilities | undefined;
      if (capability !== undefined && !CAPABILITIES.includes(capability)) {
        throw new OmniNodeError(
          "CLI_USAGE",
          `Unknown capability "${options.capability}". Valid capabilities: ${CAPABILITIES.join(", ")}.`,
        );
      }

      const config = loadProjectConfig();
      const selected = config.project.providers.filter((p) =>
        providerName ? p.name === providerName : true,
      );
      if (selected.length === 0) {
        if (options.json) {
          console.log("[]");
          return;
        }
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
      if (options.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
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
