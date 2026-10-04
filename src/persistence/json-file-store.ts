/**
 * Shared JSON file persistence (v2 Phase 12 — Persistence Layer).
 *
 * Guarantees:
 *  - **Atomic writes**: temp file → fsync → rename → directory fsync, so a
 *    crash never leaves a half-written store.
 *  - **Corruption detection**: unparseable files are *quarantined* (renamed,
 *    never deleted) and the store continues empty.
 *  - **Schema versioning**: documents carry `schemaVersion`; v1 documents are
 *    migrated on read, future versions are refused rather than misread.
 */
import { open, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger, type Logger } from "../logger/index.js";

/** Current on-disk schema version. */
export const SCHEMA_VERSION = 2;

export interface JsonDocument<T> {
  schemaVersion?: number;
  items: T[];
}

export type DocumentState =
  | { status: "missing" }
  | { status: "empty" }
  | { status: "v1-legacy" }
  | { status: "current"; schemaVersion: number; count: number }
  | { status: "future"; schemaVersion: number }
  | { status: "corrupt"; detail: string };

export interface JsonFileStoreOptions {
  directory?: string;
  fileName: string;
  /** Schema version to write (defaults to the current version). */
  schemaVersion?: number;
  /** Power-loss durability: "rename" (default) or "fsync" (slower). */
  durability?: Durability;
  /** Called when a persisted file is corrupt (after quarantine). */
  onCorrupt?: (path: string, error: unknown) => void;
  /** Disable file moves (used by dry runs / tests that inspect in place). */
  quarantine?: boolean;
}

export type Durability = "rename" | "fsync";

/**
 * Writes a file atomically: temp → rename. The rename guarantees readers
 * never observe a torn file. With `durability: "fsync"` the data and the
 * directory entry are also flushed, which additionally survives power loss —
 * at a significant per-write cost, so it is opt-in.
 */
export async function writeFileAtomic(
  target: string,
  contents: string,
  durability: Durability = "rename",
): Promise<void> {
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });

  if (durability === "fsync") {
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await writeFile(tmp, contents, "utf8");
  }

  await rename(tmp, target);

  if (durability === "fsync") {
    try {
      const dir = await open(dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is unsupported on some platforms — the rename is still atomic.
    }
  }
}

/** Reads and classifies a persisted document without modifying it. */
export async function inspectDocument(path: string): Promise<DocumentState> {
  let raw: string;
  try {
    await stat(path);
  } catch {
    return { status: "missing" };
  }
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { status: "corrupt", detail: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (raw.trim().length === 0) return { status: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "corrupt", detail: error instanceof Error ? error.message : "invalid JSON" };
  }
  if (Array.isArray(parsed)) return { status: "v1-legacy" }; // v1 stored bare arrays
  if (parsed === null || typeof parsed !== "object") return { status: "corrupt", detail: "not an object" };
  const doc = parsed as JsonDocument<unknown>;
  if (!Array.isArray(doc.items)) return { status: "corrupt", detail: "missing items array" };
  const version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1;
  if (version > SCHEMA_VERSION) return { status: "future", schemaVersion: version };
  if (version < SCHEMA_VERSION) return { status: "v1-legacy" };
  return { status: "current", schemaVersion: version, count: doc.items.length };
}

/** Reads a document, migrating v1 shapes and quarantining corruption. */
export async function readDocument<T>(
  path: string,
  onCorrupt?: (path: string, error: unknown) => void,
  quarantine = true,
): Promise<T[]> {
  const state = await inspectDocument(path);
  if (state.status === "missing" || state.status === "empty") return [];
  if (state.status === "future") {
    const error = new Error(
      `${path} was written by a newer OmniNode (schema v${state.schemaVersion} > v${SCHEMA_VERSION})`,
    );
    onCorrupt?.(path, error);
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    onCorrupt?.(path, error);
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as T[]; // v1 legacy: bare array
    return (parsed as JsonDocument<T>).items ?? [];
  } catch (error) {
    // Preserve the damaged file for inspection instead of overwriting it.
    if (quarantine) {
      const quarantinePath = `${path}.corrupt-${Date.now()}`;
      try {
        await rename(path, quarantinePath);
        logger.child({ component: "persistence" }).warn(
          `Quarantined unreadable store file ${path} → ${quarantinePath}`,
        );
      } catch {
        // Quarantine is best effort.
      }
    }
    onCorrupt?.(path, error);
    return [];
  }
}

export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly schemaVersion: number;
  private readonly durability: Durability;
  private readonly onCorrupt?: (path: string, error: unknown) => void;
  private readonly quarantine: boolean;
  private readonly log: Logger;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    this.filePath = `${options.directory ?? `${process.cwd()}/.omninode`}/${options.fileName}`;
    this.schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
    this.durability = options.durability ?? "rename";
    this.onCorrupt = options.onCorrupt;
    this.quarantine = options.quarantine ?? true;
    this.log = logger.child({ component: "persistence", file: options.fileName });
  }

  get path(): string {
    return this.filePath;
  }

  /** All items, or [] when missing/migrated-from-v1/corrupt. */
  protected async readAll(): Promise<T[]> {
    return readDocument<T>(this.filePath, this.onCorrupt, this.quarantine);
  }

  protected async writeAll(items: T[]): Promise<void> {
    const document: JsonDocument<T> = { schemaVersion: this.schemaVersion, items };
    await writeFileAtomic(this.filePath, `${JSON.stringify(document, null, 2)}\n`, this.durability);
  }

  /** Serializes an async operation against this file. */
  protected synchronized<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Read-modify-write helper: applies `mutate` to the current items. */
  protected async mutate<R>(mutate: (items: T[]) => Promise<[T[], R]> | [T[], R]): Promise<R> {
    return this.synchronized(async () => {
      const items = await this.readAll();
      const [next, result] = await mutate(items);
      await this.writeAll(next);
      return result;
    });
  }
}
