/**
 * v3 audit M2 — persistence durability.
 *
 * Two defects in `src/persistence/json-file-store.ts`:
 *   1. a store file written by a NEWER OmniNode was silently destroyed by the
 *      next write (`readDocument` returned `[]` for a "future" document and
 *      `mutate` then wrote it back at the current schema version);
 *   2. `writeFileAtomic` used a fixed temp path, so two concurrent writers
 *      corrupted each other's file.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/persistence/json-file-store.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { FilePlanStore } from "../src/planner/store.js";
import { FileReportStore } from "../src/reports/store.js";
import { StoreVersionError } from "../src/errors/index.js";
import type { Task } from "../src/types/task.js";
import type { Plan } from "../src/types/plan.js";
import type { Report } from "../src/types/report.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-durability-"));
}

const FUTURE_DOCUMENT = JSON.stringify(
  { schemaVersion: 99, items: [{ id: "newer-item", objective: "from the future" }] },
  null,
  2,
);

const TASK: Task = {
  id: "task-local",
  objective: "local work",
  status: "created",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  attempt: 0,
};

const PLAN: Plan = {
  id: "plan-local",
  objective: "local plan",
  summary: "local plan",
  steps: [],
  generatedBy: "heuristic",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const REPORT = {
  id: "report-local",
  taskId: "task-local",
  agent: "worker",
  summary: "local report",
  findings: [],
  createdAt: "2024-01-01T00:00:00.000Z",
} as unknown as Report;

describe("M2.1 — a store file from a newer OmniNode is never overwritten", () => {
  it("refuses to write and leaves the file byte-identical", async () => {
    const dir = tmp();
    const file = path.join(dir, "tasks.json");
    writeFileSync(file, FUTURE_DOCUMENT, "utf8");
    const before = readFileSync(file, "utf8");

    const store = new FileTaskStore(dir);
    const task: Task = {
      id: "task-local",
      objective: "local work",
      status: "created",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      attempt: 0,
    };

    await expect(store.save(task)).rejects.toBeInstanceOf(StoreVersionError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not quarantine a future file — it is not corruption", async () => {
    const dir = tmp();
    const file = path.join(dir, "tasks.json");
    writeFileSync(file, FUTURE_DOCUMENT, "utf8");

    const store = new FileTaskStore(dir);
    await expect(
      store.save({
        id: "task-local",
        objective: "local work",
        status: "created",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        attempt: 0,
      }),
    ).rejects.toBeInstanceOf(StoreVersionError);

    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
  });

  it("reports the version mismatch with actionable details", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "tasks.json"), FUTURE_DOCUMENT, "utf8");
    const store = new FileTaskStore(dir);

    const error = await store
      .save({
        id: "task-local",
        objective: "local work",
        status: "created",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        attempt: 0,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StoreVersionError);
    expect((error as StoreVersionError).code).toBe("STORE_VERSION");
    expect((error as StoreVersionError).message).toContain("newer OmniNode");
    expect((error as StoreVersionError).details?.schemaVersion).toBe(99);
  });

  it("protects every store that shares the persistence helper", async () => {
    // tasks.json
    const taskDir = tmp();
    writeFileSync(path.join(taskDir, "tasks.json"), FUTURE_DOCUMENT, "utf8");
    const taskBefore = readFileSync(path.join(taskDir, "tasks.json"), "utf8");
    await expect(new FileTaskStore(taskDir).save(TASK)).rejects.toBeInstanceOf(StoreVersionError);
    expect(readFileSync(path.join(taskDir, "tasks.json"), "utf8")).toBe(taskBefore);

    // plans.json
    const planDir = tmp();
    writeFileSync(path.join(planDir, "plans.json"), FUTURE_DOCUMENT, "utf8");
    const planBefore = readFileSync(path.join(planDir, "plans.json"), "utf8");
    await expect(new FilePlanStore(planDir).save(PLAN)).rejects.toBeInstanceOf(StoreVersionError);
    expect(readFileSync(path.join(planDir, "plans.json"), "utf8")).toBe(planBefore);

    // reports.json
    const reportDir = tmp();
    writeFileSync(path.join(reportDir, "reports.json"), FUTURE_DOCUMENT, "utf8");
    const reportBefore = readFileSync(path.join(reportDir, "reports.json"), "utf8");
    await expect(new FileReportStore(reportDir).saveReports([REPORT])).rejects.toBeInstanceOf(
      StoreVersionError,
    );
    expect(readFileSync(path.join(reportDir, "reports.json"), "utf8")).toBe(reportBefore);
  });

  it("still writes a current-version file normally", async () => {
    const dir = tmp();
    const store = new FileTaskStore(dir);
    const task: Task = {
      id: "task-local",
      objective: "local work",
      status: "created",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      attempt: 0,
    };
    await store.save(task);
    const persisted = await store.get("task-local");
    expect(persisted?.objective).toBe("local work");
  });
});

describe("M2.2 — concurrent atomic writes do not corrupt each other", () => {
  it("keeps the file valid when two writers race", async () => {
    const dir = tmp();
    const target = path.join(dir, "racy.json");
    const a = JSON.stringify({ writer: "a", payload: "a".repeat(20_000) }, null, 2);
    const b = JSON.stringify({ writer: "b", payload: "b".repeat(20_000) }, null, 2);

    await Promise.all([writeFileAtomic(target, a), writeFileAtomic(target, b)]);

    const written = readFileSync(target, "utf8");
    // The file must be one complete document, never an interleaved mixture.
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written) as { writer: string };
    expect(["a", "b"]).toContain(parsed.writer);
  });

  it("leaves no temp files behind", async () => {
    const dir = tmp();
    const target = path.join(dir, "clean.json");
    await Promise.all([
      writeFileAtomic(target, JSON.stringify({ n: 1 })),
      writeFileAtomic(target, JSON.stringify({ n: 2 })),
    ]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("does not reuse the same temp path for two writers", async () => {
    const dir = tmp();
    const target = path.join(dir, "unique.json");
    await Promise.all([
      writeFileAtomic(target, JSON.stringify({ n: 1 })),
      writeFileAtomic(target, JSON.stringify({ n: 2 })),
    ]);
    // A fixed temp name would leave at most one file; a unique one leaves
    // none because each writer renames its own file away.
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("M2 — a plan store refuses a future document too", () => {
  it("protects plans.json", async () => {
    const dir = tmp();
    const file = path.join(dir, "plans.json");
    writeFileSync(file, FUTURE_DOCUMENT, "utf8");
    const before = readFileSync(file, "utf8");

    const store = new FilePlanStore(dir);
    const plan: Plan = {
      id: "plan-local",
      objective: "local plan",
      steps: [],
      createdAt: "2024-01-01T00:00:00.000Z",
    } as unknown as Plan;

    await expect(store.save(plan)).rejects.toBeInstanceOf(StoreVersionError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
