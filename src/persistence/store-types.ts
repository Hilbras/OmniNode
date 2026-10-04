/**
 * Canonical storage interface names (roadmap §16). These alias the v1
 * interfaces so existing imports keep working while the storage contract is
 * described in one place.
 */
export type { TaskStore } from "../tasks/store.js";
export type { PipelineRunStore as PipelineStore } from "../pipelines/store.js";
export type { ReportStore } from "../reports/store.js";
export type { PlanStore } from "../planner/store.js";
export type { LocalMemoryProvider as MemoryStore } from "../memory/local.js";
export type { AuditSink as AuditStore } from "../audit/index.js";
