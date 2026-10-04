/**
 * Audit logging (§24): append-only JSONL record of lifecycle events
 * (task/pipeline transitions) in the project's .omninode directory. Useful
 * for compliance reviews and debugging multi-agent runs.
 */
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { logger, type Logger } from "../logger/index.js";

export type AuditAction =
  | "task.created"
  | "task.queued"
  | "task.running"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.retry"
  | "pipeline.run.started"
  | "pipeline.run.finished"
  | "pipeline.run.failed"
  | "pipeline.run.cancelled"
  | "plan.generated"
  | "agent.started"
  | "agent.completed"
  | "provider.error"
  | "memory.context.gathered"
  | "memory.outcome.recorded";

/**
 * Every event carries correlation ids so a failed execution can be traced
 * across task → execution → pipeline run → agent → provider (roadmap §18).
 */
export interface AuditEvent {
  at: string;
  action: AuditAction;
  project?: string;
  /** Primary subject: task id, pipeline run id, plan id… */
  id?: string;
  taskId?: string;
  pipelineId?: string;
  executionId?: string;
  agentId?: string;
  providerId?: string;
  actor?: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/** Default rotation threshold: the audit log is rotated past this size (§24). */
export const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Append-only JSONL sink. Failures are logged, never propagated. */

export class FileAuditLog implements AuditSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly log: Logger;

  constructor(
    directory = `${process.cwd()}/.omninode`,
    log: Logger = logger,
    maxBytes: number = DEFAULT_AUDIT_MAX_BYTES,
  ) {
    this.filePath = `${directory}/audit.jsonl`;
    this.maxBytes = maxBytes;
    this.log = log.child({ component: "audit" });
  }

  /** Rotates the log once it passes the size budget, keeping one backup. */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(this.filePath);
      if (stats.size <= this.maxBytes) return;
      await rename(this.filePath, `${this.filePath}.1`);
    } catch {
      // No log yet, or rotation raced — nothing to do.
    }
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      // Append-only: a crash can tear the last line, which `recent()` skips.
      // fsync-per-event would make every execution wait on the disk.
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      this.log.warn(
        `Audit write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Recent events, oldest first; used by the CLI. */
  async recent(limit = 20): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const events = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return undefined;
        }
      })
      .filter((event): event is AuditEvent => event !== undefined);
    return events.slice(-limit);
  }
}