/**
 * v3 audit M5 — CLI correctness.
 *
 * Three defects:
 *   1. the `config` command group ignored the global `--config` / `--profile`
 *      options, so `config show --config <path>` read the wrong file;
 *   2. `pipeline create` accepted a duplicate pipeline name, wrote it, and
 *      left the project unable to load any configuration at all;
 *   3. a task that ended in status `unknown` — the normal outcome of an
 *      agent timeout — made the CLI exit 0, so CI treated it as a pass.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";
import { exitCodeForStatus, EXIT } from "../src/cli/exit-codes.js";

let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-cli-correctness-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(name: string, extra = ""): string {
  const file = path.join(workDir, `${name}.yaml`);
  writeFileSync(
    file,
    `project:\n  name: ${name}\n  providers: []\n  agents: []\n  roles: []\n  pipelines: []\n${extra}`,
    "utf8",
  );
  return file;
}

describe("M5.1 — the config command group honours --config and --profile", () => {
  it("reads the file given by --config", async () => {
    const other = writeConfig("other");
    writeConfig("main");
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    await createProgram().parseAsync([
      "node",
      "omninode",
      "--config",
      other,
      "config",
      "show",
    ]);

    expect(logged.join("\n")).toContain("project:   other");
    expect(logged.join("\n")).not.toContain("project:   main");
  });

  it("uses the profile given by --profile", async () => {
    const file = path.join(workDir, "profiles.yaml");
    writeFileSync(
      file,
      [
        "project:",
        "  name: prof",
        "  providers: []",
        "  agents: []",
        "  roles: []",
        "  pipelines: []",
        "profiles:",
        "  production:",
        "    project:",
        "      name: prod-name",
        "",
      ].join("\n"),
      "utf8",
    );
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    await createProgram().parseAsync([
      "node",
      "omninode",
      "--config",
      file,
      "--profile",
      "production",
      "config",
      "show",
    ]);

    expect(logged.join("\n")).toContain("project:   prod-name");
  });
});

describe("M5.2 — pipeline create refuses a duplicate name", () => {
  it("fails without touching the configuration", async () => {
    await createProgram().parseAsync(["node", "omninode", "init", "--name", "Demo"]);
    const configPath = path.join(workDir, "omninode.yaml");
    const before = readFileSync(configPath, "utf8");

    const definition = path.join(workDir, "def.yaml");
    writeFileSync(
      definition,
      ["steps:", "  - id: s1", "    kind: collect", ""].join("\n"),
      "utf8",
    );

    await createProgram().parseAsync([
      "node",
      "omninode",
      "pipeline",
      "create",
      "demo",
      "--from",
      definition,
    ]);
    expect(readFileSync(configPath, "utf8")).not.toBe(before);

    // The second create with the same name must be refused, and must not
    // modify the file: a duplicate would make every later config load fail.
    const afterFirst = readFileSync(configPath, "utf8");
    await expect(
      createProgram().parseAsync([
        "node",
        "omninode",
        "pipeline",
        "create",
        "demo",
        "--from",
        definition,
      ]),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID" });
    expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
  });

  it("leaves the project loadable after the refusal", async () => {
    await createProgram().parseAsync(["node", "omninode", "init", "--name", "Demo"]);
    const definition = path.join(workDir, "def.yaml");
    writeFileSync(
      definition,
      ["steps:", "  - id: s1", "    kind: collect", ""].join("\n"),
      "utf8",
    );
    await createProgram().parseAsync([
      "node",
      "omninode",
      "pipeline",
      "create",
      "demo",
      "--from",
      definition,
    ]);
    await expect(
      createProgram().parseAsync([
        "node",
        "omninode",
        "pipeline",
        "create",
        "demo",
        "--from",
        definition,
      ]),
    ).rejects.toMatchObject({ code: "PIPELINE_INVALID" });

    // The project must still load — a refused duplicate is not a bricked
    // project.
    const listed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      listed.push(String(line));
    });
    await createProgram().parseAsync(["node", "omninode", "pipeline", "list"]);
    expect(listed.join("\n")).toContain("demo");
    expect(existsSync(path.join(workDir, "omninode.yaml"))).toBe(true);
  });
});

describe("M5.3 — a timed-out task does not exit 0", () => {
  it("maps the unknown status to the timeout exit code", () => {
    expect(exitCodeForStatus("unknown")).toBe(EXIT.timeout);
    expect(exitCodeForStatus("unknown")).not.toBe(EXIT.success);
  });

  it("keeps the other statuses unchanged", () => {
    expect(exitCodeForStatus("completed")).toBe(EXIT.success);
    expect(exitCodeForStatus("failed")).toBe(EXIT.general);
    expect(exitCodeForStatus("cancelled")).toBe(EXIT.cancelled);
    expect(exitCodeForStatus("timed_out")).toBe(EXIT.timeout);
  });
});
