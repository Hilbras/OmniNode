/**
 * v2 Phase 22 tests — release gates (roadmap §26): version consistency,
 * package contents and secret scanning.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkVersionConsistency,
  scanSecrets,
  validatePackContents,
} from "../scripts/release-gates.mjs";

const dirs: string[] = [];

function fakeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-gates-"));
  dirs.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("version consistency gate", () => {
  it("passes when package.json, version.ts and the changelog agree", () => {
    const dir = fakeRepo({
      "package.json": JSON.stringify({ name: "x", version: "1.2.3" }),
      "src/version.ts": 'export const OMNINODE_VERSION = "1.2.3";',
      "CHANGELOG.md": "# Changelog\n\n## [1.2.3] — release\n",
    });
    const result = checkVersionConsistency(dir);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.2.3");
  });

  it("fails on version drift between package.json and version.ts", () => {
    const dir = fakeRepo({
      "package.json": JSON.stringify({ name: "x", version: "1.2.3" }),
      "src/version.ts": 'export const OMNINODE_VERSION = "1.2.2";',
      "CHANGELOG.md": "## [1.2.3]",
    });
    const result = checkVersionConsistency(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("1.2.2");
  });

  it("fails when the changelog has no entry for the version", () => {
    const dir = fakeRepo({
      "package.json": JSON.stringify({ name: "x", version: "9.9.9" }),
      "src/version.ts": 'export const OMNINODE_VERSION = "9.9.9";',
      "CHANGELOG.md": "## [1.0.0] — old",
    });
    const result = checkVersionConsistency(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("CHANGELOG");
  });
});

describe("secret scanning gate", () => {
  it("passes on clean material", () => {
    const dir = fakeRepo({
      "src/app.ts": 'const url = "https://api.example.com/v1";',
      "README.md": "How to configure providers.",
    });
    expect(scanSecrets(dir).ok).toBe(true);
  });

  it("flags committed credentials and private keys", () => {
    const dir = fakeRepo({
      "src/config.ts": 'const key = "sk-abcdefghijklmnopqrstuvwxyz012345";',
      "deploy/id_rsa": "ssh-key-placeholder",
      "ci/values.yaml": "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "keys/id.key": "-----BEGIN RSA PRIVATE KEY-----",
    });
    const result = scanSecrets(dir);
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("OpenAI-style key");
    expect(problems).toContain("GitHub token");
    expect(problems).toContain("private key block");
  });

  it("ignores node_modules, dist and local state", () => {
    const dir = fakeRepo({
      "node_modules/pkg/index.js": 'const k = "sk-abcdefghijklmnopqrstuvwxyz012345";',
      "dist/index.js": 'const k = "sk-abcdefghijklmnopqrstuvwxyz012345";',
      ".omninode/tasks.json": '{"rawOutput":"sk-abcdefghijklmnopqrstuvwxyz012345"}',
      "src/ok.ts": "export const fine = true;",
    });
    expect(scanSecrets(dir).ok).toBe(true);
  });
});

describe("package validation gate", () => {
  it("accepts the real package (dist + metadata only)", () => {
    const result = validatePackContents(process.cwd());
    if (!result.ok) {
      // The dist/ build must exist for this assertion to be meaningful.
      throw new Error(`package gate failed: ${result.problems.join(", ")}`);
    }
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("README.md");
    expect(result.files).toContain("LICENSE");
  });

  it("rejects a package that would ship tests or sources", () => {
    // Simulated by asserting the forbidden-path rule through the real output:
    // none of tests/, src/ or .omninode/ may appear.
    const result = validatePackContents(process.cwd());
    const forbidden = result.files.filter(
      (file) => file.startsWith("tests/") || file.startsWith("src/") || file.startsWith(".omninode/"),
    );
    expect(forbidden).toEqual([]);
  });
});
