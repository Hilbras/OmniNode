import type { Command } from "commander";
import { loadProjectConfig } from "../options.js";
export function registerRoleCommands(program: Command): void {
  const role = program
    .command("role")
    .description("Inspect roles defined in omninode.yaml.");

  role
    .command("list")
    .description("List configured roles.")
    .option("--json", "Emit roles as JSON.")
    .action(async (options: { json?: boolean }) => {
      const config = loadProjectConfig();
      const roles = config.project.roles;
      if (options.json) {
        console.log(JSON.stringify(config.project.roles, null, 2));
        return;
      }
      if (roles.length === 0) {
        console.log("No roles configured. Add one under `project.roles` in omninode.yaml.");
        return;
      }
      for (const role of roles) {
        console.log(`${role.id}  ${role.name}`);
        for (const responsibility of role.responsibilities) {
          console.log(`  - ${responsibility}`);
        }
      }
    });
}
