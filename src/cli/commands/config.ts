/**
 * `omninode config` — inspect the loaded configuration. Secrets are never
 * printed: only environment-variable *references* are shown (roadmap §17).
 */
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { configDiagnostics, loadConfigDetailed, scanForInlineSecrets } from "../../config/index.js";
import { OmniNodeError } from "../../errors/index.js";
import { activeConfigPath } from "../options.js";
export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect the project configuration (omninode.yaml).");

  config
    .command("path")
    .description("Print the path of the configuration file in use.")
    .action(() => {
      const path = activeConfigPath();
      console.log(path ?? "no omninode.yaml found");
    });

  config
    .command("show")
    .description("Print the effective configuration (credential references only, never values).")
    .option("--json", "Emit the configuration as JSON.")
    .action((options: { json?: boolean }) => {
      const resolved = loadConfigDetailed().config;
      const payload = {
        project: resolved.project.name,
        providers: resolved.project.providers.map((p) => ({
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          apiKeyEnvVar: p.apiKeyEnvVar ?? null,
        })),
        agents: resolved.project.agents.map((a) => ({ name: a.name, command: a.command ?? null, inputMode: a.inputMode })),
        roles: resolved.project.roles.map((r) => r.id),
        pipelines: resolved.project.pipelines.map((p) => p.id),
        memory: resolved.project.memory ?? null,
        logging: resolved.logging ?? null,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`project:   ${payload.project}`);
      console.log(`providers: ${payload.providers.map((p) => `${p.name} (${p.type}, key=${p.apiKeyEnvVar ? `$${p.apiKeyEnvVar}` : "none"})`).join(", ") || "none"}`);
      console.log(`agents:    ${payload.agents.map((a) => a.name).join(", ") || "none"}`);
      console.log(`roles:     ${payload.roles.join(", ") || "none"}`);
      console.log(`pipelines: ${payload.pipelines.join(", ") || "none"}`);
      console.log(`memory:    ${payload.memory ? `${payload.memory.provider}${payload.memory.required ? " (required)" : ""}` : "not configured"}`);
    });

  config
    .command("profiles")
    .description("List the configuration profiles defined in this project.")
    .action(() => {
      const path = activeConfigPath();
      const raw = path ? (parseYaml(readFileSync(path, "utf8")) as { profile?: string; profiles?: Record<string, unknown> }) : {};
      const names = Object.keys(raw.profiles ?? {});
      const active = loadConfigDetailed().sources.profile;
      console.log(`active:  ${active}`);
      console.log(`defined: ${names.length > 0 ? names.join(", ") : "none (add a `profiles:` section)"}`);
    });

  config
    .command("validate")
    .description("Validate the configuration file, including the inline-secret scan.")
    .action(() => {
      const path = activeConfigPath();
      if (!path) throw new OmniNodeError("CONFIG_NOT_FOUND", "No omninode.yaml found.");
      const findings = scanForInlineSecrets(readFileSync(path, "utf8"));
      if (findings.length > 0) {
        throw new OmniNodeError(
          "CONFIG_INVALID",
          `${path} contains ${findings.length} inline secret(s) (line ${findings.map((f) => f.line).join(", ")}). Use environment-variable references.`,
        );
      }
      const { config: resolved, sources } = loadConfigDetailed();
      console.log(
        `${path} is valid — project "${resolved.project.name}" with ${resolved.project.providers.length} provider(s), ${resolved.project.agents.length} agent(s), ${resolved.project.pipelines.length} pipeline(s).`,
      );
      console.log(`  profile:  ${sources.profile}`);
      if (sources.userFile) console.log(`  user cfg: ${sources.userFile}`);
      if (sources.envOverrides.length > 0) {
        console.log(`  env overrides: ${sources.envOverrides.join(", ")}`);
      }
      if (sources.defaults.length > 0) {
        console.log(`  defaults applied: ${sources.defaults.join(", ")}`);
      }
      const diagnostics = configDiagnostics(resolved);
      if (diagnostics.length > 0) {
        console.log("  diagnostics:");
        for (const note of diagnostics) console.log(`    - ${note}`);
      }
    });
}
