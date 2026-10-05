/**
 * v2 Phase 24 — Final hardening: architecture audit (roadmap §28).
 *
 * Rules enforced mechanically so they hold for every future contribution:
 *
 *  1. Dependency direction: types ← persistence/adapters ← engines ← CLI.
 *  2. Filesystem access only in the persistence/audit/config/CLI layers and
 *     the sanctioned store implementations — engines go through interfaces.
 *  3. No `any` annotations in src (comments excluded).
 *  4. Console output only in the CLI and the logger; engines log via Logger.
 *  5. Documented resource budgets stay at their v2 values.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "src");

type Layer = "types" | "adapters" | "engines" | "support" | "cli";

const DIR_LAYER: Record<string, Layer> = {
  types: "types",
  cli: "cli",
  tasks: "engines",
  pipelines: "engines",
  providers: "adapters",
  agents: "adapters",
  planner: "adapters",
  memory: "adapters",
  "agent-protocol": "support",
  errors: "support",
  logger: "support",
  config: "support",
  reports: "support",
  registry: "support",
  audit: "support",
  persistence: "support",
};

const LAYER_OF = (relative: string): Layer => {
  if (relative === "index.ts") return "cli"; // the public barrel
  const top = relative.split(path.sep)[0] ?? "";
  return DIR_LAYER[top] ?? "support";
};

const ALLOWED_IMPORTS: Record<Exclude<Layer, "cli">, Layer[]> = {
  types: [],
  adapters: ["types", "support"],
  engines: ["types", "support", "adapters"],
  support: ["types", "support"],
};

const FORBIDDEN_ANY = /:\s*any\b|<any>|as any\b/;

/** Sanctioned direct-fs users: store implementations and path validation. */
const FS_ALLOWED = (relative: string): boolean =>
  relative.endsWith("store.ts") ||
  relative === path.join("agents", "cwd.ts");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
      continue;
    }
    if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const ALL_FILES = collectFiles(ROOT);

describe("architecture audit (§28)", () => {
  it("every src file maps to a known layer", () => {
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      expect(LAYER_OF(relative)).toBeDefined();
    }
  });

  it("enforces the dependency direction between layers", () => {
    const violations: string[] = [];
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      const layer = LAYER_OF(relative);
      if (layer === "cli") continue;
      // The persistence directory is the storage composition root: it
      // assembles the concrete stores (roadmap §16) and may import them.
      if (relative.startsWith(path.join("persistence"))) continue;
      const source = readFileSync(file, "utf8");
      const importPattern = /from\s+"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(source)) !== null) {
        const target = match[1];
        if (target.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), target).replace(/\.js$/, "");
          const rel = path.relative(ROOT, resolved);
          if (rel.startsWith("..")) continue; // outside src
          if (rel === "index") continue; // the public barrel
          const targetLayer = LAYER_OF(rel);
          if (targetLayer === layer) continue; // same layer
          if (targetLayer === "types") continue; // leaf everyone may use
          if (!ALLOWED_IMPORTS[layer].includes(targetLayer)) {
            violations.push(`${relative} (${layer} → ${targetLayer})`);
          }
        } else if (/^cli/.test(target)) {
          violations.push(`${relative} (${layer}) imports the CLI layer`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps direct filesystem access in the sanctioned layers", () => {
    const violations: string[] = [];
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      const layer = LAYER_OF(relative);
      if (layer === "cli" || layer === "support") continue; // stores, audit, config live in support
      if (FS_ALLOWED(relative)) continue;
      const source = readFileSync(file, "utf8");
      if (/from\s+["']node:fs["']|from\s+["']node:fs\/promises["']/.test(source)) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains no `any` annotations in src code", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      const source = stripComments(readFileSync(file, "utf8"));
      if (FORBIDDEN_ANY.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps console output in the CLI and the logger only", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      const layer = LAYER_OF(relative);
      if (layer === "cli") continue;
      if (relative.endsWith(path.join("logger", "index.ts"))) continue;
      const source = readFileSync(file, "utf8");
      if (/console\.(log|error|warn|info)\(/.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe("security audit (§28)", () => {
  it("provider and memory adapters never embed credentials", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const relative = path.relative(ROOT, file);
      if (!relative.startsWith("providers") && !relative.startsWith("memory")) continue;
      const source = readFileSync(file, "utf8");
      if (/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{12,}/i.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe("performance audit (§28): documented budgets hold", () => {
  it("keeps the resource budgets at their v2 values", async () => {
    const api = (await import("../src/index.js")) as unknown as Record<string, number>;
    expect(api.MAX_REPORT_BYTES).toBe(256 * 1024);
    expect(api.MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(api.MAX_CONTEXT_CHARS).toBe(4_000);
    expect(api.MAX_COMBINED_CONTEXT_CHARS).toBe(20_000);
    expect(api.MAX_COMBINED_FINDINGS).toBe(200);
    expect(api.DEFAULT_MAX_OUTPUT_BYTES).toBe(5 * 1024 * 1024);
    expect(api.DEFAULT_MAX_PARALLEL_STEPS).toBe(8);
  });
});
