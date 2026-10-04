/**
 * Persistence layer (v2 Phase 12): one entry point to every local store,
 * the canonical storage interface names, and the migration path that upgrades
 * v1 data in place.
 */
import { FileAuditLog } from "../audit/index.js";
import { LocalMemoryProvider } from "../memory/local.js";
import { FilePipelineRunStore } from "../pipelines/store.js";
import { FilePlanStore } from "../planner/store.js";
import { FileReportStore } from "../reports/store.js";
import { FileTaskStore } from "../tasks/store.js";
import {
  SCHEMA_VERSION,
  inspectDocument,
  readDocument,
  writeFileAtomic,
  type DocumentState,
} from "./json-file-store.js";
export {
  JsonFileStore,
  SCHEMA_VERSION,
  inspectDocument,
  readDocument,
  writeFileAtomic,
} from "./json-file-store.js";
export type { JsonDocument, DocumentState, JsonFileStoreOptions, Durability } from "./json-file-store.js";

// Canonical storage interface names (roadmap §16). The v1 names above remain
// the exported API; these aliases document the mapping.
export type { TaskStore, PipelineStore, ReportStore, PlanStore, MemoryStore, AuditStore } from "./store-types.js";

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

export interface MigrationReport {
  file: string;
  state: DocumentState["status"];
  before?: number;
  after?: number;
  migrated: boolean;
  note?: string;
}

/** Every persisted store file OmniNode manages in a project. */
export const STORE_FILES = [
  "tasks.json",
  "pipelines.json",
  "reports.json",
  "plans.json",
  "memory.json",
] as const;

/**
 * Migration (roadmap §16): inspects every store file, reports its schema
 * state, and — unless `checkOnly` — rewrites v1 documents at the current
 * schema version. Idempotent and safe: unknown/future versions are reported,
 * never rewritten.
 */
export async function migrateProjectStores(
  directory = `${process.cwd()}/.omninode`,
  options: { checkOnly?: boolean } = {},
): Promise<MigrationReport[]> {
  const reports: MigrationReport[] = [];
  for (const file of STORE_FILES) {
    const path = `${directory}/${file}`;
    const state = await inspectDocument(path);
    if (state.status === "missing") {
      reports.push({ file, state: state.status, migrated: false });
      continue;
    }
    if (state.status === "current") {
      reports.push({ file, state: state.status, before: state.count, after: state.count, migrated: false });
      continue;
    }
    if (state.status === "future") {
      reports.push({
        file,
        state: state.status,
        migrated: false,
        note: `written by a newer OmniNode (schema v${state.schemaVersion}); not touched`,
      });
      continue;
    }
    if (state.status === "corrupt") {
      reports.push({ file, state: state.status, migrated: false, note: state.detail });
      continue;
    }
    // v1-legacy or empty: rewrite at the current schema version.
    const items = await readDocument<unknown>(path, undefined, false);
    if (!options.checkOnly) {
      await writeFileAtomic(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, items }, null, 2)}\n`);
    }
    const beforeCount = items.length;
    reports.push({
      file,
      state: state.status,
      before: beforeCount,
      after: items.length,
      migrated: !options.checkOnly,
      ...(options.checkOnly ? { note: "would migrate" } : {}),
    });
  }
  return reports;
}
