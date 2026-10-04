import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { PipelineError } from "../../errors/index.js";
import { buildPipelineEngine } from "../../pipelines/index.js";
import type { PipelineDefinition } from "../../types/pipeline.js";

export function registerPipelineCommands(program: Command): void {
  const pipeline = program
    .command("pipeline")
    .description("Run multi-step AI pipelines defined in omninode.yaml (§14).");

  pipeline
    .command("list")
    .description("List configured pipelines.")
    .action(async () => {
      const config = loadConfig();
      const pipelines = config.project.pipelines;
      if (pipelines.length === 0) {
        console.log("No pipelines configured. Add one under `project.pipelines` in omninode.yaml.");
        return;
      }
      for (const def of pipelines) {
        const name = def.name ? `  ${def.name}` : "";
        console.log(`${def.id}${name}  ${def.steps.length} step(s)`);
      }
    });

  pipeline
    .command("run <id> [objective]")
    .description(
      "Run a pipeline. The objective argument overrides the definition's default objective.",
    )
    .action(async (id: string, objective: string | undefined) => runPipelineAction(id, objective));

  pipeline
    .command("retry <run-id> [objective]")
    .description(
      "Error recovery: re-run a recorded pipeline run as a new run, reusing its objective.",
    )
    .action(async (runId: string, objective: string | undefined) => {
      const config = loadConfig();
      const engine = buildPipelineEngine(config);
      const previous = await engine.get(runId);
      if (!previous) {
        throw new PipelineError(
          "PIPELINE_NOT_FOUND",
          `Pipeline run "${runId}" does not exist in this project's run store.`,
        );
      }
      const def = config.project.pipelines.find((p) => p.id === previous.pipelineId);
      if (!def) {
        throw new PipelineError(
          "PIPELINE_NOT_FOUND",
          `Pipeline "${previous.pipelineId}" (run ${runId}) is no longer configured in omninode.yaml.`,
        );
      }
      await runPipelineAction(def.id, objective ?? previous.objective);
    });

  pipeline
    .command("runs <id>")
    .description("List recorded runs of a pipeline.")
    .action(async (id: string) => {
      const config = loadConfig();
      const engine = buildPipelineEngine(config);
      const runs = await engine.listRuns({ pipelineId: id });
      if (runs.length === 0) {
        console.log(`No recorded runs for pipeline "${id}".`);
        return;
      }
      for (const run of runs) {
        console.log(`${run.id}  ${run.status.padEnd(10)} ${run.startedAt ?? "?"}`);
      }
    });

  pipeline
    .command("status <run-id>")
    .description("Show the recorded state of a pipeline run.")
    .action(async (runId: string) => {
      const config = loadConfig();
      const engine = buildPipelineEngine(config);
      const run = await engine.get(runId);
      if (!run) {
        throw new PipelineError(
          "PIPELINE_NOT_FOUND",
          `Pipeline run "${runId}" does not exist in this project's run store.`,
        );
      }
      console.log(`  id:         ${run.id}`);
      console.log(`  pipeline:   ${run.pipelineId}`);
      console.log(`  status:     ${run.status}`);
      console.log(`  started:    ${run.startedAt ?? "?"}`);
      if (run.finishedAt) console.log(`  finished:   ${run.finishedAt}`);
      if (run.resultSummary) console.log(`  result:     ${run.resultSummary}`);
      for (const stepRun of run.stepRuns) {
        console.log(`  [${stepRun.stepId}] ${stepRun.status}`);
      }
      if (run.reports && run.reports.length > 0) {
        console.log(`  reports:    ${run.reports.length}`);
      }
    });
}

async function runPipelineAction(id: string, objective: string | undefined): Promise<void> {
  const config = loadConfig();
  const def = findPipeline(config, id);
  const engine = buildPipelineEngine(config);
  console.log(
    `Running pipeline "${def.id}" (${def.steps.length} step(s))${objective ? ` — "${objective}"` : ""}...`,
  );
  const finished = await engine.run(def, {
    ...(objective !== undefined ? { objective } : {}),
    onStep: (stepRun) => {
      const suffix = stepRun.error ? ` — ${stepRun.error}` : "";
      console.log(`  [${stepRun.stepId}] ${stepRun.status}${suffix}`);
    },
  });
  if (finished.reports && finished.reports.length > 0) {
    console.log(`  reports: ${finished.reports.length} structured report(s)`);
  }
  if (finished.combinedReportId) {
    console.log(`  combined report: ${finished.combinedReportId}`);
  }
  if (finished.planId) {
    console.log(`  plan: ${finished.planId}`);
  }
  if (finished.resultSummary) {
    console.log(`  result: ${finished.resultSummary}`);
  }
  console.log(`Pipeline ${finished.status}. Run id: ${finished.id}`);
  if (finished.status !== "completed") process.exitCode = 1;
}

/** Top-level `omninode run` — a workflow alias of `pipeline run` (§28). */
export function registerRunAlias(program: Command): void {
  program
    .command("run <id> [objective]")
    .description("Alias of `omninode pipeline run` — execute a configured pipeline end to end.")
    .action(async (id: string, objective: string | undefined) => runPipelineAction(id, objective));
}

function findPipeline(config: ReturnType<typeof loadConfig>, id: string): PipelineDefinition {
  const def = config.project.pipelines.find((p) => p.id === id);
  if (!def) {
    const available = config.project.pipelines.map((p) => p.id).join(", ") || "(none)";
    throw new PipelineError(
      "PIPELINE_NOT_FOUND",
      `Pipeline "${id}" is not configured. Configured pipelines: ${available}.`,
    );
  }
  return def;
}
