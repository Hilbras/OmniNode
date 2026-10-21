/**
 * v3 audit M6 — config, provider and report correctness (v2.0.4 items).
 *
 * Six defects:
 *   1. an empty or comment-only config file crashed with an opaque
 *      `TypeError` instead of a clean `CONFIG_INVALID`;
 *   2. `provider.enabled` was parsed and displayed but never honoured, so a
 *      disabled provider was still created and used;
 *   3. the agent half of the v1→v2 config migration never ran, so v1
 *      configs with `agents:` were silently not migrated;
 *   4. `connectAndRegister` read `process.env` instead of the provider's
 *      injected environment;
 *   5. every `listModels()` performed two `/models` requests;
 *   6. a mid-stream SSE failure escaped as a raw, un-normalized error, and
 *      the `Retry-After` header was never read.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigDetailed } from "../src/config/loader.js";
import { applyConfigMigration, findConfigV1Patterns } from "../src/config/migrate-config.js";
import { createProvider } from "../src/providers/factory.js";
import { OmniHilbrasProvider } from "../src/providers/omnihilbras/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import { ProviderError } from "../src/errors/index.js";
import type { ProviderConfig } from "../src/types/provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-config-"));
}

const gw: ProviderConfig = {
  name: "gw",
  type: "openai-compatible",
  baseUrl: "https://gw.test/v1",
};

describe("M6.1 — an empty config file is a clear error", () => {
  it("reports CONFIG_INVALID for an empty file", () => {
    const dir = tmp();
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, "", "utf8");

    expect(() => loadConfigDetailed({ path: file })).toThrow(/CONFIG_INVALID|empty/i);
    try {
      loadConfigDetailed({ path: file });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("CONFIG_INVALID");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).not.toBe("TypeError");
    }
  });

  it("reports CONFIG_INVALID for a comment-only file", () => {
    const dir = tmp();
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, "# just a comment\n", "utf8");

    expect(() => loadConfigDetailed({ path: file })).toThrow(/empty|mapping/i);
  });

  it("reports CONFIG_INVALID for a file that is not a mapping", () => {
    const dir = tmp();
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, "- one\n- two\n", "utf8");

    expect(() => loadConfigDetailed({ path: file })).toThrow(/mapping/i);
  });
});

describe("M6.2 — a disabled provider is never used", () => {
  it("refuses to create a provider that is switched off", () => {
    expect(() => createProvider({ ...gw, enabled: false })).toThrow(/disabled/i);
  });

  it("still creates an enabled provider", () => {
    expect(createProvider(gw)).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider({ ...gw, enabled: true })).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

describe("M6.3 — the agent half of the config migration runs", () => {
  const v1Config = [
    "project:",
    "  name: legacy",
    "  agents:",
    "    - name: worker",
    "      command: worker-cli",
    "      inherit_env: false",
    "",
  ].join("\n");

  it("detects the v1 agent patterns", () => {
    const dir = tmp();
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, v1Config, "utf8");

    const findings = findConfigV1Patterns(file);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path.includes("inherit_env"))).toBe(true);
    expect(findings.some((f) => f.path.includes("input_mode"))).toBe(true);
  });

  it("rewrites the agent section", () => {
    const dir = tmp();
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, v1Config, "utf8");

    const result = applyConfigMigration(file);
    expect(result.applied).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);

    const rewritten = readFileSync(file, "utf8");
    expect(rewritten).toContain("env_policy");
    expect(rewritten).toContain("explicit");
    expect(rewritten).toContain("input_mode");
    expect(rewritten).not.toContain("inherit_env");
  });
});

describe("M6.4 — the provider uses its injected environment", () => {
  it("reads the API key from the injected env, not process.env", async () => {
    const provider = new OmniHilbrasProvider(
      { name: "oh", type: "omnihilbras", baseUrl: "https://oh.test/v1", apiKeyEnvVar: "OH_KEY" },
      undefined,
      { OH_KEY: "injected-secret" },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    // The injected env carries the key, so the connect flow must not throw
    // PROVIDER_AUTH_FAILED.
    const result = await provider.connectAndRegister();
    expect(result.status.connected).toBe(true);
  });

  it("fails when the injected env does not carry the key", async () => {
    const provider = new OmniHilbrasProvider(
      { name: "oh", type: "omnihilbras", baseUrl: "https://oh.test/v1", apiKeyEnvVar: "OH_MISSING" },
      undefined,
      {},
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    await expect(provider.connectAndRegister()).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED",
    });
  });
});

describe("M6.5 — listModels performs exactly one request", () => {
  it("issues a single /models request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OmniHilbrasProvider({
      name: "oh",
      type: "omnihilbras",
      baseUrl: "https://oh.test/v1",
    });
    const models = await provider.listModels();

    expect(models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0])).toContain("/models");
  });
});

describe("M6.6 — a broken stream and a Retry-After header are handled", () => {
  it("normalizes a mid-stream failure into a ProviderError", async () => {
    const provider = new OpenAICompatibleProvider(gw);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        // The stream breaks before the completion event.
        controller.error(new Error("connection reset"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const error = await provider
      .stream({ model: "m", messages: [{ role: "user", content: "hi" }] }, () => {})
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("carries the Retry-After header into the error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "30" },
          }),
      ),
    );

    const provider = new OpenAICompatibleProvider(gw);
    const error = await provider
      .chat({ model: "m", messages: [{ role: "user", content: "hi" }] })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).details?.retryAfterMs).toBe(30_000);
  });
});
