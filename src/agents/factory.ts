/**
 * Agent factory (§9–§10): builds adapter instances from configuration.
 * "cli" agent configs are mapped to the process integration by the loader.
 */
import { OmniNodeError } from "../errors/index.js";
import type { AgentConfig, IAgent } from "../types/agent.js";
import { ProcessAgent } from "./process/index.js";

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
