/**
 * v3 audit M8.5 — per-file coverage for the agents, audit and roles commands.
 *
 * `src/cli/commands/agents.ts`, `src/cli/commands/audit.ts` and
 * `src/cli/commands/roles.ts` had uncovered branches and functions.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { loadProjectConfig } from "../src/cli/options.js";
import { addAgent, testAgent } from "../src/cli/commands/agents.js";
import { FileAuditLog } from "../src/audit/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-agents-audit-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
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
  "  name: Agents",
  "  providers: []",
  "  agents: []",
  "  roles: []",
  "  pipelines: []",
  "",
].join("\n");

describe("agent command", () => {
  it("reports that no agents are configured", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "list"]);
    expect(lines.join("\n")).toContain("No agents configured.");
  });

  it("lists the configured agents", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: worker-cli",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "list"]);
    expect(lines.join("\n")).toContain("worker  integration=process  command=worker-cli  input=stdin");
  });

  it("emits the agents as JSON", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: worker-cli",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "list", "--json"]);
    const payload = JSON.parse(lines.join("\n")) as { name: string }[];
    expect(payload.map((a) => a.name)).toEqual(["worker"]);
  });

  it("adds an agent to the configuration", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await addAgent({ name: "worker", command: "worker-cli", inputMode: "stdin" });
    expect(lines.join("\n")).toContain('Added agent "worker"');
    expect(loadProjectConfig().project.agents.map((a) => a.name)).toContain("worker");
  });

  it("adds an agent with every option", async () => {
    writeConfig(EMPTY_PROJECT);
    await addAgent({
      name: "full",
      command: "full-cli",
      arg: ["--flag", "value"],
      cwd: "/tmp",
      inputMode: "arg",
      timeoutMs: 1_000,
      envPolicy: "allowlist",
      allowEnv: ["HOME"],
      denyEnv: ["SECRET"],
      maxOutputBytes: 1_024,
      allowExternalCwd: true,
    });
    const written = loadProjectConfig().project.agents.find((a) => a.name === "full");
    expect(written?.inputMode).toBe("arg");
    expect(written?.timeoutMs).toBe(1_000);
    expect(written?.envPolicy).toBe("allowlist");
    expect(written?.maxOutputBytes).toBe(1_024);
    expect(written?.allowExternalCwd).toBe(true);
  });

  it("refuses invalid agent options", async () => {
    writeConfig(EMPTY_PROJECT);
    await expect(
      addAgent({ name: "bad", command: "bad-cli", inputMode: "nonsense" }),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("refuses a duplicate agent name", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: worker-cli",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    await expect(
      addAgent({ name: "worker", command: "worker-cli", inputMode: "stdin" }),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
  });

  it("reports an unknown agent in the run command", async () => {
    writeConfig(EMPTY_PROJECT);
    await expect(
      createProgram().parseAsync(["node", "omninode", "agent", "run", "ghost", "do it"]),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("runs a task through an agent and reports the outcome", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: node",
        "      args:",
        "        - '-e'",
        "        - 'process.stdout.write(\"OK\")'",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "run", "worker", "say ok"]);
    const output = lines.join("\n");
    expect(output).toContain("status:  completed");
    expect(output).toContain("summary: OK");
  });

  it("reports an unknown agent in the test command", async () => {
    writeConfig(EMPTY_PROJECT);
    await expect(testAgent("ghost")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("tests an agent connection and reports the raw output", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: node",
        "      args:",
        "        - '-e'",
        "        - 'process.stdout.write(\"OK\")'",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "test", "worker"]);
    const output = lines.join("\n");
    expect(output).toContain('Testing agent "worker"');
    expect(output).toContain("status: completed");
    expect(output).toContain("exit:   0");
  });
});

describe("audit command", () => {
  it("reports that no audit events were recorded yet", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "audit"]);
    expect(lines.join("\n")).toContain("No audit events recorded yet.");
  });

  it("lists the recorded audit events", async () => {
    writeConfig(EMPTY_PROJECT);
    await new FileAuditLog().record({
      at: "2024-01-01T00:00:00.000Z",
      action: "task.created",
      id: "task-1",
      taskId: "task-1",
      detail: { objective: "do it" },
    });
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "audit"]);
    const output = lines.join("\n");
    expect(output).toContain("task.created");
    expect(output).toContain("task-1");
    expect(output).toContain("do it");
  });

  it("honours the --limit option", async () => {
    writeConfig(EMPTY_PROJECT);
    const log = new FileAuditLog();
    for (const id of ["a", "b", "c"]) {
      await log.record({ at: "2024-01-01T00:00:00.000Z", action: "task.created", id, taskId: id });
    }
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "audit", "--limit", "1"]);
    const events = lines.filter((l) => l.includes("task.created"));
    expect(events).toHaveLength(1);
  });
});

describe("role command", () => {
  it("reports that no roles are configured", async () => {
    writeConfig(EMPTY_PROJECT);
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "role", "list"]);
    expect(lines.join("\n")).toContain("No roles configured.");
  });

  it("lists the configured roles with their responsibilities", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents: []",
        "  roles:",
        "    - id: reviewer",
        "      name: Reviewer",
        "      responsibilities:",
        "        - read the diff",
        "        - write the verdict",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "role", "list"]);
    const output = lines.join("\n");
    expect(output).toContain("reviewer  Reviewer");
    expect(output).toContain("- read the diff");
    expect(output).toContain("- write the verdict");
  });

  it("emits the roles as JSON", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents: []",
        "  roles:",
        "    - id: reviewer",
        "      name: Reviewer",
        "      responsibilities: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "role", "list", "--json"]);
    const payload = JSON.parse(lines.join("\n")) as { id: string }[];
    expect(payload.map((r) => r.id)).toEqual(["reviewer"]);
  });

  it("adds an agent through the command, exercising every option parser", async () => {
    writeConfig(EMPTY_PROJECT);
    capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "agent",
      "add",
      "--name",
      "viacli",
      "--command",
      "viacli-bin",
      "--arg",
      "--one",
      "--arg",
      "--two",
      "--cwd",
      "/tmp",
      "--input-mode",
      "arg",
      "--env-policy",
      "allowlist",
      "--allow-env",
      "HOME",
      "--deny-env",
      "SECRET",
      "--max-output-bytes",
      "2048",
      "--timeout-ms",
      "1500",
      "--allow-external-cwd",
    ]);
    const written = loadProjectConfig().project.agents.find((a) => a.name === "viacli");
    expect(written?.args).toEqual(["--one", "--two"]);
    expect(written?.envPolicy).toBe("allowlist");
    expect(written?.maxOutputBytes).toBe(2048);
    expect(written?.timeoutMs).toBe(1500);
  });

  it("reports the error of a failed agent run", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: broken",
        "      command: node",
        "      args:",
        "        - '-e'",
        "        - 'process.exit(3)'",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    const lines = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "run", "broken", "fail"]);
    expect(lines.join("\n")).toContain("error:");
  });

  it("lists the configured agents when one is unknown", async () => {
    writeConfig(
      [
        "project:",
        "  name: Agents",
        "  providers: []",
        "  agents:",
        "    - name: worker",
        "      command: worker-cli",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
    );
    await expect(testAgent("ghost")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("worker"),
    });
  });
});
