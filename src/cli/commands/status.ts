import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { createMemoryProvider, MemoryService } from "../../memory/index.js";
import { FilePlanStore } from "../../planner/store.js";
import { FileReportStore } from "../../reports/store.js";
import { FileTaskStore } from "../../tasks/store.js";
import { FilePipelineRunStore } from "../../pipelines/store.js";
import { OMNINODE_VERSION } from "../../version.js";

function countBy<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) return "0";
  return `${items.length} (${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")})`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the project's OmniNode state overview (config, tasks, runs, reports, plans, memory).")
    .action(async () => {
      const config = loadConfig();

      console.log(`OmniNode v${OMNINODE_VERSION} — project "${config.project.name}"`);
      console.log(
        `providers: ${config.project.providers.length > 0 ? config.project.providers.map((p) => p.name).join(", ") : "none"}`,
      );
      console.log(
        `agents:    ${config.project.agents.length > 0 ? config.project.agents.map((a) => a.name).join(", ") : "none"}`,
      );
      console.log(
        `roles:     ${config.project.roles.length > 0 ? config.project.roles.map((r) => r.id).join(", ") : "none"}`,
      );
      console.log(
        `pipelines: ${config.project.pipelines.length > 0 ? config.project.pipelines.map((p) => p.id).join(", ") : "none"}`,
      );

      const tasks = await new FileTaskStore().list();
      console.log(`tasks:     ${countBy(tasks, (t) => t.status)}`);

      const runs = await new FilePipelineRunStore().list();
      console.log(`runs:      ${countBy(runs, (r) => r.status)}`);

      const reportStore = new FileReportStore();
      const reports = await reportStore.listReports();
      const combined = await reportStore.listCombined();
      console.log(`reports:   ${reports.length} raw, ${combined.length} combined`);

      const plans = await new FilePlanStore().list();
      console.log(`plans:     ${plans.length}`);

      if (config.project.memory !== undefined) {
        const memory = new MemoryService(createMemoryProvider(config.project.memory));
        const entries = await memory.providerRef.query({ limit: 10_000 });
        console.log(`memory:    ${memory.providerName}, ${entries.length} entr(ies)`);
      } else {
        console.log("memory:    not configured (local provider available — add a `memory:` section)");
      }
    });
}
