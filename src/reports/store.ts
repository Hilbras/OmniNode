/**
 * Report persistence (§16 — report storage). Same replaceable-store and
 * serialized-write patterns as the other local stores.
 */
import { JsonFileStore } from "../persistence/json-file-store.js";
import type { CombinedReport, Report } from "../types/report.js";

export interface ReportFilter {
  taskId?: string;
  agent?: string;
}

export interface CombinedReportFilter {
  pipelineRunId?: string;
}

export interface ReportStore {
  saveReports(reports: Report[]): Promise<void>;
  listReports(filter?: ReportFilter): Promise<Report[]>;
  saveCombined(combined: CombinedReport): Promise<void>;
  getCombined(id: string): Promise<CombinedReport | undefined>;
  listCombined(filter?: CombinedReportFilter): Promise<CombinedReport[]>;
}

type StoreEntry = { kind: "report"; report: Report } | { kind: "combined"; combined: CombinedReport };

export class FileReportStore extends JsonFileStore<StoreEntry> implements ReportStore {
  constructor(directory?: string) {
    super({ ...(directory !== undefined ? { directory } : {}), fileName: "reports.json" });
  }

  async saveReports(reports: Report[]): Promise<void> {
    await this.mutate((entries) => {
      for (const report of reports) {
        const index = entries.findIndex((e) => e.kind === "report" && e.report.id === report.id);
        const entry: StoreEntry = { kind: "report", report };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      }
      return [entries, undefined];
    });
  }

  async listReports(filter: ReportFilter = {}): Promise<Report[]> {
    return (await this.readAll())
      .filter((e): e is { kind: "report"; report: Report } => e.kind === "report")
      .map((e) => e.report)
      .filter((report) => (filter.taskId ? report.taskId === filter.taskId : true))
      .filter((report) => (filter.agent ? report.agent === filter.agent : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async saveCombined(combined: CombinedReport): Promise<void> {
    await this.mutate((entries) => {
      const index = entries.findIndex((e) => e.kind === "combined" && e.combined.id === combined.id);
      const entry: StoreEntry = { kind: "combined", combined };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      return [entries, undefined];
    });
  }

  async getCombined(id: string): Promise<CombinedReport | undefined> {
    const found = (await this.readAll()).find((e) => e.kind === "combined" && e.combined.id === id);
    return found?.kind === "combined" ? found.combined : undefined;
  }

  async listCombined(filter: CombinedReportFilter = {}): Promise<CombinedReport[]> {
    return (await this.readAll())
      .filter((e): e is { kind: "combined"; combined: CombinedReport } => e.kind === "combined")
      .map((e) => e.combined)
      .filter((combined) => (filter.pipelineRunId ? combined.pipelineRunId === filter.pipelineRunId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
