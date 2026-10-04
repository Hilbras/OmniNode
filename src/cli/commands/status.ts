import type { Command } from "commander";
import { createMemoryProvider, MemoryService } from "../../memory/index.js";
import { FilePlanStore } from "../../planner/store.js";
import { FileReportStore } from "../../reports/store.js";
import { FileTaskStore } from "../../tasks/store.js";
import { FilePipelineRunStore } from "../../pipelines/store.js";
import { OMNINODE_VERSION } from "../../version.js";
import { loadProjectConfig } from "../options.js";
function groupBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

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
    .option("--json", "Emit machine-readable JSON (for scripts and CI).")
    .action(async (options: { json?: boolean }) => {
      const config = loadProjectConfig();

      const tasks = await new FileTaskStore().list();
      const runs = await new FilePipelineRunStore().list();
      const reportStore = new FileReportStore();
      const reports = await reportStore.listReports();
      const combined = await reportStore.listCombined();
      const plans = await new FilePlanStore().list();

      let memory: { provider: string; entries: number } | undefined;
      if (config.project.memory !== undefined) {
        const service = new MemoryService(createMemoryProvider(config.project.memory));
        memory = {
          provider: service.providerName,
          entries: (await service.providerRef.query({ limit: 10_000 })).length,
        };
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              version: OMNINODE_VERSION,
              project: config.project.name,
              providers: config.project.providers.map((p) => p.name),
              agents: config.project.agents.map((a) => a.name),
              roles: config.project.roles.map((r) => r.id),
              pipelines: config.project.pipelines.map((p) => p.id),
              tasks: { total: tasks.length, byStatus: groupBy(tasks, (t) => t.status) },
              runs: { total: runs.length, byStatus: groupBy(runs, (r) => r.status) },
              reports: { raw: reports.length, combined: combined.length },
              plans: plans.length,
              ...(memory !== undefined ? { memory } : {}),
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`OmniNode v${OMNINODE_VERSION} — project "${config.project.name}"`);
      console.log(`providers: ${config.project.providers.map((p) => p.name).join(", ") || "none"}`);
      console.log(`agents:    ${config.project.agents.map((a) => a.name).join(", ") || "none"}`);
      console.log(`roles:     ${config.project.roles.map((r) => r.id).join(", ") || "none"}`);
      console.log(`pipelines: ${config.project.pipelines.map((p) => p.id).join(", ") || "none"}`);
      console.log(`tasks:     ${countBy(tasks, (t) => t.status)}`);
      console.log(`runs:      ${countBy(runs, (r) => r.status)}`);
      console.log(`reports:   ${reports.length} raw, ${combined.length} combined`);
      console.log(`plans:     ${plans.length}`);
      if (memory) {
        console.log(`memory:    ${memory.provider}, ${memory.entries} entr(ies)`);
      } else {
        console.log("memory:    not configured (local provider available — add a `memory:` section)");
      }
    });
}
