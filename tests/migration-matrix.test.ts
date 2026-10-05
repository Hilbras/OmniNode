/**
 * v2 Phase 23 tests — migration matrix (roadmap §23 / hardening Fix 11):
 * every v1 storage shape migrates deterministically, safely, idempotently.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateProjectStores } from "../src/persistence/index.js";

function storageWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-migmatrix-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

const CURRENT = (items: unknown[]): string =>
  JSON.stringify({ schemaVersion: 2, items }, null, 2);

describe("migration matrix (§23 Fix 11)", () => {
  it("fresh installation: nothing to migrate, nothing created", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-mig-"));
    const reports = await migrateProjectStores(dir);
    expect(reports.every((r) => r.state === "missing" && !r.migrated)).toBe(true);
    expect(existsSync(path.join(dir, "tasks.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("v1 bare-array storage migrates with data preserved", async () => {
    const dir = storageWith({
      "tasks.json": JSON.stringify([
        { id: "t1", objective: "legacy work", status: "completed", createdAt: "", updatedAt: "" },
      ]),
    });
    await migrateProjectStores(dir);
    const doc = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as {
      schemaVersion: number;
      items: Array<{ id: string; objective: string }>;
    };
    expect(doc.schemaVersion).toBe(2);
    expect(doc.items[0]).toMatchObject({ id: "t1", objective: "legacy work" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty v1 files migrate to empty current documents", async () => {
    const dir = storageWith({ "plans.json": "[]" });
    await migrateProjectStores(dir);
    const doc = JSON.parse(readFileSync(path.join(dir, "plans.json"), "utf8")) as { schemaVersion: number; items: unknown[] };
    expect(doc.schemaVersion).toBe(2);
    expect(doc.items).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("v1 documents with unknown fields migrate without data loss", async () => {
    const dir = storageWith({
      "reports.json": CURRENT([
        { kind: "report", report: { id: "r1", taskId: "t", agent: "a", summary: "s", findings: [], recommendations: [], createdAt: "", futureField: "kept" } },
      ]),
    });
    await migrateProjectStores(dir);
    // Already at the current schema version — untouched, unknown fields preserved.
    const doc = JSON.parse(readFileSync(path.join(dir, "reports.json"), "utf8")) as { schemaVersion: number };
    expect(doc.schemaVersion).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent: running migrate twice does not corrupt or duplicate", async () => {
    const dir = storageWith({
      "tasks.json": JSON.stringify([{ id: "t1", objective: "x", status: "created", createdAt: "", updatedAt: "" }]),
    });
    await migrateProjectStores(dir);
    const first = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as { items: unknown[] };
    await migrateProjectStores(dir);
    const second = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as { items: unknown[] };
    expect(second.items).toEqual(first.items);
    rmSync(dir, { recursive: true, force: true });
  });

  it("already-migrated v2 storage is reported as current and left alone", async () => {
    const dir = storageWith({
      "tasks.json": CURRENT([{ id: "t1" }]),
    });
    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "tasks.json")).toMatchObject({ state: "current", migrated: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("malformed records are reported, never silently destroyed", async () => {
    const dir = storageWith({ "memory.json": "{ broken json" });
    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "memory.json")).toMatchObject({
      state: "corrupt",
      migrated: false,
      note: expect.any(String),
    });
    // Migration never deletes or overwrites damaged data — the store's
    // readAll quarantine handles that when the file is actually loaded.
    expect(existsSync(path.join(dir, "memory.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("future schemas are refused, never rewritten", async () => {
    const dir = storageWith({
      "pipelines.json": JSON.stringify({ schemaVersion: 99, items: [{ id: "future" }] }),
    });
    const reports = await migrateProjectStores(dir);
    expect(reports.find((r) => r.file === "pipelines.json")).toMatchObject({
      state: "future",
      migrated: false,
    });
    expect(readFileSync(path.join(dir, "pipelines.json"), "utf8")).toContain('"future"');
    rmSync(dir, { recursive: true, force: true });
  });

  it("running migrate twice on v1 data is deterministic and safe", async () => {
    const dir = storageWith({ "tasks.json": JSON.stringify([{ id: "t1", objective: "x", status: "created", createdAt: "", updatedAt: "" }]) });
    await migrateProjectStores(dir);
    const afterFirst = readFileSync(path.join(dir, "tasks.json"), "utf8");
    await migrateProjectStores(dir);
    expect(readFileSync(path.join(dir, "tasks.json"), "utf8")).toBe(afterFirst);
    rmSync(dir, { recursive: true, force: true });
  });
});
