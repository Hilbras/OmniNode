import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parseDocument } from "yaml";
import { appConfigSchema, findConfigFile, loadConfig, providerConfigSchema } from "../../config/index.js";
import { ConfigError, OmniNodeError, ProviderError } from "../../errors/index.js";
import { createProvider } from "../../providers/index.js";
import { notImplemented } from "./shared.js";

interface AddProviderOptions {
  name: string;
  baseUrl: string;
  type: string;
  apiKeyEnvVar?: string;
}

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
          "No providers configured. Add one with `omninode provider add` or edit omninode.yaml.",
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
    .description(
      "Add a provider to omninode.yaml. OpenAI-compatible gateways (including OpenRouter " +
        "and local runtimes) are supported today; OmniHilbras gets its own adapter in Phase 2.",
    )
    .requiredOption("--name <name>", "Unique provider name used in configuration and the model registry.")
    .requiredOption("--base-url <url>", "Provider base URL, e.g. https://example.com/v1")
    .option(
      "--type <type>",
      "Provider type: openai-compatible, omnihilbras, openrouter, local or custom.",
      "openai-compatible",
    )
    .option(
      "--api-key-env-var <envVar>",
      "Environment variable holding the API key. Keys are never written to the config file.",
    )
    .action(async (options: AddProviderOptions) => addProvider(options));

  provider
    .command("test <name>")
    .description("Test connectivity, authentication and model discovery for a configured provider.")
    .action(async (name: string) => testProvider(name));

  provider
    .command("remove <name>")
    .description("Remove a provider (planned for Phase 1 follow-up).")
    .action(() => {
      throw notImplemented("omninode provider remove", "a Phase 1 follow-up");
    });
}

export async function addProvider(options: AddProviderOptions): Promise<void> {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new OmniNodeError("CONFIG_NOT_FOUND", "No omninode.yaml found. Run `omninode init` first.");
  }

  const candidate = providerConfigSchema.safeParse({
    name: options.name,
    type: options.type,
    base_url: options.baseUrl,
    ...(options.apiKeyEnvVar !== undefined ? { api_key_env_var: options.apiKeyEnvVar } : {}),
  });
  if (!candidate.success) {
    const issues = candidate.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new OmniNodeError("CLI_USAGE", `Invalid provider options: ${issues}`);
  }
  const newProvider = candidate.data;

  const existing = loadConfig();
  if (existing.project.providers.some((p) => p.name === newProvider.name)) {
    throw new OmniNodeError(
      "CLI_USAGE",
      `Provider "${newProvider.name}" already exists in ${configPath}.`,
    );
  }

  // Edit as a YAML document so existing comments and formatting survive.
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (doc.getIn(["project", "providers"]) === undefined) {
    doc.setIn(["project", "providers"], [newProvider]);
  } else {
    doc.addIn(["project", "providers"], newProvider);
  }

  const validated = appConfigSchema.safeParse(doc.toJS());
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(
      "CONFIG_INVALID",
      `Editing ${configPath} would produce an invalid configuration: ${issues}`,
    );
  }

  writeFileSync(configPath, doc.toString(), "utf8");
  console.log(`Added provider "${newProvider.name}" (${newProvider.type}) to ${configPath}.`);
  if (newProvider.api_key_env_var) {
    console.log(
      `Set $${newProvider.api_key_env_var} in your environment, then run: omninode provider test ${newProvider.name}`,
    );
  } else {
    console.log(`Run \`omninode provider test ${newProvider.name}\` to verify connectivity.`);
  }
}

export async function testProvider(name: string): Promise<void> {
  const config = loadConfig();
  const providerConfig = config.project.providers.find((p) => p.name === name);
  if (!providerConfig) {
    const available = config.project.providers.map((p) => p.name).join(", ") || "(none)";
    throw new ProviderError(
      "PROVIDER_NOT_FOUND",
      `Provider "${name}" is not configured. Configured providers: ${available}.`,
    );
  }

  const provider = createProvider(providerConfig);
  console.log(`Testing provider "${name}" (${providerConfig.type}) at ${provider.config.baseUrl}`);
  const health = await provider.healthCheck();
  console.log(`  health:    ${health.health}`);
  console.log(`  connected: ${health.connected}`);
  console.log(`  models:    ${health.modelCount}`);
  if (health.message) console.log(`  detail:    ${health.message}`);
  if (!health.connected) process.exitCode = 1;
}
