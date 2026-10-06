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
import type { IMemoryProvider, MemoryEntry, MemoryScope } from "../types/memory.js";
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
  /**
   * All retrieved entries — preserved even when their formatted text was cut,
   * so callers never lose metadata (v2.0.3 Fix 01).
   */
  entries: MemoryEntry[];
  /** True whenever any content was omitted from `text`. */
  truncated: boolean;
  /** Formatted context size before truncation (0 when nothing was retrieved). */
  originalSize: number;
  /** Final `text` size after truncation. */
  finalSize: number;
}

const DEFAULT_ENTRY_LIMIT = 8;
export const MAX_CONTEXT_CHARS = 4_000;

/**
 * Appended (never silent) when the context budget omits content — the cut is
 * always visible to the agent and to debugging (v2.0.3 Fix 01).
 */
export const CONTEXT_TRUNCATION_MARKER = "[CONTEXT TRUNCATED — earlier memory was omitted]";

const SECTION_SEPARATOR = "\n\n";

/** Scope rendering order = priority order: most task-relevant scopes first. */
const SCOPE_PRIORITY: readonly MemoryScope[] = ["project", "task", "role", "knowledge"];

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
      return this.handleFailure("retrieve", error, {
        text: "",
        entries: [],
        truncated: false,
        originalSize: 0,
        finalSize: 0,
      });
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

  /**
   * Formats entries into a budgeted, boundary-safe context (v2.0.3 Fix 01).
   *
   * Truncation drops *complete* entries — never a cut through the middle of
   * one — keeps the highest-priority content first (scope priority, then the
   * provider's relevance order within a scope), reports exact sizes, and marks
   * the cut explicitly. The full `entries` metadata is always preserved.
   */
  private format(entries: MemoryEntry[]): MemoryTaskContext {
    if (entries.length === 0) {
      return { text: "", entries, truncated: false, originalSize: 0, finalSize: 0 };
    }

    const sections = SCOPE_PRIORITY.map((scope) => ({
      scope,
      entries: entries.filter((entry) => entry.scope === scope),
    })).filter((section) => section.entries.length > 0);

    const originalText = sections
      .map((section) => renderScope(section.scope, section.entries))
      .join(SECTION_SEPARATOR);
    const originalSize = originalText.length;

    if (originalSize <= this.maxContextChars) {
      return { text: originalText, entries, truncated: false, originalSize, finalSize: originalSize };
    }

    // Reserve space for the marker up front so the final text (marker
    // included) stays within the configured budget. Budgets smaller than the
    // marker itself are pathological: the explicit marker still wins.
    const contentBudget = Math.max(0, this.maxContextChars - SECTION_SEPARATOR.length - CONTEXT_TRUNCATION_MARKER.length);

    const kept: string[] = [];
    let used = 0; // committed content length, separators included

    for (const section of sections) {
      const separatorLength = kept.length === 0 ? 0 : SECTION_SEPARATOR.length;
      const header = `### Relevant memory (${section.scope})`;
      const block = renderScope(section.scope, section.entries);
      if (used + separatorLength + block.length <= contentBudget) {
        kept.push(block);
        used += separatorLength + block.length;
        continue;
      }
      // The whole scope doesn't fit — keep as many complete entries from it
      // as the remaining budget allows, then stop (everything later in the
      // priority order is omitted and reported via the marker).
      const entryBudget = Math.max(0, contentBudget - used - separatorLength - header.length - 1);
      const fitted: MemoryEntry[] = [];
      let fittedLength = 0;
      for (const entry of section.entries) {
        const line = renderEntryLine(entry);
        const lineSeparator = fitted.length === 0 ? 0 : 1; // "\n" between lines
        if (fittedLength + lineSeparator + line.length > entryBudget) break;
        fitted.push(entry);
        fittedLength += lineSeparator + line.length;
      }
      if (fitted.length > 0) {
        kept.push(`${header}\n${fitted.map(renderEntryLine).join("\n")}`);
      }
      break;
    }

    const body = kept.join(SECTION_SEPARATOR);
    const text =
      kept.length === 0
        ? CONTEXT_TRUNCATION_MARKER
        : `${body}${SECTION_SEPARATOR}${CONTEXT_TRUNCATION_MARKER}`;

    return { text, entries, truncated: true, originalSize, finalSize: text.length };
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
    return fallback ?? { text: "", entries: [], truncated: false, originalSize: 0, finalSize: 0 };
  }
}

/** Renders one scope's entries as a `### Relevant memory (scope)` block. */
function renderScope(scope: MemoryScope, scopeEntries: MemoryEntry[]): string {
  return `### Relevant memory (${scope})\n${scopeEntries.map(renderEntryLine).join("\n")}`;
}

/** One bullet line — category tag optional. */
function renderEntryLine(entry: MemoryEntry): string {
  const category = entry.category ? `[${entry.category}] ` : "";
  return `- ${category}${entry.content}`;
}