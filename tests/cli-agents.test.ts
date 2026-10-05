import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadConfig } from "../src/config/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-agentcli-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof capture>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("CLI agent commands", () => {
  it("agent add registers an agent while preserving comments", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add",
      "--name", "opencode",
      "--command", "opencode",
      "--arg=--flag",
      "--cwd", "/tmp",
      "--timeout-ms", "60000",
    ]);

    const raw = readFileSync(path.join(workDir, "omninode.yaml"), "utf8");
    expect(raw).toContain("# Roles describe what an AI is supposed to do");
    expect(raw).toContain("name: opencode");
    expect(raw).toContain("command: opencode");

    const config = loadConfig();
    expect(config.project.agents[0]).toMatchObject({
      name: "opencode",
      integration: "process",
      command: "opencode",
      args: ["--flag"],
      cwd: "/tmp",
      inputMode: "stdin",
      timeoutMs: 60000,
    });
  });

  it("agent add rejects duplicates and bad input modes", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "a1", "--command", "node",
    ]);
    await expect(
      createProgram().parseAsync(["node", "omninode", "agent", "add", "--name", "a1", "--command", "node"]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(
      createProgram().parseAsync([
        "node", "omninode", "agent", "add", "--name", "a2", "--command", "node", "--input-mode", "telepathy",
      ]),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("agent test sends a trivial task and reports success", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "ok",
      "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('OK')",
    ]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "test", "ok"]);
    const output = outputOf(log);
    expect(output).toContain("status: completed");
    expect(output).toContain("output: OK");
  });

  it("agent test fails clearly for unknown agents", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "agent", "test", "ghost"]),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
