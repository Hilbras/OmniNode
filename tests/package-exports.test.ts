/**
 * Published-package export parity (v3 audit, M0).
 *
 * `dist/index.d.ts` and `dist/index.js` must agree: every name the type
 * declarations advertise as a *value* must exist as a runtime export, or a
 * consumer that imports it in a value position dies with
 * `SyntaxError: The requested module ... does not provide an export named ...`.
 *
 * The bug this guards: `src/index.ts` re-exported the types barrel with
 * `export type *`, which erases values at runtime, while the tsup d.ts
 * bundler still resolved two values through it — `MemoryStore` (a type alias
 * of a class) and `TERMINAL_TASK_STATUSES` (a `const` in the types layer).
 *
 * The second assertion closes the same contract for the documentation: every
 * public name in `docs/API.md` must resolve in the package.
 *
 * `npm test` can run before `npm run build` (that is the CI order), so the
 * dist/ assertions are conditional — the same pattern the release-gate tests
 * use.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BUILT = existsSync(path.join(ROOT, "dist", "index.js")) && existsSync(path.join(ROOT, "dist", "index.d.ts"));

/** The names a `.d.ts` export statement advertises as runtime values. */
function valueExportsFromDts(dts: string): string[] {
  const names: string[] = [];
  for (const match of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const rawEntry of match[1].split(",")) {
      const entry = rawEntry.trim();
      if (entry.length === 0) continue;
      if (/^type\s/.test(entry)) continue; // type-only — erased at runtime
      // `Foo as Bar` exports the name `Bar`.
      const exported = entry.includes(" as ") ? entry.split(" as ").pop()!.trim() : entry;
      names.push(exported);
    }
  }
  return names;
}

/** Every name declared in a `.d.ts`, whether exported as a value or a type. */
function declaredNamesInDts(dts: string): Set<string> {
  const names = new Set<string>();
  for (const match of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const rawEntry of match[1].split(",")) {
      const entry = rawEntry.trim();
      if (entry.length === 0) continue;
      const withoutType = entry.replace(/^type\s+/, "");
      names.add((withoutType.includes(" as ") ? withoutType.split(" as ").pop()! : withoutType).trim());
    }
  }
  for (const match of dts.matchAll(/declare\s+(?:const|class|function|abstract class)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of dts.matchAll(/declare\s+(?:interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  return names;
}

/**
 * Public names the documentation presents as part of the package surface.
 *
 * Only the per-subsystem sections count (the preamble names helpers
 * illustratively), and a name the doc explicitly marks as withheld is not a
 * public name.
 */
function documentedPublicNames(markdown: string): string[] {
  const body = markdown.slice(markdown.indexOf("\n## "));
  const withheldMarker = /not exported|remains? internal|withheld/i;
  const lines = body.split("\n");
  const names = new Set<string>();
  for (const line of lines) {
    if (withheldMarker.test(line)) continue;
    for (const match of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
      const name = match[1]!;
      // Only PascalCase identifiers are public API names; lower-case words in
      // prose (e.g. `config`, `name`) are not.
      if (/^[A-Z]/.test(name)) names.add(name);
    }
  }
  return [...names];
}

describe("published package export parity", () => {
  it.runIf(BUILT)("advertises no value export that the runtime does not provide", async () => {
    const dts = readFileSync(path.join(ROOT, "dist", "index.d.ts"), "utf8");
    const runtime = (await import(path.join(ROOT, "dist", "index.js"))) as Record<string, unknown>;

    const advertised = valueExportsFromDts(dts);
    const missing = advertised.filter((name) => !(name in runtime));

    expect(missing).toEqual([]);
  });

  it.runIf(BUILT)("resolves every public name documented in docs/API.md", () => {
    const dts = readFileSync(path.join(ROOT, "dist", "index.d.ts"), "utf8");
    const declared = declaredNamesInDts(dts);
    const documented = documentedPublicNames(readFileSync(path.join(ROOT, "docs", "API.md"), "utf8"));

    const missing = documented.filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });
});

describe("public API source surface", () => {
  it("keeps TERMINAL_TASK_STATUSES a runtime export of the package", async () => {
    const api = (await import("../src/index.js")) as Record<string, unknown>;
    expect(Array.isArray(api.TERMINAL_TASK_STATUSES)).toBe(true);
    expect(api.TERMINAL_TASK_STATUSES).toContain("completed");
    expect(api.TERMINAL_TASK_STATUSES).toContain("failed");
  });

  it("does not leak runtime values through the type-only types barrel", async () => {
    const types = (await import("../src/types/index.js")) as Record<string, unknown>;
    expect(types.TERMINAL_TASK_STATUSES).toBeUndefined();
  });
});
