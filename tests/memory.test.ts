import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryProvider } from "../src/memory/local.js";
import { RememberaMemoryProvider } from "../src/memory/remembera.js";
import { createMemoryProvider } from "../src/memory/factory.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryError } from "../src/errors/index.js";
import type { Task } from "../src/types/task.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function localProvider(): LocalMemoryProvider {
  return new LocalMemoryProvider(mkdtempSync(path.join(tmpdir(), "omninode-mem-")));
}

describe("LocalMemoryProvider", () => {
  it("writes and queries entries by relevance", async () => {
    const provider = localProvider();
    await provider.write({
      key: "finding:1",
      scope: "project",
      content: "The authentication module has a known SQL injection problem",
      tags: ["known-problem", "security"],
    });
    await provider.write({
      key: "note:unrelated",
      scope: "project",
      content: "The build pipeline uses pnpm",
    });
    await provider.write({
      key: "task:old",
      scope: "task",
      content: "Unrelated task outcome about deployments",
    });

    const relevant = await provider.query({ text: "audit the authentication module" });
    expect(relevant.map((e) => e.key)).toEqual(["finding:1"]);
  });

  it("filters by scope and tags, and lists everything without text", async () => {
    const provider = localProvider();
    await provider.write({ key: "a", scope: "project", content: "alpha project entry" });
    await provider.write({ key: "b", scope: "task", content: "beta task entry" });
    await provider.write({
      key: "c",
      scope: "project",
      content: "gamma entry",
      tags: ["known-problem"],
    });

    expect((await provider.query({})).map((e) => e.key).sort()).toEqual(["a", "b", "c"]);
    expect((await provider.query({ scope: "project" })).map((e) => e.key).sort()).toEqual(["a", "c"]);
    expect((await provider.query({ tags: ["known-problem"] })).map((e) => e.key)).toEqual(["c"]);
    expect(await provider.query({ text: "zzz nothing matches this" })).toEqual([]);
  });

  it("honors limit and overwrites entries with the same key", async () => {
    const provider = localProvider();
    for (let i = 0; i < 5; i += 1) {
      await provider.write({ key: `k${i}`, scope: "knowledge", content: `entry number ${i} about caching` });
    }
    expect((await provider.query({ limit: 3 })).length).toBe(3);

    await provider.write({ key: "k0", scope: "knowledge", content: "updated content" });
    const all = await provider.query({});
    expect(all).toHaveLength(5);
    expect(all.find((e) => e.key === "k0")?.content).toBe("updated content");
  });
});

describe("RememberaMemoryProvider", () => {
  const config = {
    baseUrl: "https://remembera.example",
    apiKeyEnvVar: "REMEMBERA_KEY",
    env: { REMEMBERA_KEY: "secret" } as Record<string, string | undefined>,
  };

  function mockFetch(handler: (url: string, body: unknown) => { status: number; body: unknown }) {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      const result = handler(String(url), parsed);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts queries and normalizes entries", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe("https://remembera.example/api/memory/query");
      return {
        status: 200,
        body: {
          entries: [
            { key: "k1", scope: "project", content: "entry one", tags: ["t"] },
            { key: "k2", content: "entry two without scope" },
            { notValid: true },
          ],
        },
      };
    });
    const provider = new RememberaMemoryProvider(config);
    const entries = await provider.query({ text: "hello" });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: "k1", scope: "project" });
    expect(entries[1]?.scope).toBe("knowledge"); // defaulted
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
  });

  it("writes entries and maps failures to MemoryError", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe("https://remembera.example/api/memory");
      return { status: 201, body: {} };
    });
    const provider = new RememberaMemoryProvider(config);
    await provider.write({ key: "k", scope: "project", content: "c" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockFetch(() => ({ status: 500, body: {} }));
    await expect(provider.write({ key: "k", scope: "project", content: "c" })).rejects.toThrow(MemoryError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(provider.query({})).rejects.toThrow(MemoryError);
  });

  it("throws when the referenced key env var is unset", async () => {
    const provider = new RememberaMemoryProvider({
      baseUrl: "https://remembera.example",
      apiKeyEnvVar: "MISSING_KEY",
      env: {},
    });
    await expect(provider.query({})).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
    });
  });
});

describe("createMemoryProvider", () => {
  it("defaults to the local provider", () => {
    expect(createMemoryProvider()).toBeInstanceOf(LocalMemoryProvider);
    expect(createMemoryProvider({ provider: "local" })).toBeInstanceOf(LocalMemoryProvider);
  });

  it("builds the Remembera adapter and requires a base url for it", () => {
    expect(createMemoryProvider({ provider: "remembera", baseUrl: "https://r.example" })).toBeInstanceOf(
      RememberaMemoryProvider,
    );
    expect(() => createMemoryProvider({ provider: "remembera" })).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("rejects unknown providers", () => {
    expect(() => createMemoryProvider({ provider: "elephant" })).toThrow(/Unknown memory provider/);
  });
});
