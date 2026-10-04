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
import { AgentAdapterRegistry, ProcessAgentAdapter } from "./adapters.js";

/**
 * Registry consulted first so native/API-level integrations plug in without
 * touching core (roadmap §8, Native Adapters).
 */
export const defaultAgentAdapters = new AgentAdapterRegistry();
defaultAgentAdapters.register(new ProcessAgentAdapter((config) => new ProcessAgent(config)));

export function createAgent(config: AgentConfig, adapters: AgentAdapterRegistry = defaultAgentAdapters): IAgent {
  const registered = adapters.get(config.integration);
  if (registered) return registered.create(config);
  if (config.integration === "native") {
    throw new OmniNodeError(
      "NOT_IMPLEMENTED",
      `No native adapter is registered for "${config.name}". Register an IAgentAdapter ` +
        `(createAgent(config, adapters)) or use input over stdin/stdout (type "cli").`,
    );
  }
  throw new OmniNodeError("NOT_IMPLEMENTED", `Agent integration "${config.integration}" has no adapter yet.`);
}

export { AgentAdapterRegistry } from "./adapters.js";
export type { IAgentAdapter } from "./adapters.js";

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
