/**
 * v3 audit M8.5 — per-file coverage for the memory and security commands.
 *
 * `src/cli/commands/memory.ts` and `src/cli/commands/security.ts` had
 * uncovered branches and functions.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-memory-security-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

const EMPTY_PROJECT = [
  "project:",
  "  name: Mem",
  "  providers: []",
  "  agents: []",
  "  roles: []",
  "  pipelines: []",
  "",
].join("\n");

describe("memory command", () => {
  it("shows the default provider and no entries", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("provider: local (default");
    expect(output).toContain("entries:  0");
  });

  it("counts the entries per scope", async () => {
    writeConfig(EMPTY_PROJECT);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "a project note",
      "--scope",
      "project",
    ]);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "a task note",
      "--scope",
      "task",
    ]);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("entries:  2");
    expect(output).toContain("project: 1");
    expect(output).toContain("task: 1");
  });

  it("writes an entry with an explicit key and tags", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "the api gateway handles rate limiting",
      "--key",
      "note:api",
      "--tags",
      "api,gateway",
    ]);
    expect(lines.join("\n")).toContain('Stored memory entry "note:api" (project)');
  });

  it("finds a written entry with a query", async () => {
    writeConfig(EMPTY_PROJECT);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "the api gateway handles rate limiting",
      "--key",
      "note:api",
    ]);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "query", "gateway"]);
    const output = lines.join("\n");
    expect(output).toContain("[project] note:api");
    expect(output).toContain("the api gateway");
  });

  it("finds a written entry with a SHORT query", async () => {
    writeConfig(EMPTY_PROJECT);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "the api gateway handles rate limiting",
      "--key",
      "note:api",
    ]);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "query", "api"]);
    // The 4-character keyword rule used to make this return nothing.
    expect(lines.join("\n")).toContain("note:api");
  });

  it("reports that nothing matched", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "memory", "query", "zzz"]);
    expect(lines.join("\n")).toContain("No relevant memory found.");
  });

  it("emits the entries as JSON", async () => {
    writeConfig(EMPTY_PROJECT);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "the api gateway handles rate limiting",
      "--key",
      "note:api",
    ]);
    const lines = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "query",
      "gateway",
      "--json",
    ]);
    const payload = JSON.parse(lines.join("\n")) as { key: string }[];
    expect(payload.map((e) => e.key)).toContain("note:api");
  });

  it("restricts the query to a scope", async () => {
    writeConfig(EMPTY_PROJECT);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "a project note about the gateway",
      "--key",
      "note:project",
      "--scope",
      "project",
    ]);
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "write",
      "a task note about the gateway",
      "--key",
      "note:task",
      "--scope",
      "task",
    ]);
    const lines = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "query",
      "gateway",
      "--scope",
      "task",
    ]);
    const output = lines.join("\n");
    expect(output).toContain("note:task");
    expect(output).not.toContain("note:project");
  });
});

describe("security command", () => {
  it("reports a clean project without findings", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    const output = lines.join("\n");
    expect(output).toContain('OmniNode security audit — project "Mem"');
    expect(output).toContain("no findings.");
    expect(output).toContain("does not sandbox agents");
  });

  it("rejects an unknown action", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "scan"]);
    expect(lines.join("\n")).toContain('Unknown security action "scan"');
  });

  it("warns about an agent that inherits the full environment", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers: []",
        "  agents:",
        "    - name: leaky",
        "      command: leaky-cli",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    const output = lines.join("\n");
    expect(output).toContain("[WARN] agent \"leaky\"");
    expect(output).toContain("inherits the full environment");
  });

  it("notes an agent that may run outside the project root", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers: []",
        "  agents:",
        "    - name: outside",
        "      command: outside-cli",
        "      allow_external_cwd: true",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    expect(lines.join("\n")).toContain("may run outside the project root");
  });

  it("notes an agent that receives explicit environment variables", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers: []",
        "  agents:",
        "    - name: envful",
        "      command: envful-cli",
        "      env_policy: explicit",
        "      env:",
        "        A: '1'",
        "        B: '2'",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    expect(lines.join("\n")).toContain("receives 2 explicit environment variable(s)");
  });

  it("notes a provider without an api_key_env_var", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers:",
        "    - name: keyless",
        "      type: openai-compatible",
        "      base_url: https://keyless.test/v1",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    expect(lines.join("\n")).toContain("no api_key_env_var");
  });

  it("warns about Remembera without an api key", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers: []",
        "  agents: []",
        "  memory:",
        "    provider: remembera",
        "    base_url: https://remembera.test/v1",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    const output = lines.join("\n");
    expect(output).toContain("[WARN] memory");
    expect(output).toContain("Remembera is configured without api_key_env_var");
  });

  it("does not warn about Remembera with an api key", async () => {
    writeConfig(
      [
        "project:",
        "  name: Sec",
        "  providers: []",
        "  agents: []",
        "  memory:",
        "    provider: remembera",
        "    base_url: https://remembera.test/v1",
        "    api_key_env_var: REMEMBERA_KEY",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    expect(lines.join("\n")).not.toContain("[WARN] memory");
  });

  it("honours the --limit option", async () => {
    writeConfig(EMPTY_PROJECT);
    for (const key of ["note:one", "note:two", "note:three"]) {
      await createProgram().parseAsync([
        "node",
        "omninode",
        "memory",
        "write",
        "a gateway note about rate limiting",
        "--key",
        key,
      ]);
    }
    const lines = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "memory",
      "query",
      "gateway",
      "--limit",
      "1",
    ]);
    const keys = lines.filter((l) => l.startsWith("[project]"));
    expect(keys).toHaveLength(1);
  });
});
