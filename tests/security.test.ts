/**
 * v2 Phase 13 tests — Security Hardening (roadmap §17): inline-secret
 * detection, process-execution guards, report size limits and the security
 * audit command.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanForInlineSecrets, describeSecretFindings } from "../src/config/secrets.js";
import { loadConfig } from "../src/config/loader.js";
import { ReportService, MAX_REPORT_BYTES } from "../src/reports/service.js";
import { FileReportStore } from "../src/reports/store.js";
import { createProgram } from "../src/cli/index.js";
import type { Report } from "../src/types/report.js";
import type { Task } from "../src/types/task.js";

describe("inline secret detection (§17)", () => {
  it("flags literal credentials and never echoes the value", () => {
    const findings = scanForInlineSecrets(
      ["providers:", "  - name: gw", "    api_key: sk-live-abcdef123456", "    base_url: https://x.test"].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe("api_key");
    expect(findings[0]?.excerpt).not.toContain("abcdef123456");
    expect(findings[0]?.excerpt).toContain("redacted");
  });

  it("accepts environment-variable references and placeholders", () => {
    const findings = scanForInlineSecrets(
      [
        "  api_key_env_var: MY_API_KEY",
        "  api_key: ${MY_API_KEY}",
        "  api_key: $MY_API_KEY",
        "  api_key: <from-secret-store>",
        '  api_key: ""',
        "  token_file: ./token.txt",
        "  # api_key: commented-out-example",
      ].join("\n"),
    );
    expect(findings).toEqual([]);
  });

  it("ignores short values and non-secret keys", () => {
    expect(scanForInlineSecrets("  name: dev\n  model: gpt-test\n  token: short")).toEqual([]);
  });

  it("loadConfig refuses a config containing an inline secret", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-secret-"));
    const file = path.join(dir, "omninode.yaml");
    writeFileSync(file, "project:\n  name: x\n  providers:\n    - name: gw\n      type: openai-compatible\n      base_url: https://x.test\n      api_key_env_var: OK\n# note\n# api_key: sk-not-really\n", "utf8");
    // Clean config loads.
    expect(() => loadConfig({ path: file, env: {} })).not.toThrow();

    writeFileSync(file, "project:\n  name: x\n  providers:\n    - name: gw\n      api_key: sk-live-realsecret1234\n", "utf8");
    expect(() => loadConfig({ path: file, env: {} })).toThrow(/inline secret/);
    expect(() => loadConfig({ path: file, env: {} })).toThrow(/api_key_env_var/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("describeSecretFindings is actionable", () => {
    const message = describeSecretFindings("omninode.yaml", [
      { line: 4, key: "api_key", excerpt: "api_key: sk-… (redacted)" },
    ]);
    expect(message).toContain("omninode.yaml");
    expect(message).toContain("line 4");
    expect(message).toContain("MY_API_KEY");
  });
});

describe("process execution guard (§17)", () => {
  it("no source module executes commands through a shell", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const code = readFileSync(full, "utf8");
        const shellPatterns = [/execSync\s*\(/, /[^.\w]exec\s*\(/, /shell\s*:\s*true/];
        for (const pattern of shellPatterns) {
          if (pattern.test(code)) offenders.push(`${full.replace(`${root}/`, "")} (${pattern})`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("spawning goes through the hardened process adapter", () => {
    const adapter = readFileSync(
      path.resolve(__dirname, "..", "src", "agents", "process", "index.ts"),
      "utf8",
    );
    expect(adapter).toContain("spawn(");
    expect(adapter).not.toContain("shell: true");
  });
});

describe("output limits (§17)", () => {
  it("rejects oversized reports instead of persisting them", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-bigreport-"));
    const service = new ReportService(new FileReportStore(dir));
    const huge: Report = {
      id: "huge",
      taskId: "t",
      agent: "a",
      summary: "x".repeat(MAX_REPORT_BYTES + 1000),
      findings: [],
      recommendations: [],
      createdAt: new Date().toISOString(),
    };
    const task: Task = {
      id: "t",
      objective: "o",
      agent: "a",
      status: "completed",
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: { reports: [huge] },
    };
    const collected = await service.collectFromTasks([task]);
    expect(collected).toEqual([]);
    expect(service.lastDiagnostics.rejected[0]?.reason).toContain("byte limit");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("CLI: omninode security audit", () => {
  let workDir: string;
  let previousCwd: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "omninode-secaudit-"));
    previousCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports environment exposure and the trust model", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    await createProgram().parseAsync([
      "node", "omninode", "agent", "add", "--name", "inherits", "--command", "some-agent",
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain('agent "inherits"');
    expect(output).toContain("inherits the full environment");
    expect(output).toContain("Trust model");
    expect(output).toContain("does not sandbox agents");
  });

  it("reports a clean project without findings", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "omninode", "security", "audit"]);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("no findings");
  });
});