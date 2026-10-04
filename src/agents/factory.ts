/**
 * Agent factory (§9–§10): builds adapter instances from configuration.
 * "cli" agent configs are mapped to the process integration by the loader.
 */
import type { AppConfig } from "../config/index.js";
import { OmniNodeError } from "../errors/index.js";
import { logger, type Logger } from "../logger/index.js";
import type { AgentConfig, IAgent } from "../types/agent.js";
import { ProcessAgent } from "./process/index.js";
import { AgentRegistry } from "./registry.js";

export function createAgent(config: AgentConfig): IAgent {
  if (config.integration === "process") {
    return new ProcessAgent(config);
  }
  if (config.integration === "native") {
    throw new OmniNodeError(
      "NOT_IMPLEMENTED",
      `Native agent adapters are planned for a later phase. Use input over stdin/stdout (type "cli") for "${config.name}" for now.`,
    );
  }
  throw new OmniNodeError("NOT_IMPLEMENTED", `Agent integration "${config.integration}" has no adapter yet.`);
}

/** Builds an agent registry from the project configuration, skipping agents that fail to construct. */
export function buildAgentRegistry(config: AppConfig, log: Logger = logger): AgentRegistry {
  const registry = new AgentRegistry();
  for (const agentConfig of config.project.agents) {
    try {
      registry.register(createAgent(agentConfig));
    } catch (error) {
      log.warn(
        `Skipping agent "${agentConfig.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return registry;
}
