/**
 * Memory service + context manager (§12, Context Retrieval):
 *
 *   Task → context query → relevant memory → context → agent/planner
 *
 * Retrieval is task-oriented and budgeted — OmniNode never loads all memory
 * into a prompt. Failures are best-effort by default; when memory is marked
 * `required`, they become fatal instead (§12, Failure Handling).
 */
import { MemoryError } from "../errors/index.js";
import { logger, type Logger } from "../logger/index.js";
import type { IMemoryProvider, MemoryEntry } from "../types/memory.js";
import type { Task } from "../types/task.js";

export interface MemoryContextQuery {
  objective: string;
  role?: string;
  project?: string;
  /** Maximum entries to consider (relevance-ranked by the provider). */
  limit?: number;
}

export interface MemoryTaskContext {
  /** Prompt-ready context text ("" when nothing relevant was found). */
  text: string;
  entries: MemoryEntry[];
  /** True when the character budget cut the context short. */
  truncated: boolean;
}

const DEFAULT_ENTRY_LIMIT = 8;
export const MAX_CONTEXT_CHARS = 4_000;

export interface MemoryServiceOptions {
  /** When true, backend failures propagate instead of being logged. */
  required?: boolean;
  maxContextChars?: number;
}

export class MemoryService {
  private readonly log: Logger;
  private readonly required: boolean;
  private readonly maxContextChars: number;

  constructor(
    private readonly provider: IMemoryProvider,
    log: Logger = logger,
    options: MemoryServiceOptions = {},
  ) {
    this.log = log.child({ component: "memory", provider: provider.name });
    this.required = options.required ?? false;
    this.maxContextChars = options.maxContextChars ?? MAX_CONTEXT_CHARS;
  }

  get providerRef(): IMemoryProvider {
    return this.provider;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get isRequired(): boolean {
    return this.required;
  }

  /** Structured, budgeted context for a task (§12 — avoid loading all memory). */
  async contextFor(query: MemoryContextQuery): Promise<MemoryTaskContext> {
    let entries: MemoryEntry[];
    try {
      entries = await this.provider.retrieve({
        text: query.objective,
        ...(query.role ? { tags: [query.role] } : {}),
        limit: query.limit ?? DEFAULT_ENTRY_LIMIT,
      });
    } catch (error) {
      return this.handleFailure("retrieve", error, { text: "", entries: [], truncated: false });
    }
    return this.format(entries);
  }

  /** Prompt-ready context text (v1 convenience wrapper). */
  async gatherContext(query: MemoryContextQuery): Promise<string> {
    return (await this.contextFor(query)).text;
  }

  /** Records a finished task's outcome — task history plus "known problems" (§12). */
  async recordTaskOutcome(task: Task): Promise<void> {
    const outcome = task.result?.summary ?? task.result?.error ?? "(no output)";
    try {
      await this.provider.store({
        key: `task:${task.id}`,
        scope: "task",
        category: "tasks",
        content: `Objective: ${task.objective}\nStatus: ${task.status}\nOutcome: ${outcome}`,
        tags: ["task", ...(task.agent ? [task.agent] : []), ...(task.role ? [task.role] : [])],
        createdAt: task.createdAt,
      });
      const significant = (task.result?.reports ?? []).flatMap((report) =>
        report.findings
          .filter((finding) => finding.severity === "high" || finding.severity === "critical")
          .map((finding) => ({ report, finding })),
      );
      for (const { report, finding } of significant) {
        await this.provider.store({
          key: `finding:${report.id}:${finding.id}`,
          scope: "project",
          category: "problems",
          content: `[${finding.severity}] ${finding.title} — ${finding.detail}`,
          tags: ["known-problem", report.agent],
        });
      }
    } catch (error) {
      this.handleFailure("store", error, undefined);
    }
  }

  private format(entries: MemoryEntry[]): MemoryTaskContext {
    if (entries.length === 0) return { text: "", entries, truncated: false };
    const byScope = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      byScope.set(entry.scope, [...(byScope.get(entry.scope) ?? []), entry]);
    }
    const parts: string[] = [];
    for (const scope of ["project", "task", "role", "knowledge"]) {
      const scopeEntries = byScope.get(scope) ?? [];
      if (scopeEntries.length === 0) continue;
      const lines = scopeEntries
        .map((entry) => {
          const category = entry.category ? `[${entry.category}] ` : "";
          return `- ${category}${entry.content}`;
        })
        .join("\n");
      parts.push(`### Relevant memory (${scope})\n${lines}`);
    }
    let text = parts.join("\n\n");
    const truncated = text.length > this.maxContextChars;
    if (truncated) text = `${text.slice(0, this.maxContextChars - 1)}…`;
    return { text, entries, truncated };
  }

  /**
   * Failure policy (§12): continue unless memory is explicitly required.
   */
  private handleFailure(operation: string, error: unknown, fallback?: MemoryTaskContext): MemoryTaskContext {
    const message = error instanceof Error ? error.message : String(error);
    if (this.required) {
      throw new MemoryError(
        `Memory is marked required, but ${operation} failed: ${message}`,
        { cause: error },
      );
    }
    this.log.warn(`Memory ${operation} failed (continuing without memory): ${message}`);
    return fallback ?? { text: "", entries: [], truncated: false };
  }
}