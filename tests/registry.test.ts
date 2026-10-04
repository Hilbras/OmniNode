import { describe, expect, it } from "vitest";
import { ModelRegistry, registryKey } from "../src/registry/index.js";
import type { ModelInfo } from "../src/types/model.js";
import type { IProvider } from "../src/types/provider.js";

function model(provider: string, id: string, capabilities?: ModelInfo["capabilities"]): ModelInfo {
  return { provider, id, capabilities, status: "available" };
}

const failingProvider: IProvider = {
  config: { name: "bad", type: "custom", baseUrl: "http://localhost:1" },
  providerId: "bad",
  authentication: { method: "none", configured: true },
  connect: async () => {
    throw new Error("connection refused");
  },
  getModel: async () => undefined,
  listModels: async () => {
    throw new Error("connection refused");
  },
  healthCheck: async () => ({
    name: "bad",
    type: "custom",
    baseUrl: "http://localhost:1",
    health: "unreachable",
    connected: false,
    modelCount: 0,
  }),
};

function providerNamed(name: string, models: ModelInfo[]): IProvider {
  return {
    config: { name, type: "openai-compatible", baseUrl: "http://localhost:0" },
    providerId: name,
    authentication: { method: "none", configured: true },
    connect: async () => models,
    getModel: async (id: string) => models.find((m) => m.id === id),
    listModels: async () => models,
    healthCheck: async () => ({
      name,
      type: "openai-compatible",
      baseUrl: "http://localhost:0",
      health: "healthy",
      connected: true,
      modelCount: models.length,
    }),
  };
}

describe("ModelRegistry", () => {
  it("registers, gets and lists models under provider:id keys", () => {
    const registry = new ModelRegistry();
    registry.register(model("gw", "a"));
    registry.register(model("gw", "b"));
    registry.register(model("other", "a"));

    expect(registry.get("gw", "a")).toMatchObject({ provider: "gw", id: "a" });
    expect(registry.get("gw", "zzz")).toBeUndefined();
    expect(registry.list()).toHaveLength(3);
    expect(registry.list({ provider: "gw" }).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sorts listings deterministically", () => {
    const registry = new ModelRegistry();
    registry.register(model("b", "1"));
    registry.register(model("a", "2"));
    registry.register(model("a", "1"));
    expect(registry.list().map((m) => registryKey(m.provider, m.id))).toEqual([
      "a:1",
      "a:2",
      "b:1",
    ]);
  });

  it("filters by capability", () => {
    const registry = new ModelRegistry();
    registry.register(model("gw", "coder", { chat: true, coding: true }));
    registry.register(model("gw", "chat-only", { chat: true }));
    const coding = registry.list({ capability: "coding" });
    expect(coding).toHaveLength(1);
    expect(coding[0]?.id).toBe("coder");
  });

  it("validates availability, honouring model status", () => {
    const registry = new ModelRegistry();
    registry.register(model("gw", "live"));
    registry.register({ provider: "gw", id: "retired", status: "deprecated" });
    expect(registry.isAvailable("gw", "live")).toBe(true);
    expect(registry.isAvailable("gw", "retired")).toBe(false);
    expect(registry.isAvailable("gw", "ghost")).toBe(false);
  });

  it("discovers from a provider and registers the results", async () => {
    const registry = new ModelRegistry();
    const found = await registry.discoverFrom(providerNamed("gw", [model("gw", "x")]));
    expect(found).toHaveLength(1);
    expect(registry.isAvailable("gw", "x")).toBe(true);
  });

  it("discoverAll isolates provider failures", async () => {
    const registry = new ModelRegistry();
    const results = await registry.discoverAll([
      providerNamed("good", [model("good", "m1")]),
      failingProvider,
    ]);
    expect(results).toHaveLength(2);
    const good = results.find((r) => r.provider === "good");
    const bad = results.find((r) => r.provider === "bad");
    expect(good?.models).toHaveLength(1);
    expect(good?.error).toBeUndefined();
    expect(bad?.models).toHaveLength(0);
    expect(bad?.error).toBeInstanceOf(Error);
  });
});
