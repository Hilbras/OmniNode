import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniHilbrasProvider } from "../src/providers/omnihilbras/index.js";
import { ModelRegistry } from "../src/registry/index.js";
import type { ProviderConfig } from "../src/types/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const config: ProviderConfig = {
  name: "hilbras",
  type: "omnihilbras",
  baseUrl: "https://gateway.omnihilbras.example/v1",
  apiKeyEnvVar: "OMNIHILBRAS_API_KEY",
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OmniHilbrasProvider", () => {
  it("connect runs the full flow: authenticate, fetch, validate, register", async () => {
    vi.stubEnv("OMNIHILBRAS_API_KEY", "hb-secret");
    const fetchMock = mockFetch({
      data: [
        { id: "kimi-k2", owned_by: "moonshot" },
        { id: "qwen3-coder" },
      ],
    });

    const provider = new OmniHilbrasProvider(config);
    const registry = new ModelRegistry();
    const result = await provider.connect(registry);

    // Bearer authentication was attempted with the referenced env var.
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer hb-secret");

    expect(result.status).toMatchObject({
      name: "hilbras",
      type: "omnihilbras",
      health: "healthy",
      connected: true,
      modelCount: 2,
    });
    expect(result.status.message).toContain("validated 2 unique model(s)");

    // Models are validated, tagged and registered.
    expect(result.models).toHaveLength(2);
    expect(result.models[0]?.metadata).toMatchObject({
      gateway: "omnihilbras",
      ownedBy: "moonshot",
    });
    expect(result.models.every((m) => m.status === "available")).toBe(true);
    expect(result.registered).toBe(2);
    expect(registry.isAvailable("hilbras", "kimi-k2")).toBe(true);
    expect(registry.isAvailable("hilbras", "qwen3-coder")).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it("connect works without an API key configured", async () => {
    mockFetch({ data: [{ id: "m" }] });
    const provider = new OmniHilbrasProvider({ ...config, apiKeyEnvVar: undefined });
    const result = await provider.connect();
    expect(result.status.message).toContain("no API key configured");
    expect(result.registered).toBe(0);
  });

  it("connect deduplicates model ids", async () => {
    vi.stubEnv("OMNIHILBRAS_API_KEY", "hb-secret");
    mockFetch({ data: [{ id: "kimi-k2" }, { id: "kimi-k2" }, { id: "gemini-flash" }] });
    const provider = new OmniHilbrasProvider(config);
    const result = await provider.connect();

    expect(result.models.map((m) => m.id)).toEqual(["kimi-k2", "gemini-flash"]);
    expect(result.duplicates).toEqual(["kimi-k2"]);
    expect(result.status.message).toContain("skipped 1 duplicate(s)");
  });

  it("connect throws PROVIDER_AUTH_FAILED when the env var is unset", async () => {
    const provider = new OmniHilbrasProvider(config);
    await expect(provider.connect()).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
      message: expect.stringContaining("OMNIHILBRAS_API_KEY"),
    });
  });

  it("connect propagates transport failures as PROVIDER_UNAVAILABLE", async () => {
    vi.stubEnv("OMNIHILBRAS_API_KEY", "hb-secret");
    mockFetch({ error: "boom" }, 503);
    const provider = new OmniHilbrasProvider(config);
    await expect(provider.connect()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("healthCheck still works as a non-throwing probe", async () => {
    mockFetch({ error: "unauthorized" }, 401);
    const provider = new OmniHilbrasProvider(config);
    const status = await provider.healthCheck();
    expect(status.health).toBe("unreachable");
    expect(status.connected).toBe(false);
  });
});
