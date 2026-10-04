/**
 * v2 Phase 12 tests — Persistence Layer v2 (roadmap §16): schema versioning,
 * corruption handling, atomic/fsynced writes, and the v1 → v2 migration path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VERSION,
  inspectDocument,
  migrateProjectStores,
  writeFileAtomic,
} from "../src/persistence/index.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { FileAuditLog } from "../src/audit/index.js";
import { createProgram } from "../src/cli/index.js";
import type { Task } from "../src/types/task.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-persist-v2-"));
}

function task(id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    objective: `objective ${id}`,
    status: "created",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("schema versioning (§16)", () => {
  it("classifies every document state", async () => {
    const dir = tmp();
    expect(await inspectDocument(`${dir}/missing.json`)).toEqual({ status: "missing" });

    writeFileSync(`${dir}/empty.json`, "", "utf8");
    expect((await inspectDocument(`${dir}/empty.json`)).status).toBe("empty");

    writeFileSync(`${dir}/legacy.json`, JSON.stringify([{ id: "a" }]), "utf8");
    expect((await inspectDocument(`${dir}/legacy.json`)).status).toBe("v1-legacy");

    writeFileSync(`${dir}/current.json`, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: [{ id: "a" }] }), "utf8");
    expect(await inspectDocument(`${dir}/current.json`)).toMatchObject({ status: "current", count: 1 });

    writeFileSync(`${dir}/future.json`, JSON.stringify({ schemaVersion: 99, items: [] }), "utf8");
    expect(await inspectDocument(`${dir}/future.json`)).toEqual({ status: "future", schemaVersion: 99 });

    writeFileSync(`${dir}/broken.json`, "{ nope", "utf8");
    expect((await inspectDocument(`${dir}/broken.json`)).status).toBe("corrupt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to read a future-version document instead of misreading it", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/tasks.json`, JSON.stringify({ schemaVersion: 99, items: [{ id: "x" }] }), "utf8");
    const store = new FileTaskStore(dir);
    expect(await store.list()).toEqual([]); // no data leakage from a newer format
    // The file is left untouched for the newer OmniNode to read.
    expect(JSON.parse(readFileSync(`${dir}/tasks.json`, "utf8")).schemaVersion).toBe(99);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("atomic writes (§16)", () => {
  it("leaves no temp file behind and writes a complete document", async () => {
    const dir = tmp();
    await writeFileAtomic(`${dir}/doc.json`, '{"ok":true}\n');
    expect(JSON.parse(readFileSync(`${dir}/doc.json`, "utf8"))).toEqual({ ok: true });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the audit log survives and stays parseable", async () => {
    const dir = tmp();
    const audit = new FileAuditLog(dir);
    await audit.record({ at: new Date().toISOString(), action: "task.created", id: "t1" });
    await audit.record({ at: new Date().toISOString(), action: "task.completed", id: "t1" });
    const events = await audit.recent();
    expect(events.map((e) => e.action)).toEqual(["task.created", "task.completed"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("migration (§16)", () => {
  it("migrates v1 documents in place and is idempotent", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/tasks.json`, JSON.stringify([task("t1"), task("t2")]), "utf8");

    const dry = await migrateProjectStores(dir, { checkOnly: true });
    const dryTasks = dry.find((r) => r.file === "tasks.json");
    expect(dryTasks).toMatchObject({ state: "v1-legacy", migrated: false, after: 2 });
    // A dry run writes nothing.
    expect(Array.isArray(JSON.parse(readFileSync(`${dir}/tasks.json`, "utf8")))).toBe(true);

    const applied = await migrateProjectStores(dir);
    expect(applied.find((r) => r.file === "tasks.json")).toMatchObject({ migrated: true, after: 2 });
    const doc = JSON.parse(readFileSync(`${dir}/tasks.json`, "utf8")) as { schemaVersion: number; items: Task[] };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.items).toHaveLength(2);

    // Idempotent: a second run changes nothing.
    const again = await migrateProjectStores(dir);
    expect(again.find((r) => r.file === "tasks.json")).toMatchObject({ state: "current", migrated: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports future and corrupt files without touching them", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/plans.json`, JSON.stringify({ schemaVersion: 99, items: [] }), "utf8");
    writeFileSync(`${dir}/memory.json`, "not json", "utf8");

    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "plans.json")).toMatchObject({ state: "future", migrated: false });
    expect(reports.find((r) => r.file === "memory.json")).toMatchObject({ state: "corrupt", migrated: false });
    expect(JSON.parse(readFileSync(`${dir}/plans.json`, "utf8")).schemaVersion).toBe(99);
    expect(readFileSync(`${dir}/memory.json`, "utf8")).toBe("not json");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("CLI: omninode migrate", () => {
  let workDir: string;
  let previousCwd: string;

  beforeEach(() => {
    workDir = tmp();
    previousCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports and upgrades legacy stores", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const storeDir = path.join(workDir, ".omninode");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(path.join(storeDir, "tasks.json"), JSON.stringify([task("t1")]), "utf8");

    const check = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "migrate", "--check"]);
    const checkOutput = check.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(checkOutput).toContain("tasks.json");
    expect(checkOutput).toContain("would migrate");
    expect(Array.isArray(JSON.parse(readFileSync(path.join(storeDir, "tasks.json"), "utf8")))).toBe(true);

    check.mockClear();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const applyOutput = check.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(applyOutput).toContain("migrated");
    const doc = JSON.parse(readFileSync(path.join(storeDir, "tasks.json"), "utf8")) as { schemaVersion: number };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("says so when everything is current", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await new FileTaskStore(path.join(workDir, ".omninode")).save(task("t1"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("All stores are at schema");
    expect(existsSync(path.join(workDir, ".omninode/tasks.json"))).toBe(true);
  });
});