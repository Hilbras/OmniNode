import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPlannerContext } from "../src/planner/context.js";
import { HeuristicPlanner } from "../src/planner/heuristic.js";
import { ModelPlanner, parsePlanJson } from "../src/planner/model.js";
import { FilePlanStore } from "../src/planner/store.js";
import { buildPlanner } from "../src/planner/factory.js";
import type { Report } from "../src/types/report.js";
import type { PlanRequest } from "../src/planner/types.js";
import type { MemoryEntry } from "../src/types/memory.js";
import type { RoleDefinition } from "../src/types/role.js";

const role: RoleDefinition = {
  id: "planner",
  name: "Planner",
  responsibilities: ["plan things"],
  expectedOutputs: ["a plan"],
};

const memory: MemoryEntry[] = [
  { key: "known:auth", scope: "project", content: "Known problem: rate limiter fails under load" },
];

const reports: Report[] = [
  {
    id: "rep-a",
    taskId: "t1",
    agent: "kimi",
    summary: "research done",
    findings: [
      { id: "f1", title: "Broken JWT validation", detail: "tokens accepted unsigned", severity: "critical" },
    ],
    recommendations: ["Add signature verification middleware"],
    createdAt: new Date().toISOString(),
  },
  {
    id: "rep-b",
    taskId: "t2",
    agent: "gemini",
    summary: "research done too",
    findings: [
      { id: "f2", title: "Broken JWT validation", detail: "confirmed independently", severity: "high" },
    ],
    recommendations: ["Add signature verification middleware"],
    createdAt: new Date().toISOString(),
  },
];

const request: PlanRequest = {
  objective: "harden the authentication module",
  reports,
  role,
  memory,
};

function chatReturning(text: string) {
  return vi.fn(async () => text);
}

describe("buildPlannerContext", () => {
  it("includes objective, role, findings with sources, and memory", () => {
    const context = buildPlannerContext(request);
    expect(context).toContain("# Task\nharden the authentication module");
    expect(context).toContain("# Role\nPlanner (planner)");
    expect(context).toContain("[critical] Broken JWT validation (source: kimi, finding: f1)");
    expect(context).toContain("Add signature verification middleware (source: gemini)");
    expect(context).toContain("Relevant memory");
    expect(context).toContain("rate limiter");
  });
});

describe("HeuristicPlanner", () => {
  it("creates recommendation and remediation steps, most severe first", async () => {
    const plan = await new HeuristicPlanner().plan(request);
    expect(plan.generatedBy).toBe("heuristic");
    expect(plan.steps[0]?.title).toBe("Add signature verification middleware");
    expect(plan.steps.some((s) => s.title.startsWith("Fix:") && s.sourceFindings?.includes("f1"))).toBe(true);
    expect(plan.summary).toContain("2 report(s)");
    expect(plan.risks?.join(" ")).toContain("Critical finding");
  });

  it("produces an investigation step when reports have nothing actionable", async () => {
    const plan = await new HeuristicPlanner().plan({
      objective: "x",
      reports: [{ id: "r", taskId: "t", agent: "a", summary: "s", findings: [], recommendations: [], createdAt: "" }],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.title).toContain("Gather additional information");
  });
});

describe("parsePlanJson", () => {
  it("parses fenced JSON and maps snake_case fields", () => {
    const parsed = parsePlanJson(
      '```json\n{"goal":"g","summary":"s","steps":[{"title":"t","acceptance_criteria":["a"],"source_findings":["f1"]}]}\n```',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.goal).toBe("g");
    expect(parsed.summary).toBe("s");
    expect(parsed.steps[0]).toMatchObject({
      id: "step-1",
      title: "t",
      acceptanceCriteria: ["a"],
      sourceFindings: ["f1"],
    });
  });

  it("reports structured errors for prose or invalid shapes", () => {
    const prose = parsePlanJson("no json here");
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.reason).toContain("no JSON object");

    const empty = parsePlanJson('{"goal":"g","summary":"s","steps": []}');
    expect(empty.ok).toBe(false);

    const missingGoal = parsePlanJson('{"summary":"s","steps":[{"title":"t"}]}');
    expect(missingGoal.ok).toBe(false);
    if (!missingGoal.ok) expect(missingGoal.issues[0]?.path).toContain("goal");
  });
});

describe("ModelPlanner", () => {
  it("parses a valid JSON plan from the model", async () => {
    const chat = chatReturning(
      '{"goal":"harden auth","summary":"Final analysis: auth is broken.","steps":[{"id":"s1","title":"Verify signatures","order":1}],"risks":["regression risk"]}',
    );
    const plan = await new ModelPlanner({ model: "gw:gpt", chat }).plan(request);
    expect(plan.generatedBy).toBe("model:gw:gpt");
    expect(plan.summary).toBe("Final analysis: auth is broken.");
    expect(plan.steps[0]?.title).toBe("Verify signatures");
    expect(plan.risks).toEqual(["regression risk"]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("falls back to the heuristic planner on unparseable output", async () => {
    const plan = await new ModelPlanner({
      model: "gw:gpt",
      chat: chatReturning("I cannot produce JSON today, sorry."),
      fallback: new HeuristicPlanner(),
    }).plan(request);
    expect(plan.generatedBy).toBe("heuristic");
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("throws PLANNER_FAILED when the model call fails with no fallback", async () => {
    const planner = new ModelPlanner({
      model: "gw:gpt",
      chat: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    });
    // Transport failures are PLANNER_FAILED; schema failures are PLAN_INVALID (§15).
    await expect(planner.plan(request)).rejects.toMatchObject({
      code: "PLAN_INVALID",
      message: expect.stringContaining("gateway down"),
    });
  });
});

describe("plan storage + factory", () => {
  it("roundtrips plans through the store", async () => {
    const store = new FilePlanStore(mkdtempSync(path.join(tmpdir(), "omninode-plan-")));
    const plan = await new HeuristicPlanner().plan({ objective: "persist me", reports });
    plan.pipelineRunId = "run-1";
    await store.save(plan);
    expect((await store.list({ pipelineRunId: "run-1" })).map((p) => p.id)).toEqual([plan.id]);
    expect((await store.get(plan.id))?.summary).toContain("2 report(s)");
    expect(await store.get("plan-nope")).toBeUndefined();
  });

  it("buildPlanner maps config kinds", async () => {
    expect(buildPlanner({ kind: "heuristic" }, vi.fn())).toBeInstanceOf(HeuristicPlanner);
    const modelPlanner = buildPlanner({ kind: "model", model: "gw:gpt" }, chatReturning("{}"));
    expect(modelPlanner?.name).toBe("model");
    expect(() => buildPlanner({ kind: "model" }, vi.fn())).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(buildPlanner(undefined, vi.fn())).toBeUndefined();
  });
});
