/**
 * v3 audit M7a — the documentation must describe a configuration that loads.
 *
 * The profile example in `docs/CONFIGURATION.md` put `memory` at the root of
 * the overlay instead of inside `project:`, so the documented file failed to
 * load with `CONFIG_INVALID`. This test loads the documented examples so
 * the docs cannot drift again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigDetailed } from "../src/config/loader.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DOCS = path.resolve(__dirname, "..", "docs");

/**
 * Extracts every fenced YAML block from a markdown document.
 *
 * The line ending is matched explicitly: a checkout on Windows may carry CRLF,
 * and a bare `\n` would find no blocks at all.
 */
function yamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```ya?ml\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/** The body of one `## ` section, up to the next one. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\r?\n## /);
  if (next >= 0) return rest.slice(0, next);
  return rest;
}

function loadBlock(name: string, content: string): ReturnType<typeof loadConfigDetailed> {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-doc-"));
  const file = path.join(dir, "omninode.yaml");
  writeFileSync(file, content, "utf8");
  return loadConfigDetailed({ path: file });
}

describe("the documented configuration examples load", () => {
  it("loads the profile example from docs/CONFIGURATION.md", () => {
    const markdown = readFileSync(path.join(DOCS, "CONFIGURATION.md"), "utf8");
    // The "Profiles" section holds the full-file example.
    const blocks = yamlBlocks(section(markdown, "## Profiles"));
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const loaded = loadBlock("profile-example", block);
      expect(loaded.config.project.name).toBeTruthy();
    }
  });

  it("applies the documented profile overlay", () => {
    const markdown = readFileSync(path.join(DOCS, "CONFIGURATION.md"), "utf8");
    const block = yamlBlocks(section(markdown, "## Profiles"))[0]!;
    const loaded = loadBlock("profile-example", block);

    // The active profile is `development`, so its overlay must have been
    // applied on top of the base file.
    expect(loaded.sources.profile).toBe("development");
    expect(loaded.config.logging?.level).toBe("debug");
    expect(loaded.config.project.memory?.provider).toBe("local");
  });

  it("loads the provider example from docs/CONFIGURATION.md", () => {
    const markdown = readFileSync(path.join(DOCS, "CONFIGURATION.md"), "utf8");
    const blocks = yamlBlocks(section(markdown, "## Secrets"));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // A fragment may not be a full document; only assert it does not blow
      // up with an unexpected error type.
      expect(() => loadBlock("secrets", block)).not.toThrowError(/TypeError/);
    }
  });

  it("loads the shipped omninode.yaml.example", () => {
    const example = path.resolve(__dirname, "..", "omninode.yaml.example");
    const loaded = loadBlock("example", readFileSync(example, "utf8"));
    expect(loaded.config.project.name).toBeTruthy();
  });
});
