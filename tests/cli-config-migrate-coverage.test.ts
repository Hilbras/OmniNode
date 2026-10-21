/**
 * Coverage for the `config`, `migrate` and `shared` CLI command modules
 * (src/cli/commands/config.ts, migrate.ts, shared.ts).
 *
 * The three modules sit on the CLI's error and empty-state paths, which the
 * happy-path suites never reach: a missing configuration file, an inline
 * secret, a v1 storage document, a corrupt store, a configuration edit that
 * would not validate. Each case below asserts the observable outcome — the
 * printed line, the persisted record, or the thrown error.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { cliConfigOptions } from "../src/cli/options.js";
import { appendToConfigList, notImplemented, truncate } from "../src/cli/commands/shared.js";
import { ConfigError, OmniNodeError } from "../src/errors/index.js";
import { SCHEMA_VERSION } from "../src/persistence/index.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-cfg-migrate-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
  delete cliConfigOptions.path;
  delete cliConfigOptions.profile;
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  delete cliConfigOptions.path;
  delete cliConfigOptions.profile;
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function output(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function write(file: string, contents: string): string {
  const target = path.join(workDir, file);
  writeFileSync(target, contents, "utf8");
  return target;
}

/** A minimal configuration that loads cleanly. */
const MINIMAL_CONFIG = [
  "project:",
  "  name: Demo",
  "  providers: []",
  "  agents: []",
  "  roles: []",
  "  pipelines: []",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// src/cli/commands/shared.ts
// ---------------------------------------------------------------------------

describe("shared: notImplemented", () => {
  it("builds a NOT_IMPLEMENTED error naming the command and the phase", () => {
    const error = notImplemented("omninode cluster", "Phase 12");
    expect(error).toBeInstanceOf(OmniNodeError);
    expect(error.code).toBe("NOT_IMPLEMENTED");
    expect(error.message).toBe(
      "omninode cluster is planned for Phase 12. Edit omninode.yaml directly for now.",
    );
  });

  it("names the command and the phase it is waiting for", () => {
    const error = notImplemented("omninode deploy", "Phase 20");
    expect(error.message).toContain("omninode deploy");
    expect(error.message).toContain("Phase 20");
  });
});

describe("shared: truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("returns text of exactly the limit unchanged", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });

  it("cuts longer text to the limit and marks the cut with an ellipsis", () => {
    const result = truncate("1234567890", 5);
    expect(result.startsWith("1234")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toBe("1234…");
  });

  it("keeps the result within the requested budget", () => {
    const result = truncate("a".repeat(500), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("shared: appendToConfigList", () => {
  it("refuses to edit when there is no configuration file", () => {
    expect(() => appendToConfigList("providers", { name: "gw" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_NOT_FOUND" }),
    );
    expect(() => appendToConfigList("providers", { name: "gw" })).toThrow(
      /No omninode\.yaml found/,
    );
  });

  it("creates the list when the configuration has none", () => {
    const configPath = write("omninode.yaml", "project:\n  name: Demo\n");
    const returned = appendToConfigList("providers", {
      name: "gw",
      type: "openai-compatible",
      base_url: "https://gw.test/v1",
    });
    expect(returned).toBe(configPath);
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("gw");
    expect(written).toContain("https://gw.test/v1");
  });

  it("appends to an existing list and preserves the surrounding comments", () => {
    const configPath = write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  # providers are configured here",
        "  providers:",
        "    - name: first",
        "      type: openai-compatible",
        "      base_url: https://first.test/v1",
        "",
      ].join("\n"),
    );
    appendToConfigList("providers", {
      name: "second",
      type: "openai-compatible",
      base_url: "https://second.test/v1",
    });
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain("# providers are configured here");
    expect(written).toContain("first");
    expect(written).toContain("second");
    // The original entry is still first.
    expect(written.indexOf("first")).toBeLessThan(written.indexOf("second"));
  });

  it("refuses an edit that would produce an invalid configuration", () => {
    const configPath = write("omninode.yaml", MINIMAL_CONFIG);
    const before = readFileSync(configPath, "utf8");
    // `base_url` must be a URL: this item is invalid, so the file must not change.
    expect(() =>
      appendToConfigList("providers", {
        name: "broken",
        type: "openai-compatible",
        base_url: "not-a-url",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("reports the offending field when the edit would be invalid", () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    let caught: unknown;
    try {
      appendToConfigList("providers", {
        name: "broken",
        type: "openai-compatible",
        base_url: "not-a-url",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("base_url");
    expect((caught as Error).message).toContain("would produce an invalid configuration");
  });

  it("names the root of the document when the whole configuration is wrong", () => {
    const configPath = write(
      "omninode.yaml",
      `${MINIMAL_CONFIG}unknown_top_level_key: true\n`,
    );
    const before = readFileSync(configPath, "utf8");
    let caught: unknown;
    try {
      appendToConfigList("providers", {
        name: "gw",
        type: "openai-compatible",
        base_url: "https://gw.test/v1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    // The offending key sits at the document root, so it is reported as such.
    expect((caught as Error).message).toContain("(root)");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("reports a provider entry with an unknown key at the provider's own path", () => {
    const configPath = write("omninode.yaml", MINIMAL_CONFIG);
    const before = readFileSync(configPath, "utf8");
    let caught: unknown;
    try {
      appendToConfigList("providers", {
        name: "x",
        type: "custom",
        base_url: "https://a.test/v1",
        extra: true,
      } as unknown);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("project.providers.0");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// src/cli/commands/config.ts
// ---------------------------------------------------------------------------

describe("config: path", () => {
  it("prints the configuration file in use", async () => {
    const configPath = write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "path"]);
    expect(output(log).trim()).toBe(configPath);
  });

  it("says so when there is no configuration file", async () => {
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "path"]);
    expect(output(log).trim()).toBe("no omninode.yaml found");
  });

  it("prints the file given by --config", async () => {
    const explicit = write("other.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "--config",
      explicit,
      "config",
      "path",
    ]);
    expect(output(log).trim()).toBe(explicit);
  });
});

describe("config: --profile", () => {
  it("applies the profile overlay named by --profile", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "profiles:",
        "  production:",
        "    project:",
        "      name: prod-name",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "--profile",
      "production",
      "config",
      "show",
    ]);
    expect(output(log)).toContain("project:   prod-name");
  });

  it("reports the selected profile when validating", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "profiles:",
        "  production:",
        "    project:",
        "      name: prod-name",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "--profile",
      "production",
      "config",
      "validate",
    ]);
    expect(output(log)).toContain("profile:  production");
  });
});

describe("config: show", () => {
  it("prints the project, providers, agents, roles and pipelines", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "      api_key_env_var: GW_KEY",
        "  agents:",
        "    - name: worker",
        "      type: cli",
        "      command: node",
        "  roles:",
        "    - id: reviewer",
        "      name: Reviewer",
        "  pipelines:",
        "    - id: flow",
        "      name: Flow",
        "      steps:",
        "        - id: s1",
        "          kind: collect",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    const text = output(log);
    expect(text).toContain("project:   Demo");
    expect(text).toContain("providers: gw (openai-compatible, key=$GW_KEY)");
    expect(text).toContain("agents:    worker");
    expect(text).toContain("roles:     reviewer");
    expect(text).toContain("pipelines: flow");
    expect(text).toContain("memory:    not configured");
  });

  it("prints 'none' for every empty section", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    const text = output(log);
    expect(text).toContain("providers: none");
    expect(text).toContain("agents:    none");
    expect(text).toContain("roles:     none");
    expect(text).toContain("pipelines: none");
  });

  it("shows a provider without a key reference as key=none", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    expect(output(log)).toContain("providers: gw (openai-compatible, key=none)");
  });

  it("shows a provider that has a key reference", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "      api_key_env_var: GW_KEY",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    expect(output(log)).toContain("providers: gw (openai-compatible, key=$GW_KEY)");
  });

  it("shows an agent without a command as null in JSON output", async () => {
    write(
      "omninode.yaml",
      ["project:", "  name: Demo", "  agents:", "    - name: native-agent", "      type: native", ""].join(
        "\n",
      ),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const payload = JSON.parse(output(log)) as {
      agents: Array<{ name: string; command: string | null; inputMode: string }>;
    };
    expect(payload.agents[0]).toMatchObject({ name: "native-agent", command: null });
  });

  it("shows a provider without a key reference as null in JSON output", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const payload = JSON.parse(output(log)) as {
      providers: Array<{ name: string; apiKeyEnvVar: string | null }>;
    };
    expect(payload.providers[0].apiKeyEnvVar).toBeNull();
  });

  it("reports the configured logging level in JSON output", async () => {
    write("omninode.yaml", `${MINIMAL_CONFIG}logging:\n  level: debug\n`);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const payload = JSON.parse(output(log)) as { logging: { level: string } };
    expect(payload.logging.level).toBe("debug");
  });

  it("falls back to the default logging level when the file sets none", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const payload = JSON.parse(output(log)) as { logging: { level: string } };
    expect(payload.logging.level).toBe("info");
  });

  it("reports no logging section as null in JSON output", async () => {
    // A configuration that resolves without any logging section at all: the
    // JSON payload must say so with null rather than omit the key.
    write("omninode.yaml", MINIMAL_CONFIG);
    vi.resetModules();
    vi.doMock("../src/config/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/config/index.js")>();
      return {
        ...actual,
        loadConfigDetailed: vi.fn(() => ({
          config: {
            project: {
              name: "NoLogging",
              providers: [],
              agents: [],
              roles: [],
              pipelines: [],
            },
          },
          sources: { profile: "default", envOverrides: [], defaults: [] },
        })),
      };
    });
    try {
      const { createProgram: createMockedProgram } = await import("../src/cli/index.js");
      const program = createMockedProgram();
      program.exitOverride();
      const log = capture();
      await program.parseAsync(["node", "omninode", "config", "show", "--json"]);
      const payload = JSON.parse(output(log)) as { project: string; logging: unknown };
      expect(payload.project).toBe("NoLogging");
      expect(payload.logging).toBeNull();
    } finally {
      vi.doUnmock("../src/config/index.js");
      vi.resetModules();
    }
  });

  it("prints the memory provider and whether it is required", async () => {
    write(
      "omninode.yaml",
      ["project:", "  name: Demo", "  memory:", "    provider: remembera", "    required: true", ""].join(
        "\n",
      ),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    expect(output(log)).toContain("memory:    remembera (required)");
  });

  it("prints the memory provider without the required marker when it is optional", async () => {
    write(
      "omninode.yaml",
      ["project:", "  name: Demo", "  memory:", "    provider: local", ""].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show"]);
    const text = output(log);
    expect(text).toContain("memory:    local");
    expect(text).not.toContain("(required)");
  });

  it("emits the whole configuration as JSON with --json", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "show", "--json"]);
    const payload = JSON.parse(output(log)) as {
      project: string;
      providers: unknown[];
      agents: unknown[];
      roles: unknown[];
      pipelines: unknown[];
      memory: unknown;
    };
    expect(payload.project).toBe("Demo");
    expect(payload.providers).toEqual([]);
    expect(payload.agents).toEqual([]);
    expect(payload.roles).toEqual([]);
    expect(payload.pipelines).toEqual([]);
    expect(payload.memory).toBeNull();
  });
});

describe("config: profiles", () => {
  it("lists the profiles defined in the project", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "profiles:",
        "  development:",
        "    project:",
        "      name: dev",
        "  production:",
        "    project:",
        "      name: prod",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "profiles"]);
    const text = output(log);
    expect(text).toContain("defined: development, production");
    expect(text).toContain("active:  default");
  });

  it("says so when no profiles are defined", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "profiles"]);
    expect(output(log)).toContain("none (add a `profiles:` section)");
  });

  it("lists the profiles of a configuration given by --config", async () => {
    const explicit = write(
      "other.yaml",
      [
        "project:",
        "  name: Demo",
        "profiles:",
        "  staging:",
        "    project:",
        "      name: stg",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync([
      "node",
      "omninode",
      "--config",
      explicit,
      "config",
      "profiles",
    ]);
    expect(output(log)).toContain("defined: staging");
  });

  it("refuses to list profiles when there is no configuration file", async () => {
    // Without a configuration there is nothing to read the `profiles:`
    // section from, and the profile overlay cannot be resolved either.
    await expect(
      createProgram().parseAsync(["node", "omninode", "config", "profiles"]),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });
});

describe("config: validate", () => {
  it("reports the configuration as valid", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    const text = output(log);
    expect(text).toContain("is valid");
    expect(text).toContain('project "Demo"');
    expect(text).toContain("0 provider(s)");
  });

  it("refuses to validate when there is no configuration file", async () => {
    await expect(
      createProgram().parseAsync(["node", "omninode", "config", "validate"]),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });

  it("rejects a configuration that contains an inline secret", async () => {
    const configPath = write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "      api_key: sk-super-secret-value",
        "",
      ].join("\n"),
    );
    let caught: unknown;
    try {
      await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OmniNodeError);
    expect((caught as OmniNodeError).code).toBe("CONFIG_INVALID");
    expect((caught as Error).message).toContain(configPath);
    expect((caught as Error).message).toContain("inline secret(s)");
    // The secret value itself is never echoed back.
    expect((caught as Error).message).not.toContain("sk-super-secret-value");
  });

  it("rejects a configuration with more than one inline secret and names every line", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "      api_key: sk-first-secret-value",
        "      token: another-secret-token",
        "",
      ].join("\n"),
    );
    await expect(
      createProgram().parseAsync(["node", "omninode", "config", "validate"]),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("2 inline secret(s)"),
    });
  });

  it("prints the user configuration file when one contributed", async () => {
    const userDir = path.join(workDir, "user");
    mkdirSync(userDir, { recursive: true });
    const userFile = path.join(userDir, "config.yaml");
    writeFileSync(
      userFile,
      [
        "project:",
        "  name: FromUser",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "",
      ].join("\n"),
      "utf8",
    );
    write("omninode.yaml", MINIMAL_CONFIG);
    process.env.OMNINODE_USER_CONFIG = userFile;
    try {
      const log = capture();
      await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
      expect(output(log)).toContain(`user cfg: ${userFile}`);
    } finally {
      delete process.env.OMNINODE_USER_CONFIG;
    }
  });

  it("prints the environment variables that overrode the configuration", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    process.env.OMNINODE_LOG_LEVEL = "debug";
    try {
      const log = capture();
      await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
      expect(output(log)).toContain("env overrides: OMNINODE_LOG_LEVEL");
    } finally {
      delete process.env.OMNINODE_LOG_LEVEL;
    }
  });

  it("prints the defaults that were applied to the configuration", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    const text = output(log);
    expect(text).toContain("defaults applied:");
    expect(text).toContain("logging.level");
  });

  it("prints no defaults line when the file already sets every default", async () => {
    // `logging.level` and `logging.format` are the only built-in defaults, so
    // a file that sets both leaves nothing to apply.
    write(
      "omninode.yaml",
      `${MINIMAL_CONFIG}logging:\n  level: info\n  format: text\n`,
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    const text = output(log);
    expect(text).toContain("is valid");
    expect(text).not.toContain("defaults applied:");
  });

  it("prints diagnostics for a provider that is missing its key reference", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  providers:",
        "    - name: gw",
        "      type: openai-compatible",
        "      base_url: https://gw.test/v1",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    const text = output(log);
    expect(text).toContain("diagnostics:");
    expect(text).toContain('Provider "gw"');
  });

  it("prints the active profile", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    expect(output(log)).toContain("profile:  default");
  });
});

// ---------------------------------------------------------------------------
// src/cli/commands/migrate.ts
// ---------------------------------------------------------------------------

function storeDir(): string {
  const dir = path.join(workDir, ".omninode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("migrate: storage", () => {
  it("reports every store file as missing when nothing was persisted yet", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("storage:");
    expect(text).toContain("tasks.json");
    expect(text).toContain("missing");
    expect(text).toContain("Everything is at the v2 shape");
  });

  it("migrates a v1 storage document in place and reports the item count", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t1" }]), "utf8");

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("v1-legacy");
    expect(text).toContain("migrated 1 → 1 item(s)");
    expect(text).toContain("1 item(s) migrated to the v2 shape");

    const doc = JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8")) as {
      schemaVersion: number;
      items: Array<{ id: string }>;
    };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.items).toEqual([{ id: "t1" }]);
  });

  it("only reports what would change with --check and leaves the file alone", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    const legacy = path.join(dir, "tasks.json");
    writeFileSync(legacy, JSON.stringify([{ id: "t1" }]), "utf8");

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate", "--check"]);
    const text = output(log);
    expect(text).toContain("would migrate");
    expect(text).toContain("(dry run)");
    expect(text).toContain("would be migrated");

    // The v1 document is untouched by a dry run.
    expect(Array.isArray(JSON.parse(readFileSync(legacy, "utf8")))).toBe(true);
  });

  it("reports a corrupt store file and does not rewrite it", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    const corrupt = path.join(dir, "memory.json");
    writeFileSync(corrupt, "not json at all", "utf8");

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("corrupt");
    expect(text).toContain("memory.json");
    // The damaged file is preserved for inspection.
    expect(readFileSync(corrupt, "utf8")).toBe("not json at all");
  });

  it("reports a store file written by a newer OmniNode and leaves it alone", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    const future = path.join(dir, "plans.json");
    writeFileSync(
      future,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION + 5, items: [] }),
      "utf8",
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("future");
    expect(text).toContain("written by a newer OmniNode");
    const doc = JSON.parse(readFileSync(future, "utf8")) as { schemaVersion: number };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION + 5);
  });

  it("reports a store file that is already at the current schema version", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    writeFileSync(
      path.join(dir, "reports.json"),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: [{ id: "r1" }] }),
      "utf8",
    );

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("current");
    expect(text).toContain("1 item(s)");
  });

  it("migrates an empty store file to an empty current document", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    const dir = storeDir();
    const empty = path.join(dir, "memory.json");
    writeFileSync(empty, "", "utf8");

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("memory.json");
    expect(text).toContain("empty");
    expect(text).toContain("1 item(s) migrated to the v2 shape");

    const doc = JSON.parse(readFileSync(empty, "utf8")) as {
      schemaVersion: number;
      items: unknown[];
    };
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.items).toEqual([]);
  });
});

describe("migrate: configuration", () => {
  it("reports a configuration without v1 patterns as current", async () => {
    write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  agents:",
        "    - name: worker",
        "      type: cli",
        "      command: node",
        "      input_mode: stdin",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    expect(output(log)).toContain("omninode.yaml    current (no v1 patterns)");
  });

  it("lists the v1 patterns it found and migrates them", async () => {
    const configPath = write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  agents:",
        "    - name: worker",
        "      type: cli",
        "      command: node",
        "",
      ].join("\n"),
    );
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("implicit input_mode → input_mode: stdin");
    expect(text).toContain("project.agents.0.input_mode");
    expect(text).toContain("migrated 1 pattern(s)");

    const migrated = readFileSync(configPath, "utf8");
    expect(migrated).toContain("input_mode: stdin");
  });

  it("does not touch the configuration with --check", async () => {
    const configPath = write(
      "omninode.yaml",
      [
        "project:",
        "  name: Demo",
        "  agents:",
        "    - name: worker",
        "      type: cli",
        "      command: node",
        "",
      ].join("\n"),
    );
    const before = readFileSync(configPath, "utf8");
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate", "--check"]);
    const text = output(log);
    expect(text).toContain("implicit input_mode → input_mode: stdin");
    expect(text).toContain("(dry run)");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("says nothing about the configuration when there is no configuration file", async () => {
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    const text = output(log);
    expect(text).toContain("configuration:");
    expect(text).not.toContain("omninode.yaml    current");
    expect(text).toContain("Everything is at the v2 shape");
  });

  it("fails loudly when the configuration file cannot be read", async () => {
    // A directory named omninode.yaml: present as a path, but not readable
    // as a file — the migration must not swallow that error.
    mkdirSync(path.join(workDir, "omninode.yaml"), { recursive: true });
    await expect(
      createProgram().parseAsync(["node", "omninode", "migrate"]),
    ).rejects.toThrow();
  });

  it("never creates the store directory when there is nothing to migrate", async () => {
    write("omninode.yaml", MINIMAL_CONFIG);
    await createProgram().parseAsync(["node", "omninode", "migrate"]);
    expect(existsSync(path.join(workDir, ".omninode"))).toBe(false);
  });
});

describe("migrate: reports without item counts", () => {
  it("prints zero for stores that report no item counts", async () => {
    // A report without `before`/`after` still has to render a count: the
    // command substitutes 0 rather than printing "undefined".
    write("omninode.yaml", MINIMAL_CONFIG);
    vi.resetModules();
    vi.doMock("../src/persistence/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/persistence/index.js")>();
      return {
        ...actual,
        migrateProjectStores: vi.fn(async () => [
          { file: "tasks.json", state: "v1-legacy", migrated: false },
          { file: "reports.json", state: "current", migrated: false },
        ]),
      };
    });
    try {
      const { createProgram: createMockedProgram } = await import("../src/cli/index.js");
      const program = createMockedProgram();
      program.exitOverride();
      const log = capture();
      await program.parseAsync(["node", "omninode", "migrate"]);
      const text = output(log);
      expect(text).toContain("tasks.json       v1-legacy  would migrate 0 → 0 item(s)");
      expect(text).toContain("reports.json     current  0 item(s)");
    } finally {
      vi.doUnmock("../src/persistence/index.js");
      vi.resetModules();
    }
  });
});
