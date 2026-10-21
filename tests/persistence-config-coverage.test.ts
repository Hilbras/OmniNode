/**
 * Coverage for the config-migration and persistence modules.
 *
 * Targets four source files whose uncovered edges were the residual gaps
 * behind the per-file coverage floor:
 *   - `src/config/migrate-config.ts` — the v1 → v2 config rewrites, including
 *     the "nothing to change" path, the memory-provider rewrite and the
 *     schema-validation failure path.
 *   - `src/memory/base.ts` — the shared memory-contract defaults (search
 *     options, provider metadata).
 *   - `src/persistence/index.ts` — `ProjectStores` and the store migration
 *     report matrix.
 *   - `src/persistence/json-file-store.ts` — atomic/fsynced writes, document
 *     classification, quarantine and the future-version guard.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConfigMigration, findConfigV1Patterns } from "../src/config/migrate-config.js";
import { defaultMetadata, defaultSearch } from "../src/memory/base.js";
import {
  JsonFileStore,
  ProjectStores,
  SCHEMA_VERSION,
  inspectDocument,
  migrateProjectStores,
  readDocument,
  writeFileAtomic,
} from "../src/persistence/index.js";
import { ConfigError } from "../src/errors/index.js";
import type { IMemoryProvider, MemoryEntry } from "../src/types/memory.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-persist-cov-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* src/config/migrate-config.ts                                         */
/* ------------------------------------------------------------------ */

const V1_YAML = [
  "project:",
  "  name: legacy-demo",
  "  agents:",
  "    - name: worker",
  "      type: cli",
  "      inherit_env: false",
  "      command: worker-cli",
  "",
].join("\n");

describe("config migration (§23)", () => {
  it("detects the v1 agent patterns without touching the file", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(file, V1_YAML, "utf8");
    const before = readFileSync(file, "utf8");

    const findings = findConfigV1Patterns(file);

    expect(findings).toEqual([
      { path: "project.agents.0.inherit_env", change: "inherit_env: false → env_policy: explicit" },
      { path: "project.agents.0.input_mode", change: "implicit input_mode → input_mode: stdin" },
    ]);
    // The detector is read-only.
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("reports nothing for an already-migrated config and leaves it untouched", () => {
    const file = path.join(tmp(), "omninode.yaml");
    const yaml = [
      "project:",
      "  name: modern",
      "  agents:",
      "    - name: worker",
      "      env_policy: explicit",
      "      input_mode: stdin",
      "",
    ].join("\n");
    writeFileSync(file, yaml, "utf8");

    expect(findConfigV1Patterns(file)).toEqual([]);

    const result = applyConfigMigration(file);
    expect(result).toEqual({ file, findings: [], applied: false });
    // Nothing was rewritten.
    expect(readFileSync(file, "utf8")).toBe(yaml);
  });

  it("reports nothing when the project has no agents section at all", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(file, "project:\n  name: bare\n", "utf8");

    expect(findConfigV1Patterns(file)).toEqual([]);
    expect(applyConfigMigration(file).applied).toBe(false);
  });

  it("flags an implicit memory provider only when memory is configured", () => {
    const withMemory = path.join(tmp(), "omninode.yaml");
    writeFileSync(
      withMemory,
      "project:\n  name: p\n  memory:\n    required: true\n",
      "utf8",
    );
    expect(findConfigV1Patterns(withMemory)).toEqual([
      { path: "project.memory.provider", change: "implicit provider → provider: local" },
    ]);

    // No memory section at all: nothing is flagged, so memory stays opted out.
    const withoutMemory = path.join(tmp(), "omninode.yaml");
    writeFileSync(withoutMemory, "project:\n  name: p\n", "utf8");
    expect(findConfigV1Patterns(withoutMemory)).toEqual([]);
  });

  it("does not flag a memory section that already names its provider", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(file, "project:\n  name: p\n  memory:\n    provider: remembera\n", "utf8");
    expect(findConfigV1Patterns(file)).toEqual([]);
  });

  it("rewrites inherit_env, input_mode and the memory provider", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(
      file,
      [
        "project:",
        "  name: legacy-demo",
        "  agents:",
        "    - name: worker",
        "      type: cli",
        "      inherit_env: false",
        "      command: worker-cli",
        "  memory:",
        "    required: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = applyConfigMigration(file);

    expect(result.applied).toBe(true);
    expect(result.file).toBe(file);
    expect(result.findings.map((f) => f.path)).toEqual([
      "project.agents.0.inherit_env",
      "project.agents.0.input_mode",
      "project.memory.provider",
    ]);

    const rewritten = readFileSync(file, "utf8");
    expect(rewritten).not.toContain("inherit_env");
    expect(rewritten).toContain("env_policy: explicit");
    expect(rewritten).toContain("input_mode: stdin");
    expect(rewritten).toContain("provider: local");
  });

  it("keeps an agent that already declares input_mode and inherit_env: true alone", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(
      file,
      [
        "project:",
        "  name: p",
        "  agents:",
        "    - name: modern",
        "      input_mode: arg",
        "      inherit_env: true",
        "    - name: legacy",
        "      inherit_env: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const findings = findConfigV1Patterns(file);
    expect(findings.map((f) => f.path)).toEqual([
      "project.agents.1.inherit_env",
      "project.agents.1.input_mode",
    ]);

    applyConfigMigration(file);
    const rewritten = readFileSync(file, "utf8");
    // The modern agent keeps its own settings.
    expect(rewritten).toContain("input_mode: arg");
    expect(rewritten).toContain("inherit_env: true");
  });

  it("refuses to write a migration that would produce an invalid config", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(
      file,
      [
        "legacy_key: true",
        "project:",
        "  name: legacy-demo",
        "  agents:",
        "    - name: worker",
        "      inherit_env: false",
        "      command: worker-cli",
        "",
      ].join("\n"),
      "utf8",
    );
    const before = readFileSync(file, "utf8");

    expect(() => applyConfigMigration(file)).toThrow(ConfigError);
    try {
      applyConfigMigration(file);
      expect.unreachable("applyConfigMigration should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.code).toBe("CONFIG_INVALID");
      expect(configError.message).toContain("would produce an invalid configuration");
      // A root-level issue has no path — it is reported as "(root)".
      expect(configError.message).toContain("(root)");
      expect(configError.message).toContain("legacy_key");
    }
    // The invalid config was not written.
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("names the offending path when the invalid field is nested", () => {
    const file = path.join(tmp(), "omninode.yaml");
    writeFileSync(
      file,
      [
        "project:",
        "  name: legacy-demo",
        "  agents:",
        "    - name: worker",
        "      type: not-a-real-type",
        "      inherit_env: false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => applyConfigMigration(file)).toThrow(ConfigError);
    try {
      applyConfigMigration(file);
      expect.unreachable("applyConfigMigration should have thrown");
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.code).toBe("CONFIG_INVALID");
      expect(configError.message).toContain("project.agents.0.type");
    }
  });
});

/* ------------------------------------------------------------------ */
/* src/memory/base.ts                                                   */
/* ------------------------------------------------------------------ */

describe("memory contract defaults (§12)", () => {
  function stubProvider(): { provider: Pick<IMemoryProvider, "retrieve">; calls: unknown[] } {
    const calls: unknown[] = [];
    const provider = {
      retrieve: async (query: unknown): Promise<MemoryEntry[]> => {
        calls.push(query);
        return [];
      },
    };
    return { provider, calls };
  }

  it("search forwards only the text when no options are given", async () => {
    const { provider, calls } = stubProvider();
    await defaultSearch(provider, "auth module");
    expect(calls).toEqual([{ text: "auth module" }]);
  });

  it("search forwards the scope when one is given", async () => {
    const { provider, calls } = stubProvider();
    await defaultSearch(provider, "auth module", { scope: "project" });
    expect(calls).toEqual([{ text: "auth module", scope: "project" }]);
  });

  it("search forwards the limit when one is given", async () => {
    const { provider, calls } = stubProvider();
    await defaultSearch(provider, "auth module", { limit: 3 });
    expect(calls).toEqual([{ text: "auth module", limit: 3 }]);
  });

  it("search forwards both scope and limit", async () => {
    const { provider, calls } = stubProvider();
    await defaultSearch(provider, "auth module", { scope: "task", limit: 5 });
    expect(calls).toEqual([{ text: "auth module", scope: "task", limit: 5 }]);
  });

  it("metadata falls back to the default capabilities and ranking", () => {
    expect(defaultMetadata("local")).toEqual({
      name: "local",
      capabilities: ["retrieve", "store", "search"],
      relevanceRanking: false,
    });
  });

  it("metadata honours explicit capabilities and ranking", () => {
    expect(
      defaultMetadata("remembera", {
        capabilities: ["retrieve", "store", "search", "categories", "tags"],
        relevanceRanking: true,
      }),
    ).toEqual({
      name: "remembera",
      capabilities: ["retrieve", "store", "search", "categories", "tags"],
      relevanceRanking: true,
    });
  });

  it("metadata includes the backend block only when one is supplied", () => {
    expect(defaultMetadata("local", { backend: { kind: "json-file" } })).toEqual({
      name: "local",
      capabilities: ["retrieve", "store", "search"],
      relevanceRanking: false,
      backend: { kind: "json-file" },
    });
  });
});

/* ------------------------------------------------------------------ */
/* src/persistence/index.ts                                             */
/* ------------------------------------------------------------------ */

describe("ProjectStores", () => {
  it("bundles every store for one project directory", async () => {
    const dir = tmp();
    const stores = new ProjectStores(dir);

    expect(stores.tasks.path).toBe(path.join(dir, "tasks.json"));
    expect(stores.pipelineRuns.path).toBe(path.join(dir, "pipelines.json"));
    expect(stores.reports.path).toBe(path.join(dir, "reports.json"));
    expect(stores.plans.path).toBe(path.join(dir, "plans.json"));
    expect(stores.memory.path).toBe(path.join(dir, "memory.json"));

    await stores.audit.record({ at: new Date().toISOString(), action: "task.created", id: "t1" });
    const events = await stores.audit.recent();
    expect(events.map((e) => e.action)).toEqual(["task.created"]);
  });

  it("defaults to the .omninode directory in the current working directory", () => {
    const stores = new ProjectStores();
    expect(stores.tasks.path).toBe(path.join(process.cwd(), ".omninode", "tasks.json"));
  });
});

describe("migrateProjectStores (report matrix)", () => {
  it("reports a missing store without creating it", async () => {
    const dir = tmp();
    const reports = await migrateProjectStores(dir);

    expect(reports).toHaveLength(5);
    expect(reports.every((r) => r.state === "missing" && !r.migrated)).toBe(true);
    expect(existsSync(path.join(dir, "tasks.json"))).toBe(false);
  });

  it("reports an empty store file and migrates it to an empty current document", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "plans.json"), "", "utf8");

    const reports = await migrateProjectStores(dir);
    const plan = reports.find((r) => r.file === "plans.json");
    expect(plan).toMatchObject({ state: "empty", migrated: true, before: 0, after: 0 });

    const doc = JSON.parse(readFileSync(path.join(dir, "plans.json"), "utf8")) as {
      schemaVersion: number;
      items: unknown[];
    };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.items).toEqual([]);
  });

  it("reports a corrupt store with the parse detail and never rewrites it", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "memory.json"), "{ broken json", "utf8");

    const reports = await migrateProjectStores(dir);
    const memory = reports.find((r) => r.file === "memory.json");
    expect(memory?.state).toBe("corrupt");
    expect(memory?.migrated).toBe(false);
    expect(memory?.note).toBeTruthy();
    expect(readFileSync(path.join(dir, "memory.json"), "utf8")).toBe("{ broken json");
  });

  it("reports a future store and leaves it byte-identical", async () => {
    const dir = tmp();
    const future = JSON.stringify({ schemaVersion: 99, items: [{ id: "newer" }] });
    writeFileSync(path.join(dir, "pipelines.json"), future, "utf8");

    const reports = await migrateProjectStores(dir);
    const pipelines = reports.find((r) => r.file === "pipelines.json");
    expect(pipelines).toMatchObject({ state: "future", migrated: false });
    expect(pipelines?.note).toContain("newer OmniNode");
    expect(readFileSync(path.join(dir, "pipelines.json"), "utf8")).toBe(future);
  });

  it("reports a current store with its item count", async () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "tasks.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: [{ id: "t1" }, { id: "t2" }] }),
      "utf8",
    );

    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "tasks.json")).toMatchObject({
      state: "current",
      before: 2,
      after: 2,
      migrated: false,
    });
  });

  it("a check-only run reports the migration but writes nothing", async () => {
    const dir = tmp();
    const legacy = JSON.stringify([{ id: "t1" }]);
    writeFileSync(path.join(dir, "tasks.json"), legacy, "utf8");

    const reports = await migrateProjectStores(dir, { checkOnly: true });
    const tasks = reports.find((r) => r.file === "tasks.json");
    expect(tasks).toMatchObject({ state: "v1-legacy", migrated: false, before: 1, after: 1 });
    expect(tasks?.note).toBe("would migrate");
    expect(readFileSync(path.join(dir, "tasks.json"), "utf8")).toBe(legacy);
  });

  it("migrates a v1 store in place and reports the item count", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t1" }, { id: "t2" }]), "utf8");

    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "tasks.json")).toMatchObject({
      state: "v1-legacy",
      migrated: true,
      before: 2,
      after: 2,
    });
    expect(reports.find((r) => r.file === "tasks.json")?.note).toBeUndefined();

    const doc = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as {
      schemaVersion: number;
      items: Array<{ id: string }>;
    };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.items.map((i) => i.id)).toEqual(["t1", "t2"]);
  });
});

/* ------------------------------------------------------------------ */
/* src/persistence/json-file-store.ts                                   */
/* ------------------------------------------------------------------ */

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temp file behind", async () => {
    const dir = tmp();
    const target = path.join(dir, "doc.json");

    await writeFileAtomic(target, '{"ok":true}\n');

    expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the parent directory when it does not exist yet", async () => {
    const dir = tmp();
    const target = path.join(dir, "nested", "deeper", "doc.json");

    await writeFileAtomic(target, "written");

    expect(readFileSync(target, "utf8")).toBe("written");
  });

  it("fsync durability writes the same content and leaves no temp file behind", async () => {
    const dir = tmp();
    const target = path.join(dir, "durable.json");

    await writeFileAtomic(target, '{"durable":true}\n', "fsync");

    expect(readFileSync(target, "utf8")).toBe('{"durable":true}\n');
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("inspectDocument", () => {
  it("classifies a missing file", async () => {
    expect(await inspectDocument(path.join(tmp(), "nope.json"))).toEqual({ status: "missing" });
  });

  it("classifies a blank file as empty", async () => {
    const file = path.join(tmp(), "blank.json");
    writeFileSync(file, "   \n  ", "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "empty" });
  });

  it("classifies a bare array as v1-legacy", async () => {
    const file = path.join(tmp(), "legacy.json");
    writeFileSync(file, JSON.stringify([{ id: "a" }]), "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "v1-legacy" });
  });

  it("classifies an object without a schema version as v1-legacy", async () => {
    const file = path.join(tmp(), "no-version.json");
    writeFileSync(file, JSON.stringify({ items: [{ id: "a" }] }), "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "v1-legacy" });
  });

  it("classifies an object at an older schema version as v1-legacy", async () => {
    const file = path.join(tmp(), "v1.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: [{ id: "a" }] }), "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "v1-legacy" });
  });

  it("classifies a current document and reports its item count", async () => {
    const file = path.join(tmp(), "current.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: [{ id: "a" }] }), "utf8");
    expect(await inspectDocument(file)).toEqual({
      status: "current",
      schemaVersion: SCHEMA_VERSION,
      count: 1,
    });
  });

  it("classifies a newer schema version as future", async () => {
    const file = path.join(tmp(), "future.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 5, items: [] }), "utf8");
    expect(await inspectDocument(file)).toEqual({
      status: "future",
      schemaVersion: SCHEMA_VERSION + 5,
    });
  });

  it("classifies unparseable JSON as corrupt", async () => {
    const file = path.join(tmp(), "broken.json");
    writeFileSync(file, "{ not json", "utf8");
    const state = await inspectDocument(file);
    expect(state.status).toBe("corrupt");
    expect(state.status === "corrupt" && state.detail).toBeTruthy();
  });

  it("classifies a non-object document as corrupt", async () => {
    const file = path.join(tmp(), "null.json");
    writeFileSync(file, "null", "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "corrupt", detail: "not an object" });
  });

  it("classifies a document without an items array as corrupt", async () => {
    const file = path.join(tmp(), "no-items.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION }), "utf8");
    expect(await inspectDocument(file)).toEqual({ status: "corrupt", detail: "missing items array" });
  });

  it("reports an unreadable path as corrupt", async () => {
    const dir = tmp();
    const asDirectory = path.join(dir, "store.json");
    mkdirSync(asDirectory);

    const state = await inspectDocument(asDirectory);
    expect(state.status).toBe("corrupt");
    expect(state.status === "corrupt" && state.detail).toContain("unreadable:");
  });

  it("falls back to a generic detail when the failure is not an Error", async () => {
    const file = path.join(tmp(), "broken.json");
    writeFileSync(file, "{ not json", "utf8");
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "not an error instance";
    });

    const state = await inspectDocument(file);

    expect(state).toEqual({ status: "corrupt", detail: "invalid JSON" });
    parse.mockRestore();
  });

  it("stringifies a non-Error read failure into the corrupt detail", async () => {
    const file = path.join(tmp(), "unreadable.json");
    writeFileSync(file, "{}", "utf8");

    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        default: actual,
        readFile: vi.fn(async () => {
          throw "disk on fire";
        }),
      };
    });

    try {
      const { inspectDocument: inspect } = await import("../src/persistence/json-file-store.js");
      expect(await inspect(file)).toEqual({ status: "corrupt", detail: "unreadable: disk on fire" });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("readDocument", () => {
  it("returns an empty list for a missing file", async () => {
    expect(await readDocument(path.join(tmp(), "missing.json"))).toEqual([]);
  });

  it("returns an empty list for an empty file", async () => {
    const file = path.join(tmp(), "empty.json");
    writeFileSync(file, "", "utf8");
    expect(await readDocument(file)).toEqual([]);
  });

  it("reads the items of a current document", async () => {
    const file = path.join(tmp(), "current.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: [{ id: "a" }] }), "utf8");
    expect(await readDocument(file)).toEqual([{ id: "a" }]);
  });

  it("reads a v1 bare array document", async () => {
    const file = path.join(tmp(), "legacy.json");
    writeFileSync(file, JSON.stringify([{ id: "legacy" }]), "utf8");
    expect(await readDocument(file)).toEqual([{ id: "legacy" }]);
  });

  it("returns an empty list for a document without an items array", async () => {
    const file = path.join(tmp(), "no-items.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION }), "utf8");
    expect(await readDocument(file)).toEqual([]);
  });

  it("refuses a future document, reports it and leaves the file untouched", async () => {
    const file = path.join(tmp(), "future.json");
    const contents = JSON.stringify({ schemaVersion: 99, items: [{ id: "newer" }] });
    writeFileSync(file, contents, "utf8");

    const reported: Array<[string, unknown]> = [];
    const items = await readDocument(file, (p, error) => {
      reported.push([p, error]);
    });

    expect(items).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.[0]).toBe(file);
    expect(String((reported[0]?.[1] as Error).message)).toContain("newer OmniNode");
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("quarantines a corrupt document and reports it", async () => {
    const dir = tmp();
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ not json", "utf8");

    const reported: string[] = [];
    const items = await readDocument(file, (p) => {
      reported.push(p);
    });

    expect(items).toEqual([]);
    expect(reported).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    const quarantined = readdirSync(dir).find((name) => name.startsWith("broken.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(readFileSync(path.join(dir, quarantined!), "utf8")).toBe("{ not json");
  });

  it("keeps a corrupt document in place when quarantine is disabled", async () => {
    const dir = tmp();
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ not json", "utf8");

    const reported: string[] = [];
    const items = await readDocument(file, (p) => {
      reported.push(p);
    }, false);

    expect(items).toEqual([]);
    expect(reported).toEqual([file]);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
  });

  it("reports an unreadable path and returns an empty list", async () => {
    const dir = tmp();
    const asDirectory = path.join(dir, "store.json");
    mkdirSync(asDirectory);

    const reported: string[] = [];
    const items = await readDocument(asDirectory, (p) => {
      reported.push(p);
    });

    expect(items).toEqual([]);
    expect(reported).toEqual([asDirectory]);
  });
});

describe("JsonFileStore", () => {
  class ProbeStore extends JsonFileStore<{ id: string }> {
    constructor(directory: string, options: { onCorrupt?: (p: string, e: unknown) => void } = {}) {
      super({
        directory,
        fileName: "items.json",
        ...(options.onCorrupt ? { onCorrupt: options.onCorrupt } : {}),
      });
    }
    peek(): Promise<Array<{ id: string }>> {
      return this.readAll();
    }
    async put(id: string): Promise<void> {
      await this.mutate((items) => {
        items.push({ id });
        return [items, undefined];
      });
    }
  }

  it("exposes the resolved file path", () => {
    const dir = tmp();
    const store = new ProbeStore(dir);
    expect(store.path).toBe(path.join(dir, "items.json"));
  });

  it("defaults the store directory to .omninode in the current working directory", () => {
    const store = new JsonFileStore<{ id: string }>({ fileName: "defaulted.json" });
    expect(store.path).toBe(path.join(process.cwd(), ".omninode", "defaulted.json"));
  });

  it("writes the document at the configured schema version", async () => {
    const dir = tmp();
    const store = new ProbeStore(dir);
    await store.put("a");

    const raw = JSON.parse(readFileSync(path.join(dir, "items.json"), "utf8")) as {
      schemaVersion: number;
      items: Array<{ id: string }>;
    };
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.items).toEqual([{ id: "a" }]);
  });

  it("writes at a custom schema version when one is configured", async () => {
    const dir = tmp();
    const store = new JsonFileStore<{ id: string }>({
      directory: dir,
      fileName: "custom.json",
      schemaVersion: 7,
    });
    await expect(store["writeAll"]([{ id: "a" }])).resolves.toBeUndefined();

    const raw = JSON.parse(readFileSync(path.join(dir, "custom.json"), "utf8")) as {
      schemaVersion: number;
    };
    expect(raw.schemaVersion).toBe(7);
  });

  it("reports a corrupt file through the onCorrupt callback", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "items.json"), "{ not json", "utf8");
    const reported: string[] = [];
    const store = new ProbeStore(dir, {
      onCorrupt: (p) => {
        reported.push(p);
      },
    });

    expect(await store.peek()).toEqual([]);
    expect(reported).toEqual([path.join(dir, "items.json")]);
  });

  it("refuses to overwrite a document written by a newer OmniNode", async () => {
    const dir = tmp();
    const file = path.join(dir, "items.json");
    const contents = JSON.stringify({ schemaVersion: 99, items: [{ id: "newer" }] });
    writeFileSync(file, contents, "utf8");
    const store = new ProbeStore(dir);

    await expect(store.put("mine")).rejects.toThrow(/newer OmniNode/);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("keeps serving reads after a failed write", async () => {
    const dir = tmp();
    const file = path.join(dir, "items.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, items: [{ id: "newer" }] }), "utf8");
    const store = new ProbeStore(dir);

    await expect(store.put("mine")).rejects.toThrow(/newer OmniNode/);
    // The refused write left the store usable and the data intact.
    expect(await store.peek()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).items).toEqual([{ id: "newer" }]);
  });
});
