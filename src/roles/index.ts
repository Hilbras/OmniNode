/** Role registry (§11): the set of roles available for task assignment. */
import type { AppConfig } from "../config/index.js";
import type { RoleDefinition } from "../types/role.js";

export class RoleRegistry {
  private readonly roles = new Map<string, RoleDefinition>();

  register(role: RoleDefinition): void {
    this.roles.set(role.id, role);
  }

  registerAll(roles: RoleDefinition[]): void {
    for (const role of roles) this.register(role);
  }

  get(id: string): RoleDefinition | undefined {
    return this.roles.get(id);
  }

  list(): RoleDefinition[] {
    return [...this.roles.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Builds a role registry from the project configuration. */
export function buildRoleRegistry(config: AppConfig): RoleRegistry {
  const registry = new RoleRegistry();
  registry.registerAll(config.project.roles);
  return registry;
}
