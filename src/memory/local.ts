/**
 * Local file-based memory provider: the default implementation so persistent
 * memory works out of the box, locally (§25), with no external service.
 * Relevance is scored by keyword overlap and tag matches — deterministic and
 * dependency-free.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IMemoryProvider, MemoryEntry, MemoryQuery } from "../types/memory.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "was", "were",
  "have", "has", "had", "are", "but", "not", "you", "his", "her", "its",
  "their", "them", "then", "than", "when", "what", "which", "will", "would",
  "been", "were", "also", "because", "about", "after", "before",
]);

export function keywords(text: string): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
  );
}

function relevanceScore(queryKeywords: Set<string>, entry: MemoryEntry): number {
  if (queryKeywords.size === 0) return 0;
  const entryKeywords = keywords(`${entry.content} ${entry.key}`);
  let overlap = 0;
  for (const keyword of queryKeywords) {
    if (entryKeywords.has(keyword)) overlap += 1;
  }
  let tagMatches = 0;
  for (const tag of entry.tags ?? []) {
    if (queryKeywords.has(tag.toLowerCase())) tagMatches += 1;
  }
  return overlap * 2 + tagMatches * 1.5;
}

export class LocalMemoryProvider implements IMemoryProvider {
  readonly name = "local";
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory = `${process.cwd()}/.omninode`) {
    this.filePath = `${directory}/memory.json`;
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.synchronized(async () => {
      const entries = await this.load();
      const filtered = entries
        .filter((entry) => (query.scope ? entry.scope === query.scope : true))
        .filter((entry) =>
          query.tags && query.tags.length > 0
            ? query.tags.every((tag) => (entry.tags ?? []).includes(tag))
            : true,
        );

      if (!query.text || query.text.trim().length === 0) {
        return filtered
          .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
          .slice(0, query.limit ?? 10);
      }

      const queryKeywords = keywords(query.text);
      return filtered
        .map((entry) => ({ entry, score: relevanceScore(queryKeywords, entry) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit ?? 10)
        .map(({ entry }) => entry);
    });
  }

  async write(entry: MemoryEntry): Promise<void> {
    return this.synchronized(async () => {
      const entries = await this.load();
      const index = entries.findIndex((e) => e.key === entry.key);
      const stamped: MemoryEntry = {
        ...entry,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) entries[index] = stamped;
      else entries.push(stamped);
      await this.saveAll(entries);
    });
  }

  async count(): Promise<number> {
    return (await this.load()).length;
  }

  private synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async saveAll(entries: MemoryEntry[]): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}
