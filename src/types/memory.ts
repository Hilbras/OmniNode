/**
 * Memory abstraction (§19). Remembera is the preferred implementation, but
 * the core depends only on this interface (memory-agnostic principle, §2).
 *
 * v2 contract (roadmap §12): retrieve / store / search / metadata, across
 * project / task / role scopes with structured categories.
 */
export type MemoryScope = "project" | "task" | "role" | "knowledge";

/** Structured memory categories (roadmap §12, Memory Categories). */
export type MemoryCategory =
  | "project"
  | "architecture"
  | "decisions"
  | "tasks"
  | "problems"
  | "solutions"
  | "conventions"
  | "agent_reports";

export interface MemoryEntry {
  key: string;
  scope: MemoryScope;
  content: string;
  /** Structured category, when the backend supports it. */
  category?: MemoryCategory;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  /** Free-text relevance query. */
  text?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  tags?: string[];
  limit?: number;
}

export interface MemoryProviderMetadata {
  name: string;
  /** What the backend can do, so callers can adapt (e.g. no category support). */
  capabilities: Array<"retrieve" | "store" | "search" | "categories" | "tags">;
  /** True when the backend enforces relevance ranking itself. */
  relevanceRanking: boolean;
  /** Backend-specific info (gateway version, endpoint type…). */
  backend?: Record<string, unknown>;
}

/**
 * The memory contract. `query`/`write` are the v1 names, kept as aliases so
 * existing integrations keep working — new code should use retrieve/store.
 */
export interface IMemoryProvider {
  readonly name: string;
  /** Retrieve entries relevant to a query (task-oriented). */
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;
  /** Store an entry (upsert by key). */
  store(entry: MemoryEntry): Promise<void>;
  /** Free-text search across scopes. */
  search(text: string, options?: { limit?: number; scope?: MemoryScope }): Promise<MemoryEntry[]>;
  /** Provider capabilities (contract introspection). */
  metadata(): MemoryProviderMetadata;

  /** @deprecated v1 alias of {@link retrieve}. */
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  /** @deprecated v1 alias of {@link store}. */
  write(entry: MemoryEntry): Promise<void>;
}