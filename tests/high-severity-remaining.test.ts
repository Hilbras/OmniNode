/**
 * v3 audit — three remaining high-severity findings.
 *
 *   H7  — the memory provider's 4-character keyword rule silently disabled
 *         text search for short queries, so `retrieve({text:"api"})`
 *         returned nothing and a tag+text query lost its tag match.
 *   H19 — `ModelInfo.capabilities` was never populated, so
 *         `omninode models --capability <c>` could never return a model.
 *   H20 — `PLANNER_FAILED` was never thrown: a planner transport failure
 *         was mis-coded as `PLAN_INVALID`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryProvider } from "../src/memory/local.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible/index.js";
import { ModelPlanner } from "../src/planner/model.js";
import { exitCodeFor, EXIT } from "../src/cli/exit-codes.js";
import { PlannerError } from "../src/errors/index.js";
import type { MemoryEntry } from "../src/types/memory.js";
import type { PlanRequest } from "../src/planner/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-high-"));
}

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  key: "note:api",
  content: "The api gateway handles rate limiting and auth",
  scope: "project",
  category: "problems",
  tags: ["api", "gateway"],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

describe("H7 — a short query still finds memory", () => {
  it("matches a short text query", async () => {
    const provider = new LocalMemoryProvider(tmp());
    await provider.store(entry());

    const results = await provider.retrieve({ text: "api" });
    expect(results.map((r) => r.key)).toContain("note:api");
  });

  it("keeps a tag match when a short text query is combined with it", async () => {
    const provider = new LocalMemoryProvider(tmp());
    await provider.store(entry());

    // The tag alone matched; the short text query used to wipe the result.
    const results = await provider.retrieve({ tags: ["api"], text: "api" });
    expect(results.map((r) => r.key)).toContain("note:api");
  });

  it("still returns nothing for a query that matches nothing", async () => {
    const provider = new LocalMemoryProvider(tmp());
    await provider.store(entry());

    expect(await provider.retrieve({ text: "zzz" })).toEqual([]);
  });

  it("still finds a long query by keyword overlap", async () => {
    const provider = new LocalMemoryProvider(tmp());
    await provider.store(entry());

    const results = await provider.retrieve({ text: "rate limiting" });
    expect(results.map((r) => r.key)).toContain("note:api");
  });
});

describe("H19 — models carry the capabilities the filter uses", () => {
  const gw = { name: "gw", type: "openai-compatible" as const, baseUrl: "https://gw.test/v1" };

  it("derives chat, tools and vision from the advertised parameters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "chat-model",
                  supported_parameters: ["tools", "stream"],
                  input_modalities: ["text", "image"],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const provider = new OpenAICompatibleProvider(gw);
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities?.chat).toBe(true);
    expect(models[0]?.capabilities?.tools).toBe(true);
    expect(models[0]?.capabilities?.vision).toBe(true);
  });

  it("marks an embedding-only model as such", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "embed-model", output_modalities: ["embedding"] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const provider = new OpenAICompatibleProvider(gw);
    const models = await provider.listModels();

    expect(models[0]?.capabilities?.embeddings).toBe(true);
    expect(models[0]?.capabilities?.chat).toBeUndefined();
  });

  it("the capability filter can now find a model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "chat-model", supported_parameters: ["tools"] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const provider = new OpenAICompatibleProvider(gw);
    const models = await provider.listModels();
    const withTools = models.filter((m) => m.capabilities?.tools === true);

    expect(withTools).toHaveLength(1);
    expect(withTools[0]?.id).toBe("chat-model");
  });
});

describe("H20 — a planner transport failure is a planner failure", () => {
  const request: PlanRequest = {
    objective: "plan the work",
    reports: [],
  };

  it("throws PLANNER_FAILED when the model call fails and there is no fallback", async () => {
    const planner = new ModelPlanner({
      model: "gw:model",
      chat: async () => {
        throw new Error("connection reset");
      },
    });

    const error = await planner.plan(request).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(PlannerError);
    expect((error as PlannerError).code).toBe("PLANNER_FAILED");
  });

  it("still falls back to the heuristic planner when one is configured", async () => {
    const planner = new ModelPlanner({
      model: "gw:model",
      chat: async () => {
        throw new Error("connection reset");
      },
      fallback: {
        name: "heuristic",
        async plan() {
          return {
            id: "plan-fallback",
            objective: "plan the work",
            summary: "heuristic",
            steps: [],
            generatedBy: "heuristic",
            createdAt: "2024-01-01T00:00:00.000Z",
          };
        },
      },
    });

    const plan = await planner.plan(request);
    expect(plan.generatedBy).toBe("heuristic");
  });

  it("maps PLANNER_FAILED to a non-zero exit code", () => {
    expect(exitCodeFor(new PlannerError("PLANNER_FAILED", "x"))).not.toBe(EXIT.success);
  });
});
