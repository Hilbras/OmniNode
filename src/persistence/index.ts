/**
 * Persistence layer (v2 Phase 1): one entry point to every local store.
 *
 * All stores are interfaces with a local JSON default
 * (TaskStore, PipelineRunStore, ReportStore, PlanStore, IMemoryProvider,
 * AuditSink) — see docs/API.md for the inventory and stability status.
 */
import { FileAuditLog } from "../audit/index.js";
import { LocalMemoryProvider } from "../memory/local.js";
import { FilePipelineRunStore } from "../pipelines/store.js";
import { FilePlanStore } from "../planner/store.js";
import { FileReportStore } from "../reports/store.js";
import { FileTaskStore } from "../tasks/store.js";

export { JsonFileStore } from "./json-file-store.js";
export type { JsonDocument, JsonFileStoreOptions } from "./json-file-store.js";

/** Bundles every store for a single project directory. */
export class ProjectStores {
  readonly tasks: FileTaskStore;
  readonly pipelineRuns: FilePipelineRunStore;
  readonly reports: FileReportStore;
  readonly plans: FilePlanStore;
  readonly memory: LocalMemoryProvider;
  readonly audit: FileAuditLog;

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.tasks = new FileTaskStore(directory);
    this.pipelineRuns = new FilePipelineRunStore(directory);
    this.reports = new FileReportStore(directory);
    this.plans = new FilePlanStore(directory);
    this.memory = new LocalMemoryProvider(directory);
    this.audit = new FileAuditLog(directory);
  }
}