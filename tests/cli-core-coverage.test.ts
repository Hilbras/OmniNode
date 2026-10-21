/**
 * Coverage for the CLI core (src/cli/index.ts, src/cli/options.ts).
 *
 * The program object wires every command group, translates the global
 * --config/--profile options into the shared config options, and turns
 * failures into documented exit codes. These tests drive the program the way
 * a user does (argv in, printed output, persisted files and exit codes out)
 * and assert on observable behaviour.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram, handleError, run } from "../src/cli/index.js";
import { activeConfigPath, cliConfigOptions, loadProjectConfig } from "../src/cli/options.js";
import { EXIT } from "../src/cli/exit-codes.js";
import { OmniNodeError } from "../src/errors/index.js";
import { logger } from "../src/logger/index.js";
import { OMNINODE_VERSION } from "../src/version.js";

let workDir: string;
let previousCwd: string;
const savedEnv: Record<string, string | undefined> = {};

/** Thrown by the mocked `process.exit` so a test can observe the exit code. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-clicore-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
  // Isolate the loader from the developer's own environment.
  for (const key of [
    "OMNINODE_USER_CONFIG",
    "OMNINODE_PROFILE",
    "OMNINODE_LOG_LEVEL",
    "OMNINODE_LOG_FORMAT",
    "OMNINODE_MEMORY_PROVIDER",
    "OMNINODE_MEMORY_REQUIRED",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OMNINODE_USER_CONFIG = path.join(workDir, "no-user-config.yaml");
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  cliConfigOptions.path = undefined;
  cliConfigOptions.profile = undefined;
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.doUnmock("../src/cli/commands/roles.js");
  vi.resetModules();
});

/** Absolute path of the CLI entry module, used to exercise the bin dispatch. */
const entryPath = realpathSync(fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)));

function captureLog(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function printed(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function captureErrors(): string[] {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return errors;
}

/**
 * Replaces `process.exit` with one that records the code and throws, the way
 * the real call behaves (it never returns).
 */
function captureExit(codes: number[]): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null): never => {
    codes.push(typeof code === "number" ? code : 0);
    throw new ExitSignal(typeof code === "number" ? code : 0);
  }) as (code?: number | string | null) => never);
}

/** Writes a minimal, valid omninode.yaml into the working directory. */
function writeConfig(name = "Demo"): string {
  const configPath = path.join(workDir, "omninode.yaml");
  writeFileSync(
    configPath,
    [
      "project:",
      `  name: ${name}`,
      "  providers: []",
      "  agents: []",
      "  roles: []",
      "  pipelines: []",
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createProgram — program wiring", () => {
  it("names the program, describes it and exposes the documented global options", () => {
    const program = createProgram();
    expect(program.name()).toBe("omninode");
    expect(program.description()).toContain("Provider-agnostic multi-AI orchestration platform");
    const flags = program.options.map((option) => option.flags);
    expect(flags).toContain("-v, --version");
    expect(flags).toContain("-c, --config <file>");
    expect(flags).toContain("-p, --profile <name>");
  });

  it("registers every command group", () => {
    const program = createProgram();
    const groups = program.commands.map((command) => command.name());
    expect(groups).toEqual([
      "init",
      "project",
      "provider",
      "agent",
      "role",
      "task",
      "report",
      "models",
      "model",
      "pipeline",
      "memory",
      "plan",
      "status",
      "audit",
      "migrate",
      "security",
      "config",
      "run",
    ]);
  });

  it("registers the subcommands of every command group", () => {
    const program = createProgram();
    const subcommands: Record<string, string[]> = {};
    for (const group of program.commands) {
      subcommands[group.name()] = group.commands.map((command) => command.name());
    }
    expect(subcommands).toEqual({
      init: [],
      project: ["init"],
      provider: ["list", "add", "test", "remove", "inspect"],
      agent: ["list", "add", "run", "test", "inspect"],
      role: ["list"],
      task: ["create", "run", "status", "list", "cancel", "recover", "retry", "inspect"],
      report: ["list", "combined", "show"],
      models: [],
      model: [],
      pipeline: ["list", "run", "retry", "cancel", "create", "validate", "runs", "status", "inspect"],
      memory: ["status", "query", "write"],
      plan: ["list", "show"],
      status: [],
      audit: [],
      migrate: [],
      security: [],
      config: ["path", "show", "profiles", "validate"],
      run: [],
    });
  });

  it("describes each command group so --help lists them", () => {
    const program = createProgram();
    for (const group of program.commands) {
      expect(group.description(), `missing description for ${group.name()}`).not.toBe("");
    }
  });
});

describe("createProgram — global options wiring", () => {
  it("passes --config to the configuration loader", async () => {
    const configPath = writeConfig("FromExplicitPath");
    cliConfigOptions.path = undefined;
    const program = createProgram();
    program.exitOverride();
    // The preAction hook copies --config into cliConfigOptions before the
    // command body runs, so the config command must see it.
    const log = captureLog();
    await program.parseAsync(["node", "omninode", "--config", configPath, "config", "path"]);
    expect(printed(log).trim()).toBe(configPath);
    expect(cliConfigOptions.path).toBe(configPath);
  });

  it("passes --profile to the configuration loader", async () => {
    const configPath = writeConfig("Profiled");
    const body = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      `${body}profiles:\n  testing:\n    project:\n      name: TestingProfile\n`,
      "utf8",
    );
    const program = createProgram();
    program.exitOverride();
    const log = captureLog();
    await program.parseAsync(["node", "omninode", "--profile", "testing", "config", "show"]);
    expect(printed(log)).toContain("TestingProfile");
    expect(cliConfigOptions.profile).toBe("testing");
  });

  it("leaves the shared config options untouched when no global option is given", async () => {
    writeConfig();
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(["node", "omninode", "config", "path"]);
    expect(cliConfigOptions.path).toBeUndefined();
    expect(cliConfigOptions.profile).toBeUndefined();
  });
});

describe("help and version paths", () => {
  it("prints the version and exits 0", async () => {
    const program = createProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({ writeOut: (text: string) => { out += text; } });
    const error = await program
      .parseAsync(["node", "omninode", "--version"])
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "commander.version", exitCode: 0 });
    expect(out.trim()).toBe(OMNINODE_VERSION);
  });

  it("prints the top-level help and exits 0", async () => {
    const program = createProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({ writeOut: (text: string) => { out += text; } });
    const error = await program
      .parseAsync(["node", "omninode", "--help"])
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(out).toContain("Usage: omninode [options] [command]");
    expect(out).toContain("--config <file>");
    expect(out).toContain("--profile <name>");
  });

  it("prints the help through the implicit help command", async () => {
    const program = createProgram();
    program.exitOverride();
    let out = "";
    program.configureOutput({ writeOut: (text: string) => { out += text; } });
    const error = await program
      .parseAsync(["node", "omninode", "help"])
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "commander.help", exitCode: 0 });
    expect(out).toContain("Usage: omninode [options] [command]");
  });
});

describe("run — command dispatch", () => {
  it("runs a command and prints its output", async () => {
    writeConfig("Runnable");
    const log = captureLog();
    await run(["node", "omninode", "config", "path"]);
    expect(printed(log)).toContain(path.join(workDir, "omninode.yaml"));
  });

  it("routes a failing command to the error handler and exits with the mapped code", async () => {
    writeConfig();
    const errors = captureErrors();
    const codes: number[] = [];
    captureExit(codes);

    await expect(
      run(["node", "omninode", "provider", "remove", "ghost"]),
    ).rejects.toThrow("exit:4");

    expect(errors[0]).toBe('error: [PROVIDER_NOT_FOUND] No provider "ghost" is configured.');
    expect(codes).toEqual([EXIT.provider]);
  });

  it("still runs when the configuration cannot be loaded", async () => {
    // No omninode.yaml in the working directory: applyLoggingConfig must not
    // prevent the program from running.
    const log = captureLog();
    await run(["node", "omninode", "config", "path"]);
    expect(printed(log).trim()).toBe("no omninode.yaml found");
  });
});

describe("handleError", () => {
  it("prints a typed error with its code and exits with the mapped code", () => {
    const errors = captureErrors();
    const codes: number[] = [];
    captureExit(codes);

    expect(() => handleError(new OmniNodeError("CLI_USAGE", "bad usage"))).toThrow("exit:2");

    expect(errors).toEqual(["error: [CLI_USAGE] bad usage"]);
    expect(codes).toEqual([EXIT.invalidInput]);
  });

  it("prints the error details as JSON when present", () => {
    const errors = captureErrors();
    const codes: number[] = [];
    captureExit(codes);

    expect(() =>
      handleError(
        new OmniNodeError("CONFIG_INVALID", "invalid config", {
          details: { issues: ["project.name: required"] },
        }),
      ),
    ).toThrow("exit:3");

    expect(errors[0]).toBe("error: [CONFIG_INVALID] invalid config");
    expect(errors[1]).toBe(JSON.stringify({ issues: ["project.name: required"] }, null, 2));
    expect(codes).toEqual([EXIT.config]);
  });

  it("prints only the message for a plain error and exits 1", () => {
    const errors = captureErrors();
    const codes: number[] = [];
    captureExit(codes);

    expect(() => handleError(new Error("plain boom"))).toThrow("exit:1");

    expect(errors).toEqual(["plain boom"]);
    expect(codes).toEqual([EXIT.general]);
  });

  it("stringifies a non-error value and exits 1", () => {
    const errors = captureErrors();
    const codes: number[] = [];
    captureExit(codes);

    expect(() => handleError("something went wrong")).toThrow("exit:1");

    expect(errors).toEqual(["something went wrong"]);
    expect(codes).toEqual([EXIT.general]);
  });

  it("maps a typed error to its documented exit code", () => {
    const codes: number[] = [];
    captureErrors();
    captureExit(codes);

    expect(() => handleError(new OmniNodeError("PROVIDER_NOT_FOUND", "no provider"))).toThrow(
      "exit:4",
    );

    expect(codes).toEqual([EXIT.provider]);
  });
});

describe("applyLoggingConfig", () => {
  it("applies the logging level from the project configuration", async () => {
    const configPath = path.join(workDir, "omninode.yaml");
    writeFileSync(
      configPath,
      [
        "project:",
        "  name: Logged",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "logging:",
        "  level: warn",
        "",
      ].join("\n"),
      "utf8",
    );

    const previousLevel = logger.level;
    try {
      await run(["node", "omninode", "config", "path"]);
      expect(logger.level).toBe("warn");
    } finally {
      logger.level = previousLevel;
    }
  });

  it("keeps the default logging level when the configuration cannot be loaded", async () => {
    const previousLevel = logger.level;
    try {
      // No omninode.yaml anywhere: the loader throws, the CLI must continue.
      await run(["node", "omninode", "config", "path"]);
      expect(logger.level).toBe(previousLevel);
    } finally {
      logger.level = previousLevel;
    }
  });
});

describe("cli/options — loadProjectConfig and activeConfigPath", () => {
  it("loads the project configuration from the working directory", () => {
    writeConfig("Loaded");
    const config = loadProjectConfig();
    expect(config.project.name).toBe("Loaded");
  });

  it("honours an explicit configuration path", () => {
    const configPath = path.join(workDir, "custom.yaml");
    writeFileSync(
      configPath,
      [
        "project:",
        "  name: Custom",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
      "utf8",
    );
    cliConfigOptions.path = configPath;
    expect(loadProjectConfig().project.name).toBe("Custom");
    expect(activeConfigPath()).toBe(configPath);
  });

  it("honours an explicit profile", () => {
    const configPath = path.join(workDir, "omninode.yaml");
    writeFileSync(
      configPath,
      [
        "project:",
        "  name: Base",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "profiles:",
        "  production:",
        "    project:",
        "      name: Production",
        "",
      ].join("\n"),
      "utf8",
    );
    cliConfigOptions.profile = "production";
    expect(loadProjectConfig().project.name).toBe("Production");
  });

  it("falls back to the discovered configuration file when no path is set", () => {
    const configPath = writeConfig("Discovered");
    cliConfigOptions.path = undefined;
    expect(activeConfigPath()).toBe(configPath);
  });

  it("reports no configuration path when nothing is discoverable", () => {
    cliConfigOptions.path = undefined;
    expect(activeConfigPath()).toBeUndefined();
  });
});

describe("CLI entry point dispatch", () => {
  it("runs the requested command when the module is the process entry point", async () => {
    vi.resetModules();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const originalArgv = process.argv;
    try {
      process.argv = ["node", entryPath, "config", "path"];
      await import("../src/cli/index.js");
      await waitFor(() => logs.length > 0, "the config path output");
    } finally {
      process.argv = originalArgv;
    }
    expect(logs.join("\n")).toContain("no omninode.yaml found");
  });

  it("does nothing when the module is imported as a library", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not be called");
    }) as never);
    const originalArgv = process.argv;
    try {
      process.argv = ["node"];
      await import("../src/cli/index.js");
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.argv = originalArgv;
    }
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("routes a failure during registration to the error handler", async () => {
    vi.resetModules();
    vi.doMock("../src/cli/commands/roles.js", () => ({
      registerRoleCommands: () => {
        throw new Error("registration exploded");
      },
    }));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const codes: number[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      codes.push(typeof code === "number" ? code : 0);
      return undefined as never;
    }) as (code?: number | string | null) => never);
    const originalArgv = process.argv;
    try {
      process.argv = ["node", entryPath];
      await import("../src/cli/index.js");
      await waitFor(() => errors.length > 0, "the error handler output");
    } finally {
      process.argv = originalArgv;
    }
    expect(errors.join("\n")).toContain("registration exploded");
    expect(codes).toEqual([EXIT.general]);
  });
});
