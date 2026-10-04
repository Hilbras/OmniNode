/**
 * Report persistence (§16 — report storage). Same replaceable-store and
 * serialized-write patterns as the other local stores.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export class FileReportStore implements ReportStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.filePath = `${directory}/reports.json`;
  }

  async saveReports(reports: Report[]): Promise<void> {
    return this.synchronized(async () => {
      const entries = await this.load();
      for (const report of reports) {
        const index = entries.findIndex(
          (e) => e.kind === "report" && e.report.id === report.id,
        );
        const entry: StoreEntry = { kind: "report", report };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      }
      await this.write(entries);
    });
  }

  async listReports(filter: ReportFilter = {}): Promise<Report[]> {
    return this.synchronized(async () => {
      const entries = await this.load();
      return entries
        .filter((e): e is { kind: "report"; report: Report } => e.kind === "report")
        .map((e) => e.report)
        .filter((report) => (filter.taskId ? report.taskId === filter.taskId : true))
        .filter((report) => (filter.agent ? report.agent === filter.agent : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  async saveCombined(combined: CombinedReport): Promise<void> {
    return this.synchronized(async () => {
      const entries = await this.load();
      const index = entries.findIndex(
        (e) => e.kind === "combined" && e.combined.id === combined.id,
      );
      const entry: StoreEntry = { kind: "combined", combined };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      await this.write(entries);
    });
  }

  async getCombined(id: string): Promise<CombinedReport | undefined> {
    return this.synchronized(async () => {
      const entries = await this.load();
      const found = entries.find((e) => e.kind === "combined" && e.combined.id === id);
      return found?.kind === "combined" ? found.combined : undefined;
    });
  }

  async listCombined(filter: CombinedReportFilter = {}): Promise<CombinedReport[]> {
    return this.synchronized(async () => {
      const entries = await this.load();
      return entries
        .filter((e): e is { kind: "combined"; combined: CombinedReport } => e.kind === "combined")
        .map((e) => e.combined)
        .filter((combined) =>
          filter.pipelineRunId ? combined.pipelineRunId === filter.pipelineRunId : true,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  private synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<StoreEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoreEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async write(entries: StoreEntry[]): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}
