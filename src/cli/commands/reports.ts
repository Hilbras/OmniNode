import type { Command } from "commander";
import { OmniNodeError } from "../../errors/index.js";
import { ReportService } from "../../reports/index.js";
import { FileReportStore } from "../../reports/store.js";
import { truncate } from "./shared.js";

function service(): ReportService {
  return new ReportService(new FileReportStore());
}

export function registerReportCommands(program: Command): void {
  const report = program
    .command("report")
    .description("Inspect AI reports collected from tasks and pipelines (§16–§17).");

  report
    .command("list")
    .description("List stored reports.")
    .option("--task <taskId>", "Only reports for this task.")
    .option("--agent <name>", "Only reports from this agent.")
    .option("--json", "Emit reports as JSON.")
    .action(async (options: { task?: string; agent?: string; json?: boolean }) => {
      const svc = service();
      const reports = await svc.storeRef.listReports({
        ...(options.task !== undefined ? { taskId: options.task } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      if (reports.length === 0) {
        console.log("No reports stored yet. Run a pipeline to collect some.");
        return;
      }
      for (const r of reports) {
        console.log(`${r.id}  ${r.agent.padEnd(10)} ${truncate(r.summary, 60)}`);
      }
    });

  report
    .command("combined")
    .description("List combined reports (aggregated intelligence, §17).")
    .option("--run <pipelineRunId>", "Only combined reports for this pipeline run.")
    .option("--json", "Emit combined reports as JSON.")
    .action(async (options: { run?: string; json?: boolean }) => {
      const svc = service();
      const combined = await svc.storeRef.listCombined({
        ...(options.run !== undefined ? { pipelineRunId: options.run } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(combined, null, 2));
        return;
      }
      if (combined.length === 0) {
        console.log("No combined reports stored yet. Run a pipeline to generate one.");
        return;
      }
      for (const c of combined) {
        const conflicts = c.conflicts.length > 0 ? `  ${c.conflicts.length} CONFLICT(S)` : "";
        console.log(
          `${c.id}  ${c.findings.length} finding(s) from ${c.sources.length} source(s)` +
            `${conflicts}${c.pipelineRunId ? `  run=${c.pipelineRunId}` : ""}`,
        );
      }
    });

  report
    .command("show <id>")
    .description("Show a stored report or combined report in full.")
    .action(async (id: string) => {
      const svc = service();
      const reports = await svc.storeRef.listReports();
      const raw = reports.find((r) => r.id === id);
      if (raw) {
        console.log(`Report ${raw.id}`);
        console.log(`  agent:     ${raw.agent}${raw.model ? ` (${raw.model})` : ""}`);
        console.log(`  task:      ${raw.taskId}`);
        console.log(`  summary:   ${raw.summary}`);
        if (raw.findings.length > 0) {
          console.log("  findings:");
          for (const finding of raw.findings) {
            console.log(`    - [${finding.severity ?? "info"}] ${finding.title}`);
            for (const evidence of finding.evidence ?? []) {
              console.log(`      evidence: ${evidence}`);
            }
          }
        }
        if (raw.recommendations.length > 0) {
          console.log("  recommendations:");
          for (const recommendation of raw.recommendations) {
            console.log(`    - ${recommendation}`);
          }
        }
        return;
      }

      const combined = await svc.storeRef.getCombined(id);
      if (combined) {
        console.log(`Combined report ${combined.id}`);
        console.log(`  sources:   ${combined.sources.join(", ")}`);
        console.log(`  reports:   ${combined.reportIds.length}`);
        if (combined.pipelineRunId) console.log(`  run:       ${combined.pipelineRunId}`);
        console.log(`  summary:   ${combined.summary}`);
        if (combined.conflicts.length > 0) {
          console.log(`  CONFLICTS (${combined.conflicts.length}) — both positions preserved:`);
          for (const conflict of combined.conflicts) {
            console.log(`    ! ${conflict.findingTitle} [${conflict.type}]`);
            for (const position of conflict.positions) {
              console.log(
                `        ${position.agent}: severity=${position.severity ?? "unstated"}` +
                  `${position.recommendation ? ` fix="${position.recommendation}"` : ""}`,
              );
            }
            console.log(`        ${conflict.note}`);
          }
        }
        if (combined.agreements.length > 0) {
          console.log(`  agreements: ${combined.agreements.length} (multi-agent consensus)`);
        }
        if (combined.findings.length > 0) {
          console.log("  findings (grouped, duplicates merged):");
          for (const finding of combined.findings) {
            console.log(
              `    - [${finding.severity ?? "info"}] ${finding.title} (x${finding.occurrences}, sources: ${finding.sources.map((s) => s.agent).join(", ")})`,
            );
          }
        }
        if (combined.recommendations.length > 0) {
          console.log("  recommendations:");
          for (const recommendation of combined.recommendations) {
            console.log(`    - ${recommendation.text} (x${recommendation.occurrences})`);
          }
        }
        return;
      }

      throw new OmniNodeError("REPORT_NOT_FOUND", `Report "${id}" was not found in the report store.`);
    });
}
