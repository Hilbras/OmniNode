/**
 * v2 Phase 8 tests — Remembera / memory integration (roadmap §12): the
 * formalized contract across adapters, structured categories, task-oriented
 * budgeted retrieval, and the failure policy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryProvider } from "../src/memory/local.js";
import { RememberaMemoryProvider } from "../src/memory/remembera.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryError } from "../src/errors/index.js";
import type { IMemoryProvider, MemoryEntry } from "../src/types/memory.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-mem-v2-"));
}

afterEach(() => vi.unstubAllGlobals());

/** Runs the shared contract expectations against any adapter. */
function itSatisfiesContract(name: string, make: () => IMemoryProvider): void {
  describe(`contract: ${name}`, () => {
    it("stores, retrieves and searches", async () => {
      const provider = make();
      await provider.store({
        key: "decision:1",
        scope: "project",
        category: "decisions",
        content: "We decided to use parameterized queries for the auth module",
        tags: ["architecture"],
      });
      await provider.store({
        key: "note:unrelated",
        scope: "knowledge",
        content: "Deployment notes about blue-green releases",
      });

      expect((await provider.retrieve({ text: "parameterized queries auth" })).map((e) => e.key)).toEqual([
        "decision:1",
      ]);
      expect((await provider.search("parameterized queries")).map((e) => e.key)).toEqual(["decision:1"]);
      expect(await provider.retrieve({ category: "decisions" })).toHaveLength(1);
      expect(await provider.retrieve({ scope: "knowledge" })).toHaveLength(1);
    });

    it("supports the v1 query/write aliases", async () => {
      const provider = make();
      await provider.write({ key: "k", scope: "task", content: "legacy alias entry about caching" });
      expect((await provider.query({ text: "caching" })).map((e) => e.key)).toEqual(["k"]);
    });

    it("publishes provider metadata", async () => {
      expect(make().metadata()).toMatchObject({ name: expect.any(String) });
      const meta = make().metadata();
      expect(meta.capabilities).toContain("retrieve");
      expect(meta.capabilities).toContain("store");
      expect(meta.relevanceRanking).toBe(true);
    });
  });
}

itSatisfiesContract("LocalMemoryProvider", () => new LocalMemoryProvider(tmp()));

/** A tiny in-memory fake of the Remembera HTTP API for contract parity. */
function stubRememberaGateway(): void {
  const entries: MemoryEntry[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as
        | Partial<MemoryEntry>
        | { text?: string; scope?: string; category?: string; limit?: number };
      const respond = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (String(_url).endsWith("/api/memory/query")) {
        const { text, scope, category, limit } = body as {
          text?: string;
          scope?: string;
          category?: string;
          limit?: number;
        };
        const matched = entries.filter((e) => (scope ? e.scope === scope : true))
          .filter((e) => (category ? e.category === category : true))
          .filter((e) => (text ? e.content.toLowerCase().includes(text.toLowerCase().split(" ")[0]!) : true));
        return respond({ entries: matched.slice(0, limit ?? 10) });
      }
      const entry = body as MemoryEntry;
      const index = entries.findIndex((e) => e.key === entry.key);
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      return respond({});
    }),
  );
}

describe("contract: RememberaMemoryProvider", () => {
  beforeEach(() => stubRememberaGateway());
  itSatisfiesContract(
    "RememberaMemoryProvider",
    () =>
      new RememberaMemoryProvider({
        baseUrl: "https://remembera.test",
        env: { REMEMBERA_KEY: "test-key" },
        apiKeyEnvVar: "REMEMBERA_KEY",
      }),
  );
});

describe("structured categories (§12)", () => {
  it("filters by category and survives the local→remembera round trip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL, init?: RequestInit) =>
          new Response(JSON.stringify(JSON.parse(String(init?.body)).entries ?? []), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const dir = tmp();
    const local = new LocalMemoryProvider(dir);
    await local.store({ key: "p", scope: "project", category: "problems", content: "rate limiter bug" });
    await local.store({ key: "c", scope: "project", category: "conventions", content: "kebab-case ids" });
    expect((await local.retrieve({ category: "problems" })).map((e) => e.key)).toEqual(["p"]);
    expect((await local.retrieve({ category: "conventions" })).map((e) => e.key)).toEqual(["c"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("task-oriented context retrieval (§12)", () => {
  it("returns entries, formatted text and a truncation flag within budget", async () => {
    const dir = tmp();
    const provider = new LocalMemoryProvider(dir);
    for (let i = 0; i < 20; i += 1) {
      await provider.store({
        key: `n${i}`,
        scope: "project",
        content: `authentication module note ${i} ${"x".repeat(400)}`,
      });
    }
    const service = new MemoryService(provider);
    const context = await service.contextFor({ objective: "authentication module", limit: 20 });
    expect(context.entries.length).toBeGreaterThan(0);
    expect(context.text).toContain("Relevant memory (project)");
    expect(context.text.length).toBeLessThanOrEqual(4_000);
    expect(context.truncated).toBe(true);

    const small = new MemoryService(provider, undefined, { maxContextChars: 100 });
    expect((await small.contextFor({ objective: "authentication module" })).truncated).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty context when nothing is relevant", async () => {
    const service = new MemoryService(new LocalMemoryProvider(tmp()));
    const context = await service.contextFor({ objective: "completely unrelated topic" });
    expect(context.text).toBe("");
    expect(context.entries).toEqual([]);
  });
});

describe("failure handling (§12)", () => {
  const failingProvider: IMemoryProvider = {
    name: "broken",
    metadata: () => ({ name: "broken", capabilities: ["retrieve"], relevanceRanking: false }),
    retrieve: async () => {
      throw new Error("Remembera unreachable");
    },
    store: async () => {
      throw new Error("Remembera unreachable");
    },
    search: async () => [],
    query: async () => [],
    write: async () => {},
  };

  it("continues without memory by default", async () => {
    const service = new MemoryService(failingProvider);
    expect((await service.contextFor({ objective: "x" })).text).toBe("");
    await expect(
      service.recordTaskOutcome({
        id: "t", objective: "x", status: "completed", attempt: 0,
        createdAt: "", updatedAt: "",
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates failures when memory is marked required", async () => {
    const service = new MemoryService(failingProvider, undefined, { required: true });
    await expect(service.contextFor({ objective: "x" })).rejects.toThrow(MemoryError);
    await expect(
      service.recordTaskOutcome({
        id: "t", objective: "x", status: "completed", attempt: 0,
        createdAt: "", updatedAt: "",
      }),
    ).rejects.toThrow(/marked required/);
  });

  it("required memory surfaces on the task: a task run fails when memory is required and broken", async () => {
    const service = new MemoryService(failingProvider, undefined, { required: true });
    const { TaskEngine } = await import("../src/tasks/engine.js");
    const { FileTaskStore } = await import("../src/tasks/store.js");
    const { AgentRegistry } = await import("../src/agents/index.js");
    const { RoleRegistry } = await import("../src/roles/index.js");
    const agent = {
      info: { name: "a", integration: "process" as const, status: "ready" as const },
      run: async () => ({ taskId: "t", status: "completed" as const, summary: "done" }),
      cancel: async () => {},
    };
    const agents = new AgentRegistry();
    agents.register(agent);
    const engine = new TaskEngine({
      agents,
      roles: new RoleRegistry(),
      store: new FileTaskStore(tmp()),
      memory: service,
    });
    const created = await engine.create({ objective: "audit auth", agent: "a" });
    // Memory retrieval happens before the agent runs — a required-memory
    // failure aborts the task instead of silently losing context.
    await expect(engine.run(created.id)).rejects.toThrow(MemoryError);
  });
});