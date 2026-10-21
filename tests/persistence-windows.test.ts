/**
 * v3 audit — Windows resilience of the atomic file write.
 *
 * On Windows a file that another process has open (an indexer, an antivirus
 * scanner, a concurrent writer) makes `fs.rename` fail with `EPERM`/`EBUSY`:
 * `MoveFileEx` cannot replace a file that is still open. Without a retry an
 * "atomic" write fails on a perfectly healthy filesystem.
 *
 * The failure is simulated here so the retry is covered on every platform.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameCalls: { from: string; to: string }[] = [];
let failuresLeft = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCalls.push({ from, to });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return actual.rename(from, to);
    },
  };
});

const { writeFileAtomic } = await import("../src/persistence/json-file-store.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omninode-rename-"));
  renameCalls.length = 0;
  failuresLeft = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic retries a transiently locked rename", () => {
  it("succeeds when the first rename attempt is refused", async () => {
    const target = path.join(dir, "locked.json");
    failuresLeft = 1;

    await writeFileAtomic(target, JSON.stringify({ ok: true }));

    expect(renameCalls.length).toBeGreaterThan(1);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ ok: true });
  });

  it("retries a few times before giving up", async () => {
    const target = path.join(dir, "very-locked.json");
    failuresLeft = 3;

    await writeFileAtomic(target, "payload");

    expect(renameCalls.length).toBe(4);
    expect(readFileSync(target, "utf8")).toBe("payload");
  });

  it("still fails when the rename is refused for good", async () => {
    const target = path.join(dir, "always-locked.json");
    failuresLeft = 99;

    await expect(writeFileAtomic(target, "payload")).rejects.toThrow(/EPERM|not permitted/);
  });

  it("leaves no temp file behind after a successful retry", async () => {
    const target = path.join(dir, "clean.json");
    failuresLeft = 1;

    await writeFileAtomic(target, "payload");

    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes the target directly when nothing is in the way", async () => {
    const target = path.join(dir, "plain.json");
    writeFileSync(path.join(dir, "existing.json"), "old");

    await writeFileAtomic(target, "new");

    expect(renameCalls).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});
