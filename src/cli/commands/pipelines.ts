import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { appConfigSchema, findConfigFile, loadConfig, pipelineConfigSchema } from "../../config/index.js";
import { OmniNodeError } from "../../errors/index.js";
import { PipelineError } from "../../errors/index.js";
import { buildPipelineEngine } from "../../pipelines/index.js";
import type { PipelineDefinition } from "../../types/pipeline.js";
import { registerPipelineInspect } from "./inspect.js";
import { exitCodeForStatus } from "../exit-codes.js";

export function registerPipelineCommands(program: Command): void {
  const pipeline = program
    .command("pipeline")
    .description("Run multi-step AI pipelines defined in omninode.yaml (§14).");

  pipeline
    .command("list")
    .description("List configured pipelines.")
    .option("--json", "Emit pipelines as JSON.")
    .action(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const pipelines = config.project.pipelines;
      if (options.json) {
        console.log(JSON.stringify(config.project.pipelines, null, 2));
        return;
      }
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
    .command("cancel <run-id>")
    .description("Request cancellation of a pipeline run (stops scheduling and cancels running tasks).")
    .action(async (runId: string) => {
      const config = loadConfig();
      const engine = buildPipelineEngine(config);
      await engine.cancel(runId);
      console.log(`Cancellation requested for run ${runId}.`);
      console.log("A run executing in another process stops at its next check point.");
    });

  pipeline
    .command("create <id>")
    .description("Create a pipeline from a YAML/JSON file and append it to omninode.yaml.")
    .requiredOption("--from <file>", "File containing { objective?, steps: [...] } (YAML or JSON).")
    .action(async (id: string, options: { from: string }) => {
      await createPipelineFromFile(id, options.from);
    });

  pipeline
    .command("validate <id>")
    .description("Validate a pipeline definition before running it (§9.5).")
    .action(async (id: string) => {
      const config = loadConfig();
      const def = findPipeline(config, id);
      const engine = buildPipelineEngine(config);
      engine.validate(def);
      console.log(`Pipeline "${def.id}" is valid (${def.steps.length} step(s)).`);
      for (const step of def.steps) {
        const deps = step.dependsOn?.join(", ") ?? "(previous step)";
        console.log(`  ${step.id}  kind=${step.kind}  depends_on=${deps}`);
      }
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
        const note = isInterrupted(run) ? "  (interrupted — process gone before finish)" : "";
        console.log(`${run.id}  ${run.status.padEnd(10)} ${run.startedAt ?? "?"}${note}`);
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
      console.log(`  attempt:   ${run.attempt}`);
      if (run.cancellationRequested) {
        console.log(`  cancellation requested at ${run.cancellationRequestedAt ?? "?"}`);
      }
      if (isInterrupted(run)) {
        console.log("  note:       this run looks interrupted (no finishedAt) — retry with `pipeline retry`");
      }
      if (run.resultSummary) console.log(`  result:     ${run.resultSummary}`);
      for (const stepRun of run.stepRuns) {
        console.log(`  [${stepRun.stepId}] ${stepRun.status}`);
      }
      if (run.reports && run.reports.length > 0) {
        console.log(`  reports:    ${run.reports.length}`);
      }
    });
  registerPipelineInspect(pipeline);
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
  process.exitCode = exitCodeForStatus(finished.status);
}

/** Top-level `omninode run` — a workflow alias of `pipeline run` (§28). */
export function registerRunAlias(program: Command): void {
  program
    .command("run <id> [objective]")
    .description("Alias of `omninode pipeline run` — execute a configured pipeline end to end.")
    .action(async (id: string, objective: string | undefined) => runPipelineAction(id, objective));
}

async function createPipelineFromFile(id: string, file: string): Promise<void> {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new OmniNodeError("CONFIG_NOT_FOUND", "No omninode.yaml found. Run `omninode init` first.");
  }
  let definition: unknown;
  try {
    definition = parseDocument(readFileSync(file, "utf8")).toJS();
  } catch (error) {
    throw new PipelineError("PIPELINE_INVALID", `Could not read pipeline definition from ${file}.`, {
      cause: error,
    });
  }
  const candidate = pipelineConfigSchema.safeParse({ id, ...(definition as object) });
  if (!candidate.success) {
    const issues = candidate.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new PipelineError("PIPELINE_INVALID", `Invalid pipeline definition: ${issues}`);
  }
  // Reject duplicates and structural problems before touching the config.
  const engine = buildPipelineEngine(loadConfig());
  engine.validate({ id, ...(candidate.data as object) } as never);

  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (doc.getIn(["project", "pipelines"]) === undefined) {
    doc.setIn(["project", "pipelines"], [candidate.data]);
  } else {
    doc.addIn(["project", "pipelines"], candidate.data);
  }
  const validated = appConfigSchema.safeParse(doc.toJS());
  if (!validated.success) {
    throw new PipelineError("PIPELINE_INVALID", "Adding this pipeline would produce an invalid configuration.");
  }
  writeFileSync(configPath, doc.toString(), "utf8");
  console.log(`Created pipeline "${id}" (${candidate.data.steps.length} step(s)) in ${configPath}.`);
  console.log(`Run it with: omninode pipeline run ${id} "<objective>"`);
}

/** A run left "running" with no finishedAt is assumed interrupted (§9.6). */
function isInterrupted(run: { status: string; finishedAt?: string }): boolean {
  return run.status === "running" && run.finishedAt === undefined;
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
