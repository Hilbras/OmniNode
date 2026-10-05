/**
 * v2 Phase 16 tests — Configuration System v2 (roadmap §20): source
 * precedence, profiles, environment overrides and actionable diagnostics.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configDiagnostics,
  loadConfigDetailed,
  mergeConfig,
  resolveProfile,
  userConfigPath,
} from "../src/config/index.js";
import { createProgram } from "../src/cli/index.js";

const BASE = `
project:
  name: Base
  providers:
    - name: gw
      type: openai-compatible
      base_url: https://gw.test/v1
`;

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-cfgv2-"));
}

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = tmp();
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("configuration precedence (§20)", () => {
  it("project config overrides user config, which overrides defaults", () => {
    const userFile = path.join(workDir, "user.yaml");
    writeFileSync(userFile, BASE.replace("Base", "FromUser"), "utf8");
    writeFileSync(path.join(workDir, "omninode.yaml"), BASE.replace("Base", "FromProject"), "utf8");

    const { config, sources } = loadConfigDetailed({
      env: { OMNINODE_USER_CONFIG: userFile },
    });
    expect(config.project.name).toBe("FromProject");
    expect(sources.projectFile).toBe(path.join(workDir, "omninode.yaml"));
    expect(sources.userFile).toBe(userFile);
    // Defaults were recorded.
    expect(sources.defaults).toContain("logging.level");
    expect(config.logging).toMatchObject({ level: "info", format: "text" });
  });

  it("environment overrides beat every file", () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), BASE, "utf8");
    const { config, sources } = loadConfigDetailed({
      env: { OMNINODE_LOG_LEVEL: "debug", OMNINODE_MEMORY_PROVIDER: "local" },
    });
    expect(config.logging?.level).toBe("debug");
    expect(config.project.memory?.provider).toBe("local");
    expect(sources.envOverrides).toContain("OMNINODE_LOG_LEVEL");
    expect(sources.defaults).not.toContain("logging.level");
  });

  it("an explicit --config path bypasses the user configuration", () => {
    const userFile = path.join(workDir, "user.yaml");
    writeFileSync(userFile, BASE.replace("Base", "FromUser"), "utf8");
    const explicit = path.join(workDir, "explicit.yaml");
    writeFileSync(explicit, BASE.replace("Base", "Explicit"), "utf8");

    const { config, sources } = loadConfigDetailed({
      path: explicit,
      env: { OMNINODE_USER_CONFIG: userFile },
    });
    expect(config.project.name).toBe("Explicit");
    expect(sources.userFile).toBeUndefined();
  });

  it("works with only a user configuration", () => {
    const userFile = path.join(workDir, "user.yaml");
    writeFileSync(userFile, BASE, "utf8");
    const { config, sources } = loadConfigDetailed({ env: { OMNINODE_USER_CONFIG: userFile } });
    expect(config.project.name).toBe("Base");
    expect(sources.projectFile).toBeUndefined();
  });

  it("userConfigPath honors OMNINODE_USER_CONFIG and falls back to ~/.omninode", () => {
    expect(userConfigPath({ OMNINODE_USER_CONFIG: "/x/y.yaml" })).toBe("/x/y.yaml");
    expect(userConfigPath({ HOME: "/home/tester" })).toBe(path.join("/home/tester", ".omninode", "config.yaml"));
  });
});

describe("mergeConfig", () => {
  it("merges objects deeply and replaces arrays", () => {
    const merged = mergeConfig(
      { logging: { level: "info", format: "text" }, agents: [{ name: "a" }] },
      { logging: { level: "debug" }, agents: [{ name: "b" }] },
    );
    expect(merged).toEqual({
      logging: { level: "debug", format: "text" },
      agents: [{ name: "b" }],
    });
  });
});

describe("profiles (§16)", () => {
  const WITH_PROFILES = `
profile: development
project:
  name: Base
logging:
  level: info
profiles:
  development:
    logging:
      level: debug
  production:
    logging:
      level: warn
`;

  it("applies the profile overlay from the file", () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), WITH_PROFILES, "utf8");
    const { config, sources } = loadConfigDetailed({ env: {} });
    expect(sources.profile).toBe("development");
    expect(config.logging?.level).toBe("debug");
  });

  it("a CLI profile wins over the file profile", () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), WITH_PROFILES, "utf8");
    const { config, sources } = loadConfigDetailed({ env: {}, profile: "production" });
    expect(sources.profile).toBe("production");
    expect(config.logging?.level).toBe("warn");
  });

  it("an environment profile wins over the file profile", () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), WITH_PROFILES, "utf8");
    const { config } = loadConfigDetailed({ env: { OMNINODE_PROFILE: "production" } });
    expect(config.logging?.level).toBe("warn");
  });

  it("an unknown profile fails with the known set", () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), WITH_PROFILES, "utf8");
    expect(() => loadConfigDetailed({ env: {}, profile: "staging" })).toThrow(/Profile "staging" is not defined/);
  });

  it("resolveProfile follows env > file > default (CLI is applied by the loader)", () => {
    expect(resolveProfile({ profile: "file" }, { OMNINODE_PROFILE: "env" })).toBe("env");
    expect(resolveProfile({}, { OMNINODE_PROFILE: "env" })).toBe("env");
    expect(resolveProfile({ profile: "file" }, {})).toBe("file");
    expect(resolveProfile({}, {})).toBe("default");
  });
});

describe("validation diagnostics (§16)", () => {
  it("reports actionable, named problems instead of generic errors", () => {
    writeFileSync(
      path.join(workDir, "omninode.yaml"),
      `
project:
  name: Diag
  providers:
    - name: deepseek
      type: openai-compatible
      base_url: https://api.deepseek.example/v1
  agents:
    - name: careless
      type: cli
      allow_external_cwd: true
  pipelines:
    - id: broken
      steps:
        - id: a
          kind: collect
          depends_on: [ghost]
`,
      "utf8",
    );
    const { config } = loadConfigDetailed({ env: {} });
    const notes = configDiagnostics(config);
    expect(notes).toContainEqual(expect.stringContaining('Provider "deepseek": API key reference is missing'));
    expect(notes).toContainEqual(expect.stringContaining('Agent "careless": no command configured'));
    expect(notes).toContainEqual(expect.stringContaining('Agent "careless": may run outside the project root'));
    expect(notes).toContainEqual(expect.stringContaining('Pipeline "broken": step "a" depends on unknown step "ghost"'));
  });

  it("stays quiet for a well-formed configuration", () => {
    writeFileSync(
      path.join(workDir, "omninode.yaml"),
      BASE.replace("https://gw.test/v1", "http://127.0.0.1:1234/v1"),
      "utf8",
    );
    const { config } = loadConfigDetailed({ env: {} });
    expect(configDiagnostics(config)).toEqual([]);
  });
});

describe("CLI: --config, --profile, config profiles/validate", () => {
  it("uses --config to load another file", async () => {
    writeFileSync(path.join(workDir, "omninode.yaml"), BASE.replace("Base", "Project"), "utf8");
    const other = path.join(workDir, "other.yaml");
    writeFileSync(other, BASE.replace("Base", "Other"), "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "omninode", "--config", other, "config", "path",
    ]);
    expect(log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n")).toContain("other.yaml");
  });

  it("config profiles lists the active and defined profiles", async () => {
    writeFileSync(
      path.join(workDir, "omninode.yaml"),
      "profile: development\nproject:\n  name: P\nprofiles:\n  development:\n    logging:\n      level: debug\n  production:\n    logging:\n      level: warn\n",
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "config", "profiles"]);
    const output = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain("active:  development");
    expect(output).toContain("defined: development, production");
  });

  it("config validate reports sources and diagnostics", async () => {
    writeFileSync(
      path.join(workDir, "omninode.yaml"),
      "profile: testing\nproject:\n  name: V\n  providers:\n    - name: gw\n      type: openai-compatible\n      base_url: https://gw.test/v1\nprofiles:\n  testing:\n    logging:\n      level: debug\n",
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "config", "validate"]);
    const output = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain("profile:  testing");
    expect(output).toContain('Provider "gw": API key reference is missing');
  });
});
