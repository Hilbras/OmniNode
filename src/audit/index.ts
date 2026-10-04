/**
 * Audit logging (§24): append-only JSONL record of lifecycle events
 * (task/pipeline transitions) in the project's .omninode directory. Useful
 * for compliance reviews and debugging multi-agent runs.
 */
import { appendFile, mkdir } from "node:fs/promises";
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
  | "plan.generated"
  | "memory.context.gathered"
  | "memory.outcome.recorded";

export interface AuditEvent {
  at: string;
  action: AuditAction;
  project?: string;
  id?: string;
  actor?: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/** Append-only JSONL sink. Failures are logged, never propagated. */
export class FileAuditLog implements AuditSink {
  private readonly filePath: string;
  private readonly log: Logger;

  constructor(directory = `${process.cwd()}/.omninode`, log: Logger = logger) {
    this.filePath = `${directory}/audit.jsonl`;
    this.log = log.child({ component: "audit" });
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      this.log.warn(
        `Audit write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Recent events, oldest first; used by the CLI. */
  async recent(limit = 20): Promise<AuditEvent[]> {
    const { readFile } = await import("node:fs/promises");
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