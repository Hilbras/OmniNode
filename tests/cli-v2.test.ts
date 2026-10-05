/**
 * v2 Phase 15 tests — CLI v2 (roadmap §19): exit codes, the config group,
 * pipeline create, provider remove, agent run, and JSON output modes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { EXIT, exitCodeFor, exitCodeForStatus } from "../src/cli/exit-codes.js";
import { OmniNodeError } from "../src/errors/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-cliv2-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function output(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("exit codes (§19)", () => {
  it("maps error classes to documented codes", () => {
    expect(exitCodeFor(new OmniNodeError("CLI_USAGE", "x"))).toBe(EXIT.invalidInput);
    expect(exitCodeFor(new OmniNodeError("CONFIG_INVALID", "x"))).toBe(EXIT.config);
    expect(exitCodeFor(new OmniNodeError("PROVIDER_AUTH_FAILED", "x"))).toBe(EXIT.provider);
    expect(exitCodeFor(new OmniNodeError("AGENT_FAILED", "x"))).toBe(EXIT.agent);
    expect(exitCodeFor(new OmniNodeError("AGENT_TIMEOUT", "x"))).toBe(EXIT.timeout);
    expect(exitCodeFor(new OmniNodeError("TASK_NOT_FOUND", "x"))).toBe(EXIT.notFound);
    expect(exitCodeFor(new OmniNodeError("NOT_IMPLEMENTED", "x"))).toBe(EXIT.notImplemented);
    expect(exitCodeFor(new Error("plain"))).toBe(EXIT.general);
  });

  it("maps terminal task states to exit codes", () => {
    expect(exitCodeForStatus("completed")).toBe(EXIT.success);
    expect(exitCodeForStatus("failed")).toBe(EXIT.general);
    expect(exitCodeForStatus("cancelled")).toBe(EXIT.cancelled);
    expect(exitCodeForStatus("unknown")).toBe(EXIT.success); // not a CLI failure
  });
});

describe("config group (§19)", () => {
  it("shows the effective configuration without leaking secrets, as text and JSON", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    process.env.TEST_GW_KEY = "super-secret-value";
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add", "--name", "gw",
      "--base-url", "https://gw.test/v1", "--api-key-env-var", "TEST_GW_KEY",
    ]);
    delete process.env.TEST_GW_KEY;

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    const text = output(log);
    expect(text).toContain("providers: gw (openai-compatible, key=$TEST_GW_KEY)");
    expect(text).not.toContain("super-secret-value");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const json = JSON.parse(output(log));
    expect(json.providers[0].apiKeyEnvVar).toBe("TEST_GW_KEY");
    expect(output(log)).not.toContain("super-secret-value");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    expect(output(log)).toContain("is valid");
  });

  it("config path prints the resolved file", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "path"]);
    expect(output(log).trim()).toBe(path.join(workDir, "omninode.yaml"));
  });
});

describe("pipeline create (§19)", () => {
  it("creates a pipeline from a file and validates it before writing", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker", "--command", "node",
    ]);
    const definition = path.join(workDir, "pipeline.yaml");
    writeFileSync(
      definition,
      "objective: default objective\nsteps:\n  - id: do\n    kind: execute\n    agent: worker\n",
      "utf8",
    );

    const created = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "create", "flow", "--from", definition]);
    expect(output(created)).toContain('Created pipeline "flow"');

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "list"]);
    expect(output(log)).toContain("flow");
  });

  it("rejects an invalid pipeline definition without touching the config", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const definition = path.join(workDir, "bad.yaml");
    writeFileSync(definition, "steps:\n  - id: broken\n    kind: research\n", "utf8"); // research without agents
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "create", "bad", "--from", definition]),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID" });
    expect(readFileSync(path.join(workDir, "omninode.yaml"), "utf8")).not.toContain("bad");
  });
});

describe("provider remove (§19)", () => {
  it("removes a configured provider from omninode.yaml", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add", "--name", "gw", "--base-url", "https://gw.test/v1",
    ]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "provider", "remove", "gw"]);
    expect(output(log)).toContain('Removed provider "gw"');

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "provider", "list", "--json"]);
    expect(JSON.parse(output(log))).toEqual([]);
  });
});

describe("agent run (§19)", () => {
  it("runs a single task through an agent and reports the outcome", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker", "--command", "node",
      "--arg=-e", "--arg=process.stdout.write('ANALYSIS COMPLETE')",
    ]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "agent", "run", "worker", "investigate the build"]);
    const text = output(log);
    expect(text).toContain("status:  completed");
    expect(text).toContain("summary: ANALYSIS COMPLETE");
    expect(process.exitCode).toBe(EXIT.success);
  }, 20_000);
});

describe("JSON output modes (§19)", () => {
  it("list commands emit machine-readable JSON", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "worker", "--command", "node",
    ]);

    for (const [args, check] of [
      [["task", "list", "--json"], (v: unknown) => expect(Array.isArray(v)).toBe(true)],
      [["agent", "list", "--json"], (v: unknown) => expect((v as Array<{ name: string }>)[0]?.name).toBe("worker")],
      [["role", "list", "--json"], (v: unknown) => expect(v).toEqual([])],
      [["pipeline", "list", "--json"], (v: unknown) => expect(v).toEqual([])],
      [["plan", "list", "--json"], (v: unknown) => expect(v).toEqual([])],
      [["report", "list", "--json"], (v: unknown) => expect(v).toEqual([])],
      [["model", "--json"], (v: unknown) => expect(Array.isArray(v)).toBe(true)],
      [["memory", "query", "anything", "--json"], (v: unknown) => expect(v).toEqual([])],
    ] as const) {
      const log = capture();
      await createProgram().parseAsync(["node", "omninode", ...args]);
      check(JSON.parse(output(log)));
      log.mockRestore();
    }
  });

  it("models works under both the plural and singular command names", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    // Both names resolve to the same command: same error when nothing is configured...
    await expect(
      createProgram().parseAsync(["node", "omninode", "models"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await expect(
      createProgram().parseAsync(["node", "omninode", "model"]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });

    // ...and the same output once a provider exists.
    await createProgram().parseAsync([
      "node", "omninode", "provider", "add", "--name", "gw", "--base-url", "http://127.0.0.1:1/v1",
    ]);
    const plural = capture();
    await createProgram().parseAsync(["node", "omninode", "models"]);
    expect(output(plural)).toContain("gw: discovery failed");
    plural.mockRestore();
  }, 20_000);
});
