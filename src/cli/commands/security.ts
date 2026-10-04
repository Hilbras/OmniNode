/**
 * `omninode security audit` — reviews a project's configuration against the
 * security baseline (roadmap §17) and reports findings. Advisory: it reports,
 * it does not change anything.
 */
import type { Command } from "commander";
import { resolveEnvPolicy } from "../../agents/env.js";
import { loadProjectConfig } from "../options.js";
type Severity = "info" | "warn";

interface Finding {
  severity: Severity;
  subject: string;
  message: string;
}

export function registerSecurityCommand(program: Command): void {
  program
    .command("security")
    .description("Inspect a project's security posture (advisory).")
    .argument("[action]", "Action to perform.", "audit")
    .action(async (action: string) => {
      if (action !== "audit") {
        console.log(`Unknown security action "${action}". Available: audit.`);
        return;
      }
      const config = loadProjectConfig();
      const findings: Finding[] = [];

      // Agents: environment exposure, working-directory reach, shell usage.
      for (const agent of config.project.agents) {
        const policy = resolveEnvPolicy(agent);
        if (policy === "inherit") {
          findings.push({
            severity: "warn",
            subject: `agent "${agent.name}"`,
            message:
              "inherits the full environment — provider keys in OmniNode's environment are visible to it. " +
              'Consider env_policy: allowlist|denylist|explicit.',
          });
        }
        if (agent.allowExternalCwd) {
          findings.push({
            severity: "info",
            subject: `agent "${agent.name}"`,
            message: "may run outside the project root (allow_external_cwd).",
          });
        }
        if (agent.env && Object.keys(agent.env).length > 0) {
          findings.push({
            severity: "info",
            subject: `agent "${agent.name}"`,
            message: `receives ${Object.keys(agent.env).length} explicit environment variable(s).`,
          });
        }
      }

      // Providers and memory: credentials must be referenced, never inline.
      for (const provider of config.project.providers) {
        if (!provider.apiKeyEnvVar) {
          findings.push({
            severity: "info",
            subject: `provider "${provider.name}"`,
            message: "no api_key_env_var — fine for keyless local endpoints, otherwise credentials cannot be resolved.",
          });
        }
      }
      if (config.project.memory?.provider === "remembera" && !config.project.memory.apiKeyEnvVar) {
        findings.push({
          severity: "warn",
          subject: "memory",
          message: 'Remembera is configured without api_key_env_var; requests will be unauthenticated.',
        });
      }

      console.log(`OmniNode security audit — project "${config.project.name}"`);
      if (findings.length === 0) {
        console.log("  no findings.");
      }
      for (const finding of findings) {
        console.log(`  [${finding.severity.toUpperCase()}] ${finding.subject}: ${finding.message}`);
      }
      console.log(
        `\nTrust model: agents execute with the permissions of the OS user running OmniNode.`,
      );
      console.log(
        `OmniNode does not sandbox agents — run untrusted agents in a container or as a dedicated user.`,
      );
    });
}
