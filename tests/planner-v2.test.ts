/**
 * v2 Phase 11 tests — Planner v2 (roadmap §15): planner inputs, structured
 * plan validation with heuristic fallback, and provider-agnosticism.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPlannerContext } from "../src/planner/context.js";
import { validatePlan } from "../src/planner/schema.js";
import { ModelPlanner } from "../src/planner/model.js";
import { HeuristicPlanner } from "../src/planner/heuristic.js";
import { PipelineEngine } from "../src/pipelines/engine.js";
import { TaskEngine } from "../src/tasks/engine.js";
import { FileTaskStore } from "../src/tasks/store.js";
import { FilePipelineRunStore } from "../src/pipelines/store.js";
import { AgentRegistry } from "../src/agents/index.js";
import { RoleRegistry } from "../src/roles/index.js";
import { validateReport } from "../src/reports/schema.js";
import { aggregateReports } from "../src/reports/aggregate.js";
import type { Plan } from "../src/types/plan.js";
import type { Report } from "../src/types/report.js";

function report(agent: string, severity: "low" | "high", title = "Broken JWT validation"): Report {
  const result = validateReport({
    id: `rep-${agent}`,
    taskId: "t1",
    agent,
    summary: `${agent} summary`,
    findings: [{ id: `f-${agent}`, title, detail: "tokens accepted unsigned", severity }],
    recommendations: ["Verify signatures"],
    createdAt: new Date().toISOString(),
  });
  if (!result.valid) throw new Error("fixture must be valid");
  return result.report;
}

describe("planner inputs (§15)", () => {
  it("assembles task, project context, reports, aggregated findings, memory and constraints", () => {
    const aggregated = aggregateReports([report("kimi", "high"), report("gemini", "low")]);
    const context = buildPlannerContext({
      objective: "harden auth",
      projectContext: "monorepo with services/api",
      reports: [report("kimi", "high")],
      aggregated,
      memory: [{ key: "m", scope: "project", content: "rotating secrets decided" }],
      constraints: ["no breaking API changes", "ship behind a flag"],
    });

    expect(context).toContain("# Task\nharden auth");
    expect(context).toContain("# Project context\nmonorepo with services/api");
    expect(context).toContain("# Agent reports (1 by kimi)");
    expect(context).toContain("# Aggregated findings");
    expect(context).toContain("conflicts: 1"); // disagreement stays visible to the planner
    expect(context).toContain("# Relevant memory");
    expect(context).toContain("# Constraints\n- no breaking API changes");
  });
});

describe("plan validation (§15)", () => {
  const plan: Plan = {
    id: "p1",
    objective: "o",
    summary: "s",
    steps: [{ id: "step-1", title: "Do it", order: 1 }],
    generatedBy: "test",
    createdAt: new Date().toISOString(),
  };

  it("accepts a well-formed plan", () => {
    expect(validatePlan(plan).valid).toBe(true);
  });

  it("rejects empty steps, empty summary, duplicate ids and unknown dependencies", () => {
    expect(validatePlan({ ...plan, steps: [] }).valid).toBe(false);
    expect(validatePlan({ ...plan, summary: "  " }).valid).toBe(false);
    const dup = validatePlan({
      ...plan,
      steps: [
        { id: "s1", title: "a", order: 1 },
        { id: "s1", title: "b", order: 2 },
      ],
    });
    expect(dup.valid).toBe(false);
    if (!dup.valid) expect(dup.issues.some((i) => i.message.includes("duplicate"))).toBe(true);

    const unknownDep = validatePlan({
      ...plan,
      steps: [{ id: "s1", title: "a", order: 1, dependsOn: ["ghost"] }],
    });
    expect(unknownDep.valid).toBe(false);
  });
});

describe("planner output handling (§15)", () => {
  it("accepts a model plan that validates", async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({
        goal: "harden auth",
        summary: "do the work",
        steps: [{ id: "s1", title: "Verify signatures", order: 1, acceptance_criteria: ["unsigned rejected"] }],
      }),
    );
    const plan = await new ModelPlanner({ model: "any-model", chat }).plan({ objective: "x", reports: [] });
    expect(plan.generatedBy).toBe("model:any-model");
    expect(plan.goal).toBe("harden auth");
    expect(plan.steps[0]?.acceptanceCriteria).toEqual(["unsigned rejected"]);
  });

  it("falls back to heuristic planning when model output is rejected", async () => {
    const chat = vi.fn(async () => '{"summary":"no goal","steps":[]}');
    const plan = await new ModelPlanner({
      model: "any-model",
      chat,
      fallback: new HeuristicPlanner(),
    }).plan({ objective: "x", reports: [] });
    expect(plan.generatedBy).toBe("heuristic");
  });

  it("throws a structured error when there is no fallback", async () => {
    const chat = vi.fn(async () => "not json at all");
    try {
      await new ModelPlanner({ model: "any-model", chat }).plan({ objective: "x", reports: [] });
      expect.unreachable("should have thrown");
    } catch (error) {
      const plannerError = error as { code: string; details?: { issues?: unknown[]; reason?: string } };
      expect(plannerError.code).toBe("PLAN_INVALID");
      expect(plannerError.details?.reason).toBeDefined();
    }
  });

  it("heuristic plans surface aggregated conflicts as risks", async () => {
    const aggregated = aggregateReports([report("kimi", "high"), report("gemini", "low")]);
    const plan = await new HeuristicPlanner().plan({
      objective: "x",
      reports: [report("kimi", "high"), report("gemini", "low")],
      aggregated,
    });
    expect(plan.steps.some((s) => s.title.includes("Broken JWT"))).toBe(true);
    expect(plan.risks?.join(" ")).toContain("disagreement");
  });
});

describe("planner independence (§15)", () => {
  it("the planner module references no specific provider", () => {
    const dir = path.resolve(__dirname, "..", "src", "planner");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory() || !full.endsWith(".ts")) continue;
      const source = readFileSync(full, "utf8").toLowerCase();
      for (const vendor of ["openai", "chatgpt", "anthropic", "omnihilbras", "openrouter", "ollama"]) {
        // Comments/docs may mention vendors; code may not depend on them.
        const code = source.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
        if (code.includes(vendor)) offenders.push(`${entry}: ${vendor}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a pipeline plan step receives aggregated findings and constraints", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-planner-v2-"));
    const agent = {
      info: { name: "worker", integration: "process" as const, status: "ready" as const },
      run: async (input: { taskId: string }) => ({
        taskId: input.taskId,
        status: "completed" as const,
        summary: "done",
        reports: [
          {
            id: `${input.taskId}-rep`,
            taskId: input.taskId,
            agent: "worker",
            summary: "found it",
            findings: [{ id: "f1", title: "Broken JWT validation", detail: "unsigned tokens accepted", severity: "high" as const }],
            recommendations: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      cancel: async () => {},
    };
    const agents = new AgentRegistry();
    agents.register(agent);
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
    const chatCalls: string[] = [];
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [{ name: "gw", type: "openai-compatible", baseUrl: "http://gw.test" }],
      store: new FilePipelineRunStore(dir),
      chat: async (_model, messages) => {
        chatCalls.push(messages.map((m) => m.content).join("\n"));
        return JSON.stringify({ goal: "g", summary: "s", steps: [{ id: "s1", title: "fix", order: 1 }] });
      },
    });

    await engine.run(
      {
        id: "planned",
        steps: [
          { id: "research", kind: "research", agents: ["worker"] },
          { id: "plan", kind: "plan", model: "gw:gpt-test", constraints: ["no breaking changes"] },
        ],
      },
      { objective: "audit auth" },
    );

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]).toContain("# Aggregated findings");
    expect(chatCalls[0]).toContain("Broken JWT validation");
    expect(chatCalls[0]).toContain("# Constraints\n- no breaking changes");
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});