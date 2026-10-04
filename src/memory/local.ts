/**
 * Local file-based memory provider: the default implementation so persistent
 * memory works out of the box, locally (§25), with no external service.
 * Relevance is scored by keyword overlap and tag matches — deterministic and
 * dependency-free.
 */
import { JsonFileStore } from "../persistence/json-file-store.js";
import { defaultMetadata, defaultSearch } from "./base.js";
import type {
  IMemoryProvider,
  MemoryEntry,
  MemoryProviderMetadata,
  MemoryQuery,
} from "../types/memory.js";

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

export class LocalMemoryProvider extends JsonFileStore<MemoryEntry> implements IMemoryProvider {
  readonly name = "local";

  constructor(directory?: string) {
    super({ ...(directory !== undefined ? { directory } : {}), fileName: "memory.json" });
  }

  metadata(): MemoryProviderMetadata {
    return defaultMetadata(this.name, {
      capabilities: ["retrieve", "store", "search", "categories", "tags"],
      relevanceRanking: true,
      backend: { kind: "json-file", deterministicScoring: true },
    });
  }

  search(text: string, options: { limit?: number; scope?: MemoryQuery["scope"] } = {}): Promise<MemoryEntry[]> {
    return defaultSearch(this, text, options);
  }

  /** @deprecated v1 alias of {@link retrieve}. */
  query(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.retrieve(query);
  }

  /** @deprecated v1 alias of {@link store}. */
  write(entry: MemoryEntry): Promise<void> {
    return this.store(entry);
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const entries = await this.readAll();
    const filtered = entries
      .filter((entry) => (query.scope ? entry.scope === query.scope : true))
      .filter((entry) => (query.category ? entry.category === query.category : true))
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
  }

  store(entry: MemoryEntry): Promise<void> {
    return this.mutate((entries) => {
      const index = entries.findIndex((e) => e.key === entry.key);
      const stamped: MemoryEntry = {
        ...entry,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) entries[index] = stamped;
      else entries.push(stamped);
      return [entries, undefined];
    });
  }

  async count(): Promise<number> {
    return (await this.readAll()).length;
  }
}
