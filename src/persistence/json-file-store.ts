/**
 * Shared JSON file persistence (v2 Phase 1: duplicated-abstraction cleanup).
 *
 * Every local store in OmniNode is "load array → mutate → atomic write" with
 * serialized read-modify-write cycles. This base owns that once:
 * - writes go to a temp file and are renamed into place (atomic enough)
 * - read-modify-write operations are serialized per store instance, so
 *   parallel fan-out tasks cannot lose updates
 * - corrupt or partially written files degrade to an empty collection and
 *   leave the original file untouched (no destructive auto-repair)
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger, type Logger } from "../logger/index.js";

export interface JsonDocument<T> {
  /** Bumped when the persisted shape changes in a breaking way (v2 Phase 12). */
  schemaVersion?: number;
  items: T[];
}

export interface JsonFileStoreOptions {
  directory?: string;
  fileName: string;
  schemaVersion?: number;
  /** Called when a persisted file cannot be parsed. */
  onCorrupt?: (path: string, error: unknown) => void;
}

export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly schemaVersion: number;
  private readonly onCorrupt?: (path: string, error: unknown) => void;
  private readonly log: Logger;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    this.filePath = `${options.directory ?? `${process.cwd()}/.omninode`}/${options.fileName}`;
    this.schemaVersion = options.schemaVersion ?? 1;
    this.onCorrupt = options.onCorrupt;
    this.log = logger.child({ component: "persistence", file: options.fileName });
  }

  get path(): string {
    return this.filePath;
  }

  /** All items, or [] when missing/corrupt. */
  protected async readAll(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // Accept both the wrapped document and a bare array (v1 files).
      if (Array.isArray(parsed)) return parsed as T[];
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as JsonDocument<T>).items)) {
        return (parsed as JsonDocument<T>).items;
      }
      throw new Error("persisted file has an unrecognized shape");
    } catch (error) {
      this.log.warn(`Treating ${this.filePath} as empty — it could not be parsed.`);
      this.onCorrupt?.(this.filePath, error);
      return [];
    }
  }

  protected async writeAll(items: T[]): Promise<void> {
    const document: JsonDocument<T> = { schemaVersion: this.schemaVersion, items };
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
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