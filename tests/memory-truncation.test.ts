/**
 * v2.0.3 Fix 01 — memory context truncation safety.
 *
 * Truncation must drop complete entries (never cut one mid-content), keep
 * priority-ordered content first, report exact original/final sizes, and mark
 * every cut with an explicit marker. Full entry metadata is always preserved.
 */
import { describe, expect, it } from "vitest";
import { MemoryService, MAX_CONTEXT_CHARS, CONTEXT_TRUNCATION_MARKER } from "../src/memory/service.js";
import type { IMemoryProvider, MemoryEntry, MemoryProviderMetadata } from "../src/types/memory.js";

function stubProvider(entries: MemoryEntry[]): IMemoryProvider {
  return {
    name: "stub",
    retrieve: async () => entries,
    store: async () => undefined,
    search: async () => entries,
    metadata(): MemoryProviderMetadata {
      return { name: "stub", capabilities: ["retrieve", "store"], relevanceRanking: true };
    },
    query: async () => entries,
    write: async () => undefined,
  };
}

function entry(overrides: Partial<MemoryEntry> & { key: string; content: string }): MemoryEntry {
  return { scope: "project", ...overrides };
}

const longContent = (chars: number, seed = "a"): string => seed.repeat(chars);

describe("Fix 01: no truncation", () => {
  it("returns the full context with matching sizes and no marker", async () => {
    const entries = [
      entry({ key: "p1", scope: "project", content: "project note" }),
      entry({ key: "t1", scope: "task", content: "task note" }),
    ];
    const service = new MemoryService(stubProvider(entries));
    const context = await service.contextFor({ objective: "anything" });

    expect(context.truncated).toBe(false);
    expect(context.text).not.toContain("TRUNCATED");
    expect(context.originalSize).toBe(context.text.length);
    expect(context.finalSize).toBe(context.text.length);
    expect(context.entries).toHaveLength(2);
  });

  it("treats the exact boundary as fitting", async () => {
    const entries = [entry({ key: "e1", content: longContent(50) })];
    // "### Relevant memory (project)\n- " = 32 chars + 50 = 82 total.
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 82 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(false);
    expect(context.text.length).toBe(82);
    expect(context.originalSize).toBe(82);
    expect(context.finalSize).toBe(82);
  });
});

describe("Fix 01: entry-boundary truncation", () => {
  it("drops complete entries instead of cutting through one", async () => {
    const entries = [
      entry({ key: "keep1", content: longContent(100, "1") }),
      entry({ key: "keep2", content: longContent(100, "2") }),
      entry({ key: "cut", content: longContent(500, "3") }),
    ];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 400 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    // The large third entry is omitted whole, never sliced mid-content.
    expect(context.text).toContain("1111");
    expect(context.text).toContain("2222");
    expect(context.text).not.toContain("3333");
    expect(context.text).toContain(CONTEXT_TRUNCATION_MARKER);
    // Every entry line in the output is complete (ends where its content ends).
    for (const line of context.text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line.endsWith("1") || line.endsWith("2")).toBe(true);
    }
  });

  it("reports originalSize > finalSize and preserves all entry metadata", async () => {
    const entries = [
      entry({ key: "a", content: longContent(300) }),
      entry({ key: "b", content: longContent(300, "b") }),
      entry({ key: "c", content: longContent(300, "c") }),
    ];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 500 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    expect(context.originalSize).toBeGreaterThan(500);
    expect(context.finalSize).toBe(context.text.length);
    expect(context.finalSize).toBeLessThanOrEqual(500);
    expect(context.finalSize).toBeLessThan(context.originalSize);
    // Metadata preserved even for entries whose text was omitted.
    expect(context.entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps the marker visible and within budget", async () => {
    const entries = [
      entry({ key: "a", content: longContent(300) }),
      entry({ key: "b", content: longContent(300, "b") }),
    ];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 400 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.text.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
    expect(context.finalSize).toBeLessThanOrEqual(400);
  });
});

describe("Fix 01: priority ordering", () => {
  it("keeps project-scope content before task/role/knowledge when truncating", async () => {
    const entries = [
      entry({ key: "k-low", scope: "knowledge", content: longContent(200, "k") }),
      entry({ key: "r-mid", scope: "role", content: longContent(200, "r") }),
      entry({ key: "t-mid", scope: "task", content: longContent(200, "t") }),
      entry({ key: "p-high", scope: "project", content: longContent(200, "p") }),
    ];
    // Budget fits project + task blocks (232 chars each) but nothing more.
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 550 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    expect(context.text).toContain("### Relevant memory (project)");
    expect(context.text).toContain("pppp");
    expect(context.text).toContain("tttt");
    expect(context.text).not.toContain("rrrr"); // lower-priority scopes omitted whole
    expect(context.text).not.toContain("kkkk");
    const projectIndex = context.text.indexOf("(project)");
    const taskIndex = context.text.indexOf("(task)");
    expect(projectIndex).toBeLessThan(taskIndex);
  });
});

describe("Fix 01: pathological budgets", () => {
  it("still emits the explicit marker under a very small limit", async () => {
    const entries = [entry({ key: "a", content: longContent(200) })];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 60 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    expect(context.text).toBe(CONTEXT_TRUNCATION_MARKER);
    expect(context.originalSize).toBeGreaterThan(60);
    expect(context.finalSize).toBe(context.text.length);
    expect(context.entries).toHaveLength(1);
  });

  it("handles a single entry longer than the whole budget", async () => {
    const entries = [entry({ key: "huge", content: longContent(10_000) })];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 100 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    expect(context.text).toContain(CONTEXT_TRUNCATION_MARKER);
    // The oversized entry is omitted whole — no partial content leaks.
    expect(context.text).not.toContain("aaaa");
    expect(context.entries[0]?.key).toBe("huge");
  });
});

describe("Fix 01: content robustness", () => {
  it("counts unicode content by characters, not bytes", async () => {
    const emoji = "🚀".repeat(50); // 50 chars, 200 bytes
    const entries = [
      entry({ key: "u1", content: emoji }),
      entry({ key: "u2", content: "日本語のメモリエントリ" }),
      entry({ key: "u3", content: emoji }),
      entry({ key: "u4", content: emoji }),
    ];
    const service = new MemoryService(stubProvider(entries), undefined, { maxContextChars: 120 });
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(true);
    expect(context.finalSize).toBe(context.text.length);
    expect([...context.text].length).toBe(context.text.length); // no broken surrogate pairs at entry boundaries
    for (const line of context.text.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).toMatch(/🚀$|日本語のメモリエントリ$/); // complete entries only
    }
  });

  it("reports sizes correctly for multi-scope contexts", async () => {
    const entries = [
      entry({ key: "p", scope: "project", category: "decisions", content: "use TypeScript" }),
      entry({ key: "t", scope: "task", content: "task context" }),
      entry({ key: "r", scope: "role", content: "role guidance" }),
      entry({ key: "k", scope: "knowledge", content: "general knowledge" }),
    ];
    const service = new MemoryService(stubProvider(entries));
    const context = await service.contextFor({ objective: "x" });

    expect(context.truncated).toBe(false);
    expect(context.originalSize).toBe(context.text.length);
    expect(context.text).toContain("[decisions] use TypeScript");
    const scopes = ["project", "task", "role", "knowledge"];
    const indices = scopes.map((s) => context.text.indexOf(`(${s})`));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("exposes the default budget constant", () => {
    expect(MAX_CONTEXT_CHARS).toBe(4_000);
  });
});
