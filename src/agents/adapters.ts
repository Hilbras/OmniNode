/**
 * Agent adapter registry (roadmap §8, Native Adapters).
 *
 * New integration styles (native/API-level agents) plug in here without
 * changing OmniNode core: register an `IAgentAdapter` and `createAgent`
 * consults the registry before falling back to the process adapter.
 */
import { AgentError } from "../errors/index.js";
import type { AgentConfig, IAgent } from "../types/agent.js";

export interface IAgentAdapter {
  /** Integration type this adapter serves, e.g. "native" or "process". */
  readonly integration: string;
  create(config: AgentConfig): IAgent;
}

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, IAgentAdapter>();

  register(adapter: IAgentAdapter): void {
    this.adapters.set(adapter.integration, adapter);
  }

  get(integration: string): IAgentAdapter | undefined {
    return this.adapters.get(integration);
  }

  list(): IAgentAdapter[] {
    return [...this.adapters.values()];
  }

  create(config: AgentConfig): IAgent {
    const adapter = this.get(config.integration);
    if (!adapter) {
      throw new AgentError(
        "AGENT_NOT_FOUND",
        `No agent adapter registered for integration "${config.integration}". ` +
          `Registered: ${[...this.adapters.keys()].join(", ") || "(none)"}.`,
      );
    }
    return adapter.create(config);
  }
}

/** Process-level adapter — the built-in CLI integration. */
export class ProcessAgentAdapter implements IAgentAdapter {
  readonly integration = "process";

  constructor(private readonly factory: (config: AgentConfig) => IAgent) {}

  create(config: AgentConfig): IAgent {
    return this.factory(config);
  }
}