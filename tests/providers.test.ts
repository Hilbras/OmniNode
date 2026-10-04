import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors/index.js";
import { authHeaders, resolveApiKey } from "../src/providers/auth.js";
import { createProvider, OPENAI_COMPATIBLE_TYPES } from "../src/providers/factory.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import type { ProviderConfig, ProviderType } from "../src/types/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const baseConfig: ProviderConfig = {
  name: "gw",
  type: "openai-compatible",
  baseUrl: "https://api.example.com/v1/",
};

const modelListBody = {
  object: "list",
  data: [
    { id: "model-a", object: "model", created: 1700000000, owned_by: "org" },
    { id: "model-b", object: "model" },
    { notAnId: true },
  ],
};

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const result = handler(String(url), init);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OpenAICompatibleProvider", () => {
  it("normalizes the base URL", () => {
    const provider = new OpenAICompatibleProvider(baseConfig);
    expect(provider.config.baseUrl).toBe("https://api.example.com/v1");
  });

  it("discovers and normalizes models, skipping invalid entries", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe("https://api.example.com/v1/models");
      return { status: 200, body: modelListBody };
    });
    const provider = new OpenAICompatibleProvider(baseConfig);
    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ provider: "gw", id: "model-a", status: "available" });
    expect(models[0]?.metadata).toMatchObject({ ownedBy: "org", createdAt: 1700000000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a Bearer token from the referenced environment variable", async () => {
    vi.stubEnv("GW_API_KEY", "secret-key");
    const fetchMock = mockFetch(() => ({ status: 200, body: { data: [] } }));
    const provider = new OpenAICompatibleProvider({
      ...baseConfig,
      apiKeyEnvVar: "GW_API_KEY",
    });
    await provider.listModels();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
  });

  it("accepts a bare array response shape", async () => {
    mockFetch(() => ({ status: 200, body: [{ id: "solo" }] }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("solo");
  });

  it("maps HTTP 401 to PROVIDER_AUTH_FAILED with an env hint", async () => {
    mockFetch(() => ({ status: 401, body: { error: { message: "bad key" } } }));
    const provider = new OpenAICompatibleProvider({
      ...baseConfig,
      apiKeyEnvVar: "GW_API_KEY",
    });
    await expect(provider.listModels()).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
      message: expect.stringContaining("GW_API_KEY"),
    });
  });

  it("maps HTTP 500 to PROVIDER_UNAVAILABLE with status details", async () => {
    mockFetch(() => ({ status: 500, body: { error: "boom" } }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    await expect(provider.listModels()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { status: 500 },
    });
  });

  it("maps network failures to PROVIDER_UNAVAILABLE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const provider = new OpenAICompatibleProvider(baseConfig);
    await expect(provider.listModels()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("healthCheck reports healthy with model count", async () => {
    mockFetch(() => ({ status: 200, body: { data: [{ id: "a" }, { id: "b" }] } }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const status = await provider.healthCheck();
    expect(status.health).toBe("healthy");
    expect(status.connected).toBe(true);
    expect(status.modelCount).toBe(2);
  });

  it("healthCheck reports unreachable with a message on auth failure", async () => {
    mockFetch(() => ({ status: 403, body: {} }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const status = await provider.healthCheck();
    expect(status.health).toBe("unreachable");
    expect(status.connected).toBe(false);
    expect(status.modelCount).toBe(0);
    expect(status.message).toContain("Authentication");
  });

  it("healthCheck reports degraded on server errors", async () => {
    mockFetch(() => ({ status: 503, body: {} }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    const status = await provider.healthCheck();
    expect(status.health).toBe("degraded");
  });

  it("chat maps the OpenAI response shape", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      return {
        status: 200,
        body: {
          model: "model-a",
          choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        },
      };
    });
    const provider = new OpenAICompatibleProvider(baseConfig);
    const response = await provider.chat({
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 32,
    });
    expect(response.content).toBe("hello there");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ promptTokens: 4, completionTokens: 3, totalTokens: 7 });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.model).toBe("model-a");
    expect(body.max_tokens).toBe(32);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("chat maps 404 to MODEL_NOT_FOUND", async () => {
    mockFetch(() => ({ status: 404, body: { error: { message: "no such model" } } }));
    const provider = new OpenAICompatibleProvider(baseConfig);
    await expect(
      provider.chat({ model: "missing", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });
});

describe("auth", () => {
  it("resolveApiKey returns undefined when no env var is referenced", () => {
    expect(resolveApiKey(baseConfig, {})).toBeUndefined();
  });

  it("resolveApiKey throws PROVIDER_AUTH_FAILED when the variable is unset", () => {
    expect(() =>
      resolveApiKey({ ...baseConfig, apiKeyEnvVar: "MISSING" }, {}),
    ).toThrow(ProviderError);
  });

  it("authHeaders merges provider headers with the bearer token", () => {
    const headers = authHeaders(
      { ...baseConfig, apiKeyEnvVar: "K", headers: { "x-custom": "1" } },
      { K: "tok" },
    );
    expect(headers).toEqual({ "x-custom": "1", authorization: "Bearer tok" });
  });

  it("authHeaders passes through provider headers when no key is needed", () => {
    const headers = authHeaders({ ...baseConfig, headers: { "x-custom": "1" } }, {});
    expect(headers).toEqual({ "x-custom": "1" });
  });
});

describe("createProvider", () => {
  it.each(OPENAI_COMPATIBLE_TYPES)("builds an OpenAI-compatible adapter for %s", (type) => {
    const provider = createProvider({ ...baseConfig, type: type as ProviderType });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("defers omnihilbras to Phase 2", () => {
    expect(() => createProvider({ ...baseConfig, type: "omnihilbras" })).toThrow(
      expect.objectContaining({
        code: "NOT_IMPLEMENTED",
        message: expect.stringContaining("Phase 2"),
      }),
    );
  });
});
