/**
 * Report service (§16–§17): collects reports from finished tasks (structured
 * protocol reports when present, extraction from text otherwise), persists
 * them with source attribution and generates combined reports.
 */
import { logger, type Logger } from "../logger/index.js";
import type { Task } from "../types/task.js";
import type { Report, CombinedReport } from "../types/report.js";
import { aggregateReports, type AggregateOptions } from "./aggregate.js";
import { extractReportFromText } from "./extract.js";
import type { ReportStore } from "./store.js";

export interface CombinedMeta {
  objective?: string;
  pipelineRunId?: string;
  taskIds?: string[];
}

export class ReportService {
  private readonly log: Logger;

  constructor(
    private readonly store: ReportStore,
    log: Logger = logger,
  ) {
    this.log = log.child({ component: "reports" });
  }

  get storeRef(): ReportStore {
    return this.store;
  }

  /** Normalizes finished tasks into reports (§17 — normalizer). */
  async collectFromTasks(tasks: Task[]): Promise<Report[]> {
    const reports: Report[] = [];
    for (const task of tasks) {
      const structured = task.result?.reports ?? [];
      if (structured.length > 0) {
        reports.push(...structured);
        continue;
      }
      const text = task.result?.rawOutput ?? task.result?.summary ?? "";
      if (text.trim().length === 0) continue;
      reports.push(
        extractReportFromText(text, {
          taskId: task.id,
          agent: task.agent ?? "unknown",
        }),
      );
    }
    return reports;
  }

  async saveReports(reports: Report[]): Promise<void> {
    if (reports.length === 0) return;
    await this.store.saveReports(reports);
    this.log.info(`Stored ${reports.length} report(s).`);
  }

  async generateCombined(reports: Report[], meta: CombinedMeta = {}): Promise<CombinedReport | undefined> {
    if (reports.length === 0) return undefined;
    const options: AggregateOptions = {
      ...(meta.objective !== undefined ? { objective: meta.objective } : {}),
      ...(meta.pipelineRunId !== undefined ? { pipelineRunId: meta.pipelineRunId } : {}),
      ...(meta.taskIds !== undefined ? { taskIds: meta.taskIds } : {}),
    };
    const combined = aggregateReports(reports, options);
    await this.store.saveCombined(combined);
    this.log.info(`Generated combined report ${combined.id}.`);
    return combined;
  }
}
