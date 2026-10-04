import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadConfig } from "../src/config/index.js";

let workDir: string;
let previousCwd: string;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "test-model-a" }, { id: "test-model-b" }] }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-prov-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function silenceLog(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof silenceLog>): string {
  return log.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("CLI provider commands", () => {
  it("provider add appends a provider while preserving comments", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "gw",
      "--type", "openai-compatible",
      "--base-url", "https://example.com/v1",
      "--api-key-env-var", "GW_KEY",
    ]);

    const raw = readFileSync(path.join(workDir, "omninode.yaml"), "utf8");
    expect(raw).toContain("# Roles describe what an AI is supposed to do");
    expect(raw).toContain("name: gw");
    expect(raw).toContain("api_key_env_var: GW_KEY");

    const config = loadConfig();
    expect(config.project.providers).toHaveLength(1);
    expect(config.project.providers[0]).toMatchObject({
      name: "gw",
      type: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKeyEnvVar: "GW_KEY",
    });
  });

  it("provider add creates the providers key when the template omits it", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(workDir, "omninode.yaml"), "project:\n  name: Bare\n");
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "solo",
      "--base-url", "http://localhost:9999/v1",
    ]);
    expect(loadConfig().project.providers[0]?.name).toBe("solo");
  });

  it("provider add rejects duplicates and invalid URLs", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "gw",
      "--base-url", "https://example.com/v1",
    ]);
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "provider", "add",
        "--name", "gw",
        "--base-url", "https://other.example.com/v1",
      ]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "provider", "add",
        "--name", "bad",
        "--base-url", "not-a-url",
      ]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("provider add rejects unknown provider types", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "provider", "add",
        "--name", "x",
        "--base-url", "https://example.com/v1",
        "--type", "warp-drive",
      ]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("provider test reports a healthy provider and discovered models", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "local",
      "--base-url", `http://127.0.0.1:${port}/v1`,
    ]);
    const log = silenceLog();
    await createProgram().parseAsync(["node", "omninode", "provider", "test", "local"]);
    const output = outputOf(log);
    expect(output).toContain("health:    healthy");
    expect(output).toContain("models:    2");
  });

  it("provider test fails clearly for unknown providers", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    silenceLog();
    await expect(
      createProgram().parseAsync(["node", "omninode", "provider", "test", "ghost"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("models discovers and lists models as provider:id keys", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "local",
      "--base-url", `http://127.0.0.1:${port}/v1`,
    ]);
    const log = silenceLog();
    await createProgram().parseAsync(["node", "omninode", "models"]);
    const output = outputOf(log);
    expect(output).toContain("local: 2 model(s)");
    expect(output).toContain("local:test-model-a");
    expect(output).toContain("local:test-model-b");
  });

  it("provider test --connect runs the OmniHilbras connect flow", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add",
      "--name", "hb",
      "--type", "omnihilbras",
      "--base-url", `http://127.0.0.1:${port}/v1`,
    ]);
    const log = silenceLog();
    await createProgram().parseAsync(["node", "omninode", "provider", "test", "hb", "--connect"]);
    const output = outputOf(log);
    expect(output).toContain("health:    healthy");
    expect(output).toContain("registered: 2");
    expect(output).toContain("validated 2 unique model(s)");
  });
});
