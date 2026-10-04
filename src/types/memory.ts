/**
 * Memory abstraction. Remembera is the preferred Hilbras integration, but the
 * core depends only on this interface (memory-agnostic principle, §2, §19).
 */

export type MemoryScope = "project" | "role" | "task" | "knowledge";

export interface MemoryEntry {
  key: string;
  scope: MemoryScope;
  content: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  tags?: string[];
  /** Free-text relevance query; implementations decide ranking. */
  text?: string;
  limit?: number;
}

export interface IMemoryProvider {
  readonly name: string;
  /** Retrieve relevant memory; only relevant context should reach a task (§20). */
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  write(entry: MemoryEntry): Promise<void>;
}
