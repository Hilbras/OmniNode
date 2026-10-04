/**
 * Memory service (§19–§20): gathers relevant memory before a task runs and
 * records outcomes afterwards — the Task → memory → relevant context →
 * agents → reports → memory loop. Memory failures are best-effort: they log
 * a warning and never fail a task, because memory is an enhancement, not a
 * dependency (§2).
 */
import { logger, type Logger } from "../logger/index.js";
import type { IMemoryProvider, MemoryEntry, MemoryScope } from "../types/memory.js";
import type { Task } from "../types/task.js";

export interface MemoryContextQuery {
  objective: string;
  role?: string;
  project?: string;
}

const MAX_CONTEXT_CHARS = 4_000;

export class MemoryService {
  private readonly log: Logger;

  constructor(
    private readonly provider: IMemoryProvider,
    log: Logger = logger,
  ) {
    this.log = log.child({ component: "memory", provider: provider.name });
  }

  get providerRef(): IMemoryProvider {
    return this.provider;
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** Relevant context for a task objective; empty string when nothing matches. */
  async gatherContext(query: MemoryContextQuery): Promise<string> {
    try {
      const entries = await this.provider.query({
        text: query.objective,
        ...(query.role ? { tags: [query.role] } : {}),
        limit: 8,
      });
      if (entries.length === 0) return "";
      const byScope = new Map<MemoryScope, MemoryEntry[]>();
      for (const entry of entries) {
        byScope.set(entry.scope, [...(byScope.get(entry.scope) ?? []), entry]);
      }
      const parts: string[] = [];
      for (const scope of ["project", "task", "role", "knowledge"] as MemoryScope[]) {
        const scopeEntries = byScope.get(scope) ?? [];
        if (scopeEntries.length === 0) continue;
        const lines = scopeEntries.map((entry) => `- ${entry.content}`).join("\n");
        parts.push(`### Relevant memory (${scope})\n${lines}`);
      }
      const context = parts.join("\n\n");
      return context.length > MAX_CONTEXT_CHARS ? `${context.slice(0, MAX_CONTEXT_CHARS)}…` : context;
    } catch (error) {
      this.log.warn(
        `Memory query failed (continuing without memory): ${error instanceof Error ? error.message : String(error)}`,
      );
      return "";
    }
  }

  /** Records a finished task's outcome — best-effort. */
  async recordTaskOutcome(task: Task): Promise<void> {
    const outcome = task.result?.summary ?? task.result?.error ?? "(no output)";
    try {
      await this.provider.write({
        key: `task:${task.id}`,
        scope: "task",
        content: `Objective: ${task.objective}\nStatus: ${task.status}\nOutcome: ${outcome}`,
        tags: ["task", ...(task.agent ? [task.agent] : []), ...(task.role ? [task.role] : [])],
        createdAt: task.createdAt,
      });
      // Significant findings become project-level "known problems" (§19).
      const significant = (task.result?.reports ?? []).flatMap((report) =>
        report.findings
          .filter((finding) => finding.severity === "high" || finding.severity === "critical")
          .map((finding) => ({ report, finding })),
      );
      for (const { report, finding } of significant) {
        await this.provider.write({
          key: `finding:${report.id}:${finding.id}`,
          scope: "project",
          content: `[${finding.severity}] ${finding.title} — ${finding.detail}`,
          tags: ["known-problem", report.agent],
        });
      }
    } catch (error) {
      this.log.warn(
        `Memory write failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
