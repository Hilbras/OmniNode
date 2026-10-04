import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadConfig } from "../src/config/index.js";
import { OMNINODE_VERSION } from "../src/version.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-cli-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CLI", () => {
  it("reports its version", async () => {
    const program = createProgram();
    program.exitOverride();
    await expect(program.parseAsync(["node", "omninode", "--version"])).rejects.toMatchObject({
      message: expect.stringContaining(OMNINODE_VERSION),
    });
  });

  it("init creates an omninode.yaml that the config loader accepts", async () => {
    await createProgram().parseAsync(["node", "omninode", "init", "--name", "Demo"]);
    expect(existsSync(path.join(workDir, "omninode.yaml"))).toBe(true);
    const config = loadConfig();
    expect(config.project.name).toBe("Demo");
  });

  it("init refuses to overwrite without --force", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await expect(
      createProgram().parseAsync(["node", "omninode", "init"]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
    await createProgram().parseAsync(["node", "omninode", "init", "--force", "--name", "Again"]);
    expect(loadConfig().project.name).toBe("Again");
  });

  it("project init is an alias of init", async () => {
    await createProgram().parseAsync(["node", "omninode", "project", "init", "-n", "Aliased"]);
    expect(loadConfig().project.name).toBe("Aliased");
  });

  it("provider list prints a message when no providers are configured", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "provider", "list"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("No providers configured"));
  });

  it("provider list shows configured providers without exposing keys", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const configPath = path.join(workDir, "omninode.yaml");
    const config = readFileSync(configPath, "utf8").replace(
      "providers: []",
      `providers:
  - name: gw
    type: openai-compatible
    base_url: https://example.com/v1
    api_key_env_var: SECRET_KEY`,
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, config, "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "provider", "list"]);
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("gw");
    expect(output).toContain("$SECRET_KEY");
    expect(output).not.toContain("sk-");
  });

  it("phase-dependent commands explain when they will arrive", async () => {
    await expect(
      createProgram().parseAsync(["node", "omninode", "task", "run", "do something"]),
    ).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: expect.stringContaining("Phase 5"),
    });
  });
});
