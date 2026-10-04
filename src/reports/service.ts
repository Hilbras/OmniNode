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
import { validateReport } from "./schema.js";
import type { ReportStore } from "./store.js";

export interface CombinedMeta {
  objective?: string;
  pipelineRunId?: string;
  taskIds?: string[];
}

/** Serialized size budget for a single report (roadmap §17 — output limits). */
export const MAX_REPORT_BYTES = 256 * 1024;

export interface CollectionDiagnostics {
  collected: number;
  accepted: number;
  rejected: Array<{ key: string; reason: string; issues: string[] }>;
}

export class ReportService {
  private readonly log: Logger;
  /** Rejected reports from the last collection (§13 — malformed never enters aggregation). */
  lastDiagnostics: CollectionDiagnostics = { collected: 0, accepted: 0, rejected: [] };

  constructor(
    private readonly store: ReportStore,
    log: Logger = logger,
  ) {
    this.log = log.child({ component: "reports" });
  }

  get storeRef(): ReportStore {
    return this.store;
  }

  /** Normalizes finished tasks into reports (§17 — normalizer), validating each
   *  one so malformed reports never reach aggregation (§13). */
  async collectFromTasks(tasks: Task[]): Promise<Report[]> {
    const candidates: Report[] = [];
    for (const task of tasks) {
      const structured = task.result?.reports ?? [];
      if (structured.length > 0) {
        candidates.push(...structured);
        continue;
      }
      const text = task.result?.rawOutput ?? task.result?.summary ?? "";
      if (text.trim().length === 0) continue;
      candidates.push(
        extractReportFromText(text, {
          taskId: task.id,
          agent: task.agent ?? "unknown",
        }),
      );
    }

    const reports: Report[] = [];
    const rejected: CollectionDiagnostics["rejected"] = [];
    for (const candidate of candidates) {
      const size = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (size > MAX_REPORT_BYTES) {
        rejected.push({
          key: (candidate as { id?: string })?.id ?? "(unknown)",
          reason: `report exceeds the ${MAX_REPORT_BYTES} byte limit (${size} bytes)`,
          issues: [],
        });
        this.log.warn(`Rejected oversized report (${size} bytes).`);
        continue;
      }
      const result = validateReport(candidate);
      if (result.valid) {
        reports.push(result.report);
      } else {
        rejected.push({
          key: (candidate as { id?: string })?.id ?? "(unknown)",
          reason: result.reason,
          issues: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
        });
        this.log.warn(`Rejected malformed report: ${result.reason}`);
      }
    }
    this.lastDiagnostics = { collected: candidates.length, accepted: reports.length, rejected };
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
