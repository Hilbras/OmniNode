import type { Command } from "commander";
import { FileAuditLog } from "../../audit/index.js";

export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Show the recent audit log — task and pipeline lifecycle events (§24).")
    .option("-n, --limit <count>", "Number of events to show (default 20).", (value: string) => Number(value), 20)
    .action(async (options: { limit: number }) => {
      const events = await new FileAuditLog().recent(options.limit);
      if (events.length === 0) {
        console.log("No audit events recorded yet.");
        return;
      }
      for (const event of events) {
        const id = event.id ? ` ${event.id}` : "";
        const detail = event.detail && Object.keys(event.detail).length > 0
          ? ` ${JSON.stringify(event.detail)}`
          : "";
        console.log(`${event.at}  ${event.action}${id}${detail}`);
      }
    });
}