/**
 * v2 Phase 6 tests — Provider Infrastructure v2 (roadmap §10): standardized
 * provider interface, model metadata, discovery (connect/getModel) and the
 * normalized provider error matrix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import {
  extractMessage,
  isRetryable,
  kindFromStatus,
  parseRetryAfter,
  providerHttpError,
} from "../src/providers/errors.js";
import type { ProviderError } from "../src/errors/index.js";
import type { ProviderConfig } from "../src/types/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config: ProviderConfig = {
  name: "gw",
  type: "openai-compatible",
  baseUrl: "https://gw.test/v1",
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

describe("provider identity + authentication (§10)", () => {
  it("exposes a stable providerId and a secret-free authentication summary", () => {
    const provider = new OpenAICompatibleProvider(
      { ...config, apiKeyEnvVar: "GW_KEY" },
      undefined,
      { GW_KEY: "secret" },
    );
    expect(provider.providerId).toBe("gw");
    expect(provider.authentication).toEqual({ method: "bearer", envVar: "GW_KEY", configured: true });
    expect(JSON.stringify(provider.authentication)).not.toContain("secret");
  });

  it("reports configured:false when the env var is unset, and none for keyless providers", () => {
    const unset = new OpenAICompatibleProvider({ ...config, apiKeyEnvVar: "GW_KEY" }, undefined, {});
    expect(unset.authentication.configured).toBe(false);
    const keyless = new OpenAICompatibleProvider(config, undefined, {});
    expect(keyless.authentication).toEqual({ method: "none", configured: true });
  });
});

describe("model discovery: connect / getModel (§10)", () => {
  it("connect authenticates and caches models; getModel answers from cache", async () => {
    mockFetch(() => ({ status: 200, body: { data: [{ id: "m1" }, { id: "m2" }] } }));
    const provider = new OpenAICompatibleProvider(config);
    const models = await provider.connect();
    expect(models.map((m) => m.id)).toEqual(["m1", "m2"]);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const callsAfterConnect = fetchMock.mock.calls.length;
    expect((await provider.getModel("m2"))?.id).toBe("m2");
    expect((await provider.getModel("nope"))).toBeUndefined();
    // Served from the cache — no extra round trip.
    expect(fetchMock.mock.calls.length).toBe(callsAfterConnect);
  });
});

describe("model metadata mapping (§10)", () => {
  it("maps context window, modalities and supported parameters", async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            id: "rich-model",
            name: "Rich Model v2",
            owned_by: "acme",
            context_length: 128_000,
            input_modalities: ["text", "image"],
            output_modalities: "text",
            supported_parameters: ["tools", "stream", "response_format"],
          },
        ],
      },
    }));
    const [model] = await new OpenAICompatibleProvider(config).listModels();
    expect(model).toMatchObject({
      id: "rich-model",
      name: "Rich Model v2",
      contextWindow: 128_000,
      inputTypes: ["text", "image"],
      outputTypes: ["text"],
      supportsTools: true,
      supportsStreaming: true,
      supportsStructuredOutput: true,
    });
  });

  it("omits metadata the provider does not report", async () => {
    mockFetch(() => ({ status: 200, body: { data: [{ id: "bare" }] } }));
    const [model] = await new OpenAICompatibleProvider(config).listModels();
    expect(model.contextWindow).toBeUndefined();
    expect(model.supportsTools).toBeUndefined();
    expect(model.inputTypes).toBeUndefined();
  });
});

describe("provider error normalization matrix (§10)", () => {
  const matrix: Array<[number, string]> = [
    [401, "AUTHENTICATION_ERROR"],
    [403, "AUTHENTICATION_ERROR"],
    [429, "RATE_LIMIT_ERROR"],
    [404, "MODEL_NOT_FOUND"],
    [408, "TIMEOUT"],
    [500, "SERVER_ERROR"],
    [400, "INVALID_REQUEST"],
    [418, "INVALID_REQUEST"],
    [302, "UNKNOWN_ERROR"],
  ];

  it.each(matrix)("maps HTTP %s to %s", (status, kind) => {
    expect(kindFromStatus(status)).toBe(kind);
  });

  it("marks only rate limits, server and network errors as retryable", () => {
    expect(isRetryable("RATE_LIMIT_ERROR")).toBe(true);
    expect(isRetryable("SERVER_ERROR")).toBe(true);
    expect(isRetryable("NETWORK_ERROR")).toBe(true);
    expect(isRetryable("AUTHENTICATION_ERROR")).toBe(false);
    expect(isRetryable("INVALID_REQUEST")).toBe(false);
  });

  it("adapters raise normalized ProviderErrors carrying kind/retryable details", async () => {
    mockFetch(() => ({ status: 429, body: { error: { message: "slow down" } } }));
    const provider = new OpenAICompatibleProvider(config);
    try {
      await provider.listModels();
      expect.unreachable("should have thrown");
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("PROVIDER_UNAVAILABLE");
      expect(providerError.details).toMatchObject({
        kind: "RATE_LIMIT_ERROR",
        provider: "gw",
        operation: "listModels",
        retryable: true,
      });
      expect(providerError.message).toBe("slow down");
    }
  });

  it("falls back to actionable text when the provider sends no message", async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    const provider = new OpenAICompatibleProvider(
      { ...config, apiKeyEnvVar: "GW_KEY" },
      undefined,
      { GW_KEY: "set" },
    );
    await expect(provider.listModels()).rejects.toThrow(/Authentication with provider "gw" failed/);
  });

  it("network failures normalize to NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const provider = new OpenAICompatibleProvider(config);
    try {
      await provider.listModels();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ProviderError).details).toMatchObject({ kind: "NETWORK_ERROR" });
    }
  });

  it("extracts messages and Retry-After values", () => {
    expect(extractMessage({ error: { message: "m" } })).toBe("m");
    expect(extractMessage({ detail: "d" })).toBe("d");
    expect(extractMessage(null)).toBeUndefined();
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("providerHttpError keeps stable codes alongside the normalized kind", () => {
    const error = providerHttpError({ provider: "gw", operation: "chat", status: 403, body: {} });
    expect(error.code).toBe("PROVIDER_AUTH_FAILED");
    expect(error.details).toMatchObject({ kind: "AUTHENTICATION_ERROR" });
  });
});