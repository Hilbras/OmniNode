import type { Command } from "commander";
import { agentConfigSchema, loadConfig } from "../../config/index.js";
import { AgentError, OmniNodeError } from "../../errors/index.js";
import { createAgent } from "../../agents/index.js";
import { appendToConfigList } from "./shared.js";
import { registerAgentInspect } from "./inspect.js";

const collectArgs = (value: string, previous: string[]): string[] => [...previous, value];

interface AddAgentOptions {
  name: string;
  command: string;
  arg?: string[];
  cwd?: string;
  inputMode: string;
  timeoutMs?: number;
  envPolicy?: string;
  allowEnv?: string[];
  denyEnv?: string[];
  maxOutputBytes?: number;
  allowExternalCwd?: boolean;
}

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
        console.log("No agents configured. Add one with `omninode agent add` or edit omninode.yaml.");
        return;
      }
      for (const agent of agents) {
        const command = agent.command ?? "(no command)";
        console.log(
          `${agent.name}  integration=${agent.integration}  command=${command}  input=${agent.inputMode ?? "stdin"}`,
        );
      }
    });

  agent
    .command("add")
    .description(
      "Register a CLI agent in omninode.yaml. Agents run as child processes " +
        "(stdin/stdout); native adapters come in a later phase.",
    )
    .requiredOption("--name <name>", "Unique agent name.")
    .requiredOption("--command <command>", "Executable command, e.g. opencode")
    .option("--arg <value>", "Additional command argument (repeatable).", collectArgs, [])
    .option("--cwd <dir>", "Working directory for the agent process.")
    .option(
      "--input-mode <mode>",
      "How the task is delivered: stdin (prompt on stdin), arg (prompt as last argument) or protocol (§21 JSON-lines task protocol).",
      "stdin",
    )
    .option("--env-policy <policy>", "Environment policy: inherit, allowlist, denylist or explicit.")
    .option("--allow-env <name>", "Variable to forward under the allowlist policy (repeatable).", collectArgs)
    .option("--deny-env <name>", "Variable to remove under the denylist policy (repeatable).", collectArgs)
    .option("--max-output-bytes <n>", "Per-stream output budget in bytes (default 5 MiB).", (value: string) => Number(value))
    .option("--allow-external-cwd", "Allow a working directory outside the project root.")
    .option("--timeout-ms <ms>", "Per-task timeout in milliseconds.", (value: string) =>
      Number(value),
    )
    .action(async (options: AddAgentOptions) => addAgent(options));

  agent
    .command("test <name>")
    .description("Verify the OmniNode ↔ agent connection by sending a trivial task.")
    .action(async (name: string) => testAgent(name));
  registerAgentInspect(agent);
}

export async function addAgent(options: AddAgentOptions): Promise<void> {
  const candidate = agentConfigSchema.safeParse({
    name: options.name,
    type: "cli",
    command: options.command,
    ...(options.arg !== undefined && options.arg.length > 0 ? { args: options.arg } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    input_mode: options.inputMode,
    ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
    ...(options.envPolicy !== undefined ? { env_policy: options.envPolicy } : {}),
    ...(options.allowEnv !== undefined && options.allowEnv.length > 0
      ? { env_allowlist: options.allowEnv }
      : {}),
    ...(options.denyEnv !== undefined && options.denyEnv.length > 0
      ? { env_denylist: options.denyEnv }
      : {}),
    ...(options.maxOutputBytes !== undefined ? { max_output_bytes: options.maxOutputBytes } : {}),
    ...(options.allowExternalCwd !== undefined ? { allow_external_cwd: options.allowExternalCwd } : {}),
  });
  if (!candidate.success) {
    const issues = candidate.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new OmniNodeError("CLI_USAGE", `Invalid agent options: ${issues}`);
  }
  const newAgent = candidate.data;

  const existing = loadConfig();
  if (existing.project.agents.some((a) => a.name === newAgent.name)) {
    throw new OmniNodeError(
      "CLI_USAGE",
      `Agent "${newAgent.name}" already exists in omninode.yaml. Remove it first or pick another name.`,
    );
  }

  const configPath = appendToConfigList("agents", newAgent);
  console.log(`Added agent "${newAgent.name}" (${newAgent.type}, input=${newAgent.input_mode}) to ${configPath}.`);
  console.log(`Run \`omninode agent test ${newAgent.name}\` to verify the connection.`);
}

export async function testAgent(name: string): Promise<void> {
  const config = loadConfig();
  const agentConfig = config.project.agents.find((a) => a.name === name);
  if (!agentConfig) {
    const available = config.project.agents.map((a) => a.name).join(", ") || "(none)";
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `Agent "${name}" is not configured. Configured agents: ${available}.`,
    );
  }

  const agent = createAgent(agentConfig);
  console.log(
    `Testing agent "${name}" (${agent.info.integration}, input=${agentConfig.inputMode ?? "stdin"}) — sending a trivial task.`,
  );
  const result = await agent.run({
    taskId: `test-${Date.now()}`,
    objective: "Reply with the single word: OK",
  });
  console.log(`  status: ${result.status}`);
  if (result.exitCode !== undefined) console.log(`  exit:   ${result.exitCode}`);
  if (result.summary) console.log(`  output: ${result.summary}`);
  if (result.rawOutput && result.rawOutput !== result.summary) {
    console.log(`  raw:    ${result.rawOutput.slice(0, 200).replace(/\n/g, " ")}`);
  }
  if (result.error) console.log(`  error:  ${result.error}`);
  if (result.status !== "completed") process.exitCode = 1;
}
