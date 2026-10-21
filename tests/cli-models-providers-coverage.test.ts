/**
 * v3 audit M8.5 — per-file coverage for the models and providers commands.
 *
 * `src/cli/commands/models.ts` and `src/cli/commands/providers.ts` had
 * uncovered branches and functions.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadProjectConfig } from "../src/cli/options.js";
import { addProvider, testProvider } from "../src/cli/commands/providers.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-models-providers-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capture(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

function writeConfig(body: string): void {
  writeFileSync(path.join(workDir, "omninode.yaml"), body, "utf8");
}

const PROVIDER_YAML = [
  "project:",
  "  name: Models",
  "  providers:",
  "    - name: gw",
  "      type: openai-compatible",
  "      base_url: https://gw.test/v1",
  "  agents: []",
  "  roles: []",
  "  pipelines: []",
  "",
].join("\n");

describe("models command", () => {
  it("rejects an unknown capability", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(
      createProgram().parseAsync(["node", "omninode", "models", "--capability", "telepathy"]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("reports that no providers are configured", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    await expect(createProgram().parseAsync(["node", "omninode", "models"])).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("emits an empty JSON array when no provider is configured and --json is set", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "models", "--json"]);
    expect(lines).toContain("[]");
  });

  it("reports an unknown provider by name", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(
      createProgram().parseAsync(["node", "omninode", "models", "ghost"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("reports a failed discovery without failing the whole command", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "models"]);
    expect(lines.join("\n")).toContain("discovery failed");
  });

  it("lists discovered models", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "models"]);
    const output = lines.join("\n");
    expect(output).toContain("gw: 2 model(s)");
    expect(output).toContain("gw:m-1");
    expect(output).toContain("gw:m-2");
  });

  it("filters by capability and can now find a model", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: "chatty", supported_parameters: ["tools"] }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "models", "--capability", "tools"]);
    expect(lines.join("\n")).toContain("gw:chatty");
  });

  it("emits the discovered models as JSON", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "m-json" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "models", "--json"]);
    const payload = JSON.parse(lines.find((l) => l.trim().startsWith("[")) ?? "[]") as {
      id: string;
    }[];
    expect(payload.some((m) => m.id === "m-json")).toBe(true);
  });
});

describe("provider command", () => {
  it("adds a provider to the configuration", async () => {
    writeConfig(PROVIDER_YAML);
    const lines = capture();
    await addProvider({
      name: "second",
      baseUrl: "https://second.test/v1",
      type: "openai-compatible",
    });
    expect(lines.join("\n")).toContain('Added provider "second"');
    const written = readFileSync(path.join(workDir, "omninode.yaml"), "utf8");
    expect(written).toContain("second");
    expect(loadProjectConfig().project.providers.map((p) => p.name)).toContain("second");
  });

  it("refuses a duplicate provider name", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(
      addProvider({ name: "gw", baseUrl: "https://gw.test/v1", type: "openai-compatible" }),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("refuses invalid provider options", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(
      addProvider({ name: "bad", baseUrl: "not-a-url", type: "openai-compatible" }),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("mentions the API key environment variable when one is given", async () => {
    writeConfig(PROVIDER_YAML);
    const lines = capture();
    await addProvider({
      name: "keyed",
      baseUrl: "https://keyed.test/v1",
      type: "openai-compatible",
      apiKeyEnvVar: "KEYED_KEY",
    });
    expect(lines.join("\n")).toContain("$KEYED_KEY");
  });

  it("lists the configured providers, marking a disabled one", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "    - name: off",
        "      type: openai-compatible",
        "      base_url: https://off.test/v1",
        "      enabled: false",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "list"]);
    const output = lines.join("\n");
    expect(output).toContain("gw  type=openai-compatible");
    expect(output).toContain("(disabled)");
  });

  it("removes a provider from the configuration", async () => {
    writeConfig(PROVIDER_YAML);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "remove", "gw"]);
    expect(lines.join("\n")).toContain('Removed provider "gw"');
    expect(loadProjectConfig().project.providers).toEqual([]);
  });

  it("refuses to remove a provider that does not exist", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(
      createProgram().parseAsync(["node", "omninode", "provider", "remove", "ghost"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("reports an unknown provider in the test command", async () => {
    writeConfig(PROVIDER_YAML);
    await expect(testProvider("ghost")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("reports a healthy provider", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "m-1" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const lines = capture();
    await testProvider("gw");
    const output = lines.join("\n");
    expect(output).toContain('Testing provider "gw"');
    expect(output).toContain("connected: true");
  });

  it("marks the exit code when the provider is unreachable", async () => {
    writeConfig(PROVIDER_YAML);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    capture();
    await testProvider("gw");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("emits the providers as JSON", async () => {
    writeConfig(PROVIDER_YAML);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "list", "--json"]);
    const payload = JSON.parse(lines.join("\n")) as { name: string }[];
    expect(payload.map((p) => p.name)).toEqual(["gw"]);
  });

  it("reports that no providers are configured", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "list"]);
    expect(lines.join("\n")).toContain("No providers configured");
  });

  it("adds a provider through the command, not just the helper", async () => {
    writeConfig(PROVIDER_YAML);
    capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "provider",
      "add",
      "--name",
      "viacli",
      "--base-url",
      "https://viacli.test/v1",
    ]);
    expect(loadProjectConfig().project.providers.map((p) => p.name)).toContain("viacli");
  });

  it("refuses to add a provider when there is no configuration file", async () => {
    await expect(
      addProvider({ name: "x", baseUrl: "https://x.test/v1", type: "openai-compatible" }),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });

  it("refuses to remove a provider when there is no configuration file", async () => {
    await expect(
      createProgram().parseAsync(["node", "omninode", "provider", "remove", "gw"]),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });

  it("runs the connect flow for an OmniHilbras provider", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers:",
        "    - name: oh",
        "      type: omnihilbras",
        "      base_url: https://oh.test/v1",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "m-1" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "test", "oh", "--connect"]);
    const output = lines.join("\n");
    expect(output).toContain("registered:");
    expect(output).toContain("connected: true");
  });

  it("reports a failed connect flow without throwing", async () => {
    writeConfig(
      [
        "project:",
        "  name: Models",
        "  providers:",
        "    - name: oh",
        "      type: omnihilbras",
        "      base_url: https://oh.test/v1",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "test", "oh", "--connect"]);
    expect(lines.join("\n")).toContain("connect failed");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
