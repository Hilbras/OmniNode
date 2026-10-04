/**
 * v2 Phase 1 tests: the shared JsonFileStore contract that every local store
 * now builds on — atomic writes, schema envelope, corruption tolerance,
 * serialization of read-modify-write cycles, and v1 file compatibility.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileStore, SCHEMA_VERSION } from "../src/persistence/json-file-store.js";
import { FileTaskStore } from "../src/tasks/store.js";
import type { Task } from "../src/types/task.js";

interface Item {
  id: string;
  value: string;
}

/** Exposes the protected reader for direct store-contract tests. */
class ProbeStore extends JsonFileStore<Item> {
  constructor(directory: string, onCorrupt?: (p: string, e: unknown) => void) {
    super({ directory, fileName: "items.json", ...(onCorrupt ? { onCorrupt } : {}) });
  }
  peek(): Promise<Item[]> {
    return this.readAll();
  }
}

class ItemStore extends JsonFileStore<Item> {
  constructor(directory: string) {
    super({ directory, fileName: "items.json" });
  }
  async upsert(item: Item): Promise<void> {
    await this.mutate((items) => {
      const index = items.findIndex((i) => i.id === item.id);
      if (index >= 0) items[index] = item;
      else items.push(item);
      return [items, undefined];
    });
  }
  async all(): Promise<Item[]> {
    return this.readAll();
  }
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-store-"));
}

describe("JsonFileStore", () => {
  it("writes a schema-versioned document atomically", async () => {
    const dir = tmp();
    const store = new ItemStore(dir);
    await store.upsert({ id: "a", value: "1" });
    const raw = JSON.parse(readFileSync(path.join(dir, "items.json"), "utf8")) as {
      schemaVersion: number;
      items: Item[];
    };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.items).toEqual([{ id: "a", value: "1" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("serializes concurrent read-modify-write cycles without losing updates", async () => {
    const dir = tmp();
    const store = new ItemStore(dir);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.upsert({ id: `i${i}`, value: String(i) })),
    );
    expect(await store.all()).toHaveLength(50);
    rmSync(dir, { recursive: true, force: true });
  });

  it("quarantines a corrupt file: empty store, data preserved for inspection", async () => {
    const dir = tmp();
    const corruptPath = path.join(dir, "items.json");
    writeFileSync(corruptPath, "{ this is not json", "utf8");
    let reported: string | undefined;
    const store = new ProbeStore(dir, (p) => {
      reported = p;
    });
    expect(await store.peek()).toEqual([]);
    expect(reported).toBe(corruptPath);
    // Corrupt data is quarantined, never silently discarded (v2 behavior).
    expect(existsSync(corruptPath)).toBe(false);
    const quarantined = readdirSync(dir).find((name) => name.startsWith("items.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(readFileSync(path.join(dir, quarantined!), "utf8")).toBe("{ this is not json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads v1 bare-array files for backwards compatibility", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "items.json"), JSON.stringify([{ id: "legacy", value: "v1" }]));
    const store = new ItemStore(dir);
    expect(await store.all()).toEqual([{ id: "legacy", value: "v1" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an unrecognized document shape as empty", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "items.json"), JSON.stringify({ unexpected: true }));
    const store = new ItemStore(dir);
    expect(await store.all()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("FileTaskStore now writes the enveloped format and still lists correctly", async () => {
    const dir = tmp();
    const store = new FileTaskStore(dir);
    const task: Task = {
      id: "t1",
      objective: "verify persistence",
      status: "created",
      attempt: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.save(task);
    expect((await store.get("t1"))?.objective).toBe("verify persistence");
    const raw = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as { schemaVersion: number };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    rmSync(dir, { recursive: true, force: true });
  });
});