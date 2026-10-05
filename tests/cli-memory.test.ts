import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-memcli-"));
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

describe("CLI memory commands", () => {
  it("status reports the local default provider", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "status"]);
    const output = outputOf(log);
    expect(output).toContain("provider: local");
    expect(output).toContain("entries:  0");
  });

  it("write and query roundtrip entries", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    capture();
    await createProgram().parseAsync([
      "node", "omninode", "memory", "write",
      "The authentication module uses JWT tokens with a rotating secret",
      "--scope", "knowledge",
      "--tags", "auth,architecture",
      "--key", "auth-design",
    ]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "query", "authentication jwt"]);
    const output = outputOf(log);
    expect(output).toContain("[knowledge] auth-design");
    expect(output).toContain("JWT tokens");
  });

  it("task runs write outcomes into memory that queries can find", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    // Opt into memory (local provider) via the config section.
    const configPath = path.join(workDir, "omninode.yaml");
    const raw = readFileSync(configPath, "utf8");
    writeFileSync(configPath, raw.replace("roles: []", "roles: []\n\n  memory:\n    provider: local"), "utf8");
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker",
      "--command", "node", "--arg=-e", "--arg=process.stdout.write('ANALYSIS COMPLETE')",
    ]);
    await createProgram().parseAsync([
      "node", "omninode", "task", "create", "investigate the caching layer performance", "--agent", "worker",
    ]);
    capture();
    const parsed = JSON.parse(readFileSync(path.join(workDir, ".omninode/tasks.json"), "utf8")) as
      | Array<{ id: string }>
      | { items: Array<{ id: string }> };
    const tasks = Array.isArray(parsed) ? parsed : parsed.items;
    await createProgram().parseAsync(["node", "omninode", "task", "run", tasks[0]!.id]);

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "query", "caching layer performance"]);
    const output = outputOf(log);
    expect(output).toContain("[task]");
    expect(output).toContain(tasks[0]!.id);
    expect(output).toContain("ANALYSIS COMPLETE");
  });

  it("memory: section in config selects the provider (local via explicit config)", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const configPath = path.join(workDir, "omninode.yaml");
    const raw = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      raw.replace("roles: []", "roles: []\n\n  memory:\n    provider: local"),
      "utf8",
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "status"]);
    const output = outputOf(log);
    expect(output).toContain("provider: local");
  });

  it("rejects unknown memory providers at load time", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const configPath = path.join(workDir, "omninode.yaml");
    const raw = readFileSync(configPath, "utf8");
    writeFileSync(configPath, raw.replace("roles: []", "roles: []\n\n  memory:\n    provider: elephant"), "utf8");
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "memory", "status"]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("elephant") });
  });
});
