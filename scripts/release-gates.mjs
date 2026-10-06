/**
 * Release gates (roadmap §26, Release Validation).
 *
 *   node scripts/release-gates.mjs            # run every gate
 *   node scripts/release-gates.mjs version    # run one gate
 *
 * Exits non-zero on failure so CI and the release workflow stop before a
 * version is published.
 *
 * No shebang on purpose: this file is imported as a module by
 * tests/release-gates.test.ts (a leading `#!` is only valid in an entry
 * point, not an imported .mjs, which breaks the import on some platforms).
 * It is always run explicitly as `node scripts/release-gates.mjs`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".git", "coverage", ".omninode"]);

/** package.json, src/version.ts and CHANGELOG.md must agree on the version. */
export function checkVersionConsistency(repoRoot = root) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const versionFile = readFileSync(path.join(repoRoot, "src", "version.ts"), "utf8");
  const match = /OMNINODE_VERSION\s*=\s*"([^"]+)"/.exec(versionFile);
  const sourceVersion = match?.[1];
  const problems = [];
  if (sourceVersion !== pkg.version) {
    problems.push(`src/version.ts reports ${sourceVersion} but package.json is ${pkg.version}`);
  }
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## [${pkg.version}]`)) {
    problems.push(`CHANGELOG.md has no entry for ${pkg.version}`);
  }
  return { ok: problems.length === 0, version: pkg.version, problems };
}

/** The published tarball must ship dist + metadata only — no tests or sources. */
export function validatePackContents(repoRoot = root) {
  let output;
  try {
    output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, problems: [`npm pack --dry-run failed: ${error.message}`], files: [] };
  }
  let files = [];
  try {
    const parsed = JSON.parse(output);
    files = (parsed[0]?.files ?? []).map((entry) => entry.path);
  } catch {
    return { ok: false, problems: ["could not parse npm pack output"], files: [] };
  }

  const problems = [];
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.includes(required)) problems.push(`missing ${required} from the package`);
  }
  if (!files.some((file) => file.startsWith("dist/"))) {
    problems.push("the package contains no dist/ output");
  }
  const forbidden = files.filter(
    (file) =>
      file.startsWith("tests/") ||
      file.startsWith("src/") ||
      file.startsWith(".omninode/") ||
      file.endsWith(".tgz"),
  );
  problems.push(...forbidden.map((file) => `must not be published: ${file}`));
  return { ok: problems.length === 0, problems, files };
}

/** Best-effort secret scan for committed material (roadmap §26). */
const SECRET_PATTERNS = [
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
];

// Documentation and fixtures intentionally mention these shapes.
const ALLOWLISTED_FILES = new Set([
  "SECURITY.md",
  "docs/SECURITY.md",
  "docs/CONFIGURATION.md",
  "docs/MIGRATION.md",
  "docs/TESTING.md",
  "docs/DEVELOPMENT.md",
  "docs/EXTENDING.md",
  "docs/CHANGELOG.md",
  "CHANGELOG.md",
  "tests/security.test.ts",
  "tests/hardening.test.ts",
  "tests/config.test.ts",
  "tests/release-gates.test.ts", // synthetic patterns for the scanner's own tests
]);

export function scanSecrets(repoRoot = root) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(repoRoot, full);
      if (ALLOWLISTED_FILES.has(relative)) continue;
      // Secrets hide in .key/.pem/.env files as often as in source files.
      if (!/\.(ts|mts|cts|js|mjs|cjs|json|ya?ml|sh|md|txt|key|pem|env|npmrc|conf)$/.test(full) && !/(^|\/)\.env(\..+)?$/.test(full)) {
        continue;
      }
      const contents = readFileSync(full, "utf8");
      for (const { name, pattern } of SECRET_PATTERNS) {
        const match = pattern.exec(contents);
        if (match) findings.push(`${relative}: possible ${name}`);
      }
    }
  };
  walk(repoRoot);
  return { ok: findings.length === 0, problems: findings };
}

const GATES = {
  version: checkVersionConsistency,
  package: validatePackContents,
  secrets: scanSecrets,
};

function main() {
  const requested = process.argv[2];
  const gates = requested && GATES[requested] ? { [requested]: GATES[requested] } : GATES;
  let failed = false;
  for (const [name, gate] of Object.entries(gates)) {
    const result = gate();
    const status = result.ok ? "pass" : "FAIL";
    console.log(`${status}  ${name}`);
    for (const problem of result.problems) console.log(`      ${problem}`);
    if (!result.ok) failed = true;
  }
  if (failed) {
    console.error("\nRelease gates failed.");
    process.exit(1);
  }
  console.log("\nAll release gates passed.");
}

if (process.argv[1] && existsSync(process.argv[1]) && process.argv[1].endsWith("release-gates.mjs")) {
  main();
}
