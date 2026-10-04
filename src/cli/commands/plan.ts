import type { Command } from "commander";
import { OmniNodeError } from "../../errors/index.js";
import { FilePlanStore } from "../../planner/store.js";
import { truncate } from "./shared.js";

export function registerPlanCommands(program: Command): void {
  const plan = program
    .command("plan")
    .description("Inspect implementation plans produced by the planner layer (§18).");

  plan
    .command("list")
    .description("List stored plans.")
    .option("--run <pipelineRunId>", "Only plans for this pipeline run.")
    .option("--json", "Emit plans as JSON.")
    .action(async (options: { run?: string; json?: boolean }) => {
      const store = new FilePlanStore();
      const plans = await store.list({
        ...(options.run !== undefined ? { pipelineRunId: options.run } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(plans, null, 2));
        return;
      }
      if (plans.length === 0) {
        console.log("No plans stored yet. Run a pipeline with a plan step to generate one.");
        return;
      }
      for (const p of plans) {
        console.log(`${p.id}  ${p.steps.length} step(s)  by ${p.generatedBy}  ${truncate(p.summary, 50)}`);
      }
    });

  plan
    .command("show <id>")
    .description("Show a stored implementation plan in full.")
    .action(async (id: string) => {
      const store = new FilePlanStore();
      const found = await store.get(id);
      if (!found) {
        throw new OmniNodeError("PLAN_INVALID", `Plan "${id}" was not found in the plan store.`, {
          details: { id },
        });
      }
      console.log(`Plan ${found.id}`);
      console.log(`  objective: ${found.objective}`);
      console.log(`  by:        ${found.generatedBy}`);
      console.log(`  summary:   ${found.summary}`);
      console.log("  steps:");
      for (const step of [...found.steps].sort((a, b) => a.order - b.order)) {
        const targets = step.targets && step.targets.length > 0 ? ` [${step.targets.join(", ")}]` : "";
        console.log(`    ${step.order}. ${step.title}${targets}`);
        if (step.description) console.log(`       ${truncate(step.description, 100)}`);
        for (const criterion of step.acceptanceCriteria ?? []) {
          console.log(`       accept: ${criterion}`);
        }
      }
      if (found.risks && found.risks.length > 0) {
        console.log("  risks:");
        for (const risk of found.risks) {
          console.log(`    - ${risk}`);
        }
      }
    });
}
