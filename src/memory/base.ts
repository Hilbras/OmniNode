/**
 * Shared memory-contract helpers (roadmap §12). Adapters implement
 * `retrieve` / `store`; these helpers supply the defaults for `search`,
 * `metadata` and the v1 `query` / `write` aliases, so the contract is
 * defined once.
 */
import type {
  IMemoryProvider,
  MemoryEntry,
  MemoryProviderMetadata,
  MemoryQuery,
} from "../types/memory.js";

/** Free-text search defaults to a relevance retrieve. */
export function defaultSearch(
  provider: Pick<IMemoryProvider, "retrieve">,
  text: string,
  options: { limit?: number; scope?: MemoryQuery["scope"] } = {},
): Promise<MemoryEntry[]> {
  return provider.retrieve({
    text,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

export function defaultMetadata(
  name: string,
  options: {
    capabilities?: MemoryProviderMetadata["capabilities"];
    relevanceRanking?: boolean;
    backend?: Record<string, unknown>;
  } = {},
): MemoryProviderMetadata {
  return {
    name,
    capabilities: options.capabilities ?? ["retrieve", "store", "search"],
    relevanceRanking: options.relevanceRanking ?? false,
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
  };
}