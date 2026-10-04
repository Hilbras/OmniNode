/** Agent registry (§10): the set of agents connected to OmniNode. */
import type { IAgent } from "../types/agent.js";

export class AgentRegistry {
  private readonly agents = new Map<string, IAgent>();

  register(agent: IAgent): void {
    this.agents.set(agent.info.name, agent);
  }

  get(name: string): IAgent | undefined {
    return this.agents.get(name);
  }

  list(): IAgent[] {
    return [...this.agents.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }
}
