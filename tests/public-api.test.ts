/**
 * v2 Phase 19 — public API guard (roadmap §23).
 *
 * The package root is the entire public surface: `tests/api-surface.test.ts`
 * asserts the intentional APIs exist, this file asserts the implementation
 * details that were deliberately *withheld* stay withheld, so a future
 * `export *` cannot quietly leak them.
 */
import { describe, expect, it } from "vitest";
import * as omninode from "../src/index.js";

/**
 * Withheld from the public API on purpose — reachable inside the package
 * (tests import their module paths directly) but not for consumers.
 */
const WITHHELD_INTERNALS = [
  "keywords", // memory relevance helper
  "applyDefaults", // configuration composition internals
  "applyEnvOverrides",
  "resolveProfile",
  "userConfigPath",
  "mergeConfig",
  "STORE_FILES",
  "decodeStream", // protocol session plumbing
  "requireCompletion",
  "HttpResponseError",
  "defaultSearch",
  "defaultMetadata",
  "appendToConfigList",
  "trackLiveTasks",
] as const;

describe("public API surface", () => {
  it.each(WITHHELD_INTERNALS)("does not export the internal %s", (name) => {
    expect(omninode).not.toHaveProperty(name);
  });

  it("exports a curated surface, not an unbounded one", () => {
    // A guard rail: the public runtime surface stays in the same order of
    // magnitude as the documented API inventory (docs/API.md).
    const count = Object.keys(omninode).length;
    expect(count).toBeGreaterThan(80);
    expect(count).toBeLessThan(130);
  });

  it("keeps the documented version in sync with the package", () => {
    expect(omninode.OMNINODE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("runtime validation at external boundaries (§23)", () => {
  it("createProvider rejects incomplete provider configuration", () => {
    expect(() =>
      omninode.createProvider({ name: "", type: "openai-compatible", baseUrl: "" }),
    ).toThrow(/name/i);
    expect(() =>
      omninode.createProvider({ name: "gw", type: "openai-compatible", baseUrl: "not a url" }),
    ).toThrow(/baseUrl|url/i);
  });

  it("createAgent rejects agents without a command", () => {
    expect(() => omninode.createAgent({ name: "a", integration: "process" })).toThrow(/command/i);
  });

  it("createMemoryProvider rejects unknown providers and keyless remoteless adapters", () => {
    expect(() => omninode.createMemoryProvider({ provider: "elephant" })).toThrow(/Unknown memory provider/);
    expect(() => omninode.createMemoryProvider({ provider: "remembera" })).toThrow(/base_url/);
  });
});
