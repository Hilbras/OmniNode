/**
 * `omninode <subject> inspect` — post-hoc diagnostics (roadmap §18): everything
 * known about a task, pipeline run, agent or provider, so a failed execution
 * can be understood after the fact. `--json` emits the raw records.
 */
import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { buildAgentRegistry } from "../../agents/index.js";
import { buildRoleRegistry } from "../../roles/index.js";
import { createMemoryProvider, MemoryService } from "../../memory/index.js";
import { OmniNodeError } from "../../errors/index.js";
import { FilePipelineRunStore } from "../../pipelines/store.js";
import { FileTaskStore } from "../../tasks/store.js";
import { resolveEnvPolicy } from "../../agents/env.js";

function emit(json: boolean, payload: unknown, render: () => void): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  render();
}

function jsonOption(command: Command): Command {
  return command.option("--json", "Emit the raw record as JSON.");
}

/** Registers `task inspect` on the existing task group. */
export function registerTaskInspect(taskGroup: Command): void {
  jsonOption(
    taskGroup
      .command("inspect <id>")
      .description("Show a task with its execution history, result and report references.")
      .action(async (id: string, options: { json?: boolean }) => {
        const tasks = await new FileTaskStore().list();
        const task = tasks.find((t) => t.id === id);
        if (!task) throw new OmniNodeError("TASK_NOT_FOUND", `No task "${id}" in this project's store.`);
        emit(options.json ?? false, task, () => {
          console.log(`Task ${task.id}`);
          console.log(`  status:    ${task.status}${task.attempt > 0 ? ` (attempt ${task.attempt})` : ""}`);
          if (task.project) console.log(`  project:   ${task.project}`);
          if (task.pipelineId) console.log(`  pipeline:  ${task.pipelineId}`);
          console.log(`  objective: ${task.objective}`);
          if (task.role) console.log(`  role:      ${task.role}`);
          if (task.agent) console.log(`  agent:     ${task.agent}`);
          console.log(`  created:   ${task.createdAt}`);
          console.log(`  updated:   ${task.updatedAt}`);
          if (task.lastError) console.log(`  lastError: ${task.lastError}`);
          if (task.executions && task.executions.length > 0) {
            console.log("  executions:");
            for (const execution of task.executions) {
              console.log(
                `    #${execution.attempt} ${execution.outcome} (${execution.executionId})` +
                  `${execution.error ? ` — ${execution.error}` : ""}`,
              );
            }
          }
          if (task.result?.summary) console.log(`  summary:   ${task.result.summary}`);
          if (task.result?.reports && task.result.reports.length > 0) {
            console.log(`  reports:   ${task.result.reports.length}`);
            for (const report of task.result.reports) {
              console.log(`    - [${report.agent}] ${report.summary}`);
              for (const finding of report.findings) {
                console.log(`        · [${finding.severity ?? "info"}] ${finding.title}`);
              }
            }
          }
        });
      }),
  );
}

/** Registers `pipeline inspect` on the pipeline group. */
export function registerPipelineInspect(pipelineGroup: Command): void {
  jsonOption(
    pipelineGroup
      .command("inspect <run-id>")
      .description("Show a pipeline run with per-step status and artifact references.")
      .action(async (runId: string, options: { json?: boolean }) => {
        const run = await new FilePipelineRunStore().get(runId);
        if (!run) throw new OmniNodeError("PIPELINE_NOT_FOUND", `No pipeline run "${runId}" in this project's store.`);
        emit(options.json ?? false, run, () => {
          console.log(`Pipeline run ${run.id}  (${run.pipelineId})`);
          console.log(`  status:     ${run.status}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}`);
          if (run.objective) console.log(`  objective:  ${run.objective}`);
          console.log(`  started:    ${run.startedAt ?? "?"}`);
          if (run.finishedAt) console.log(`  finished:   ${run.finishedAt}`);
          if (run.planId) console.log(`  plan:       ${run.planId}`);
          if (run.combinedReportId) console.log(`  combined:   ${run.combinedReportId}`);
          if (run.resultSummary) console.log(`  result:     ${run.resultSummary}`);
          console.log("  steps:");
          for (const step of run.stepRuns) {
            const stepTaskIds = step.taskIds ?? [];
            const tasks = stepTaskIds.length > 0 ? ` tasks=${stepTaskIds.join(",")}` : "";
            console.log(`    ${step.stepId.padEnd(14)} ${step.status}${tasks}${step.error ? ` — ${step.error}` : ""}`);
          }
        });
      }),
  );
}

/** Registers `agent inspect` on the agent group. */
export function registerAgentInspect(agentGroup: Command): void {
  jsonOption(
    agentGroup
      .command("inspect <name>")
      .description("Show an agent's effective configuration and recent tasks.")
      .action(async (name: string, options: { json?: boolean }) => {
        const config = loadConfig();
        const agentConfig = config.project.agents.find((a) => a.name === name);
        if (!agentConfig) throw new OmniNodeError("AGENT_NOT_FOUND", `No agent "${name}" is configured.`);
        const registry = buildAgentRegistry(config);
        const agent = registry.get(name);
        const recent = (await new FileTaskStore().list())
          .filter((task) => task.agent === name)
          .slice(-5)
          .map((task) => ({ id: task.id, status: task.status, updatedAt: task.updatedAt }));
        const payload = {
          config: agentConfig,
          effective: agent?.info,
          envPolicy: resolveEnvPolicy(agentConfig),
          recentTasks: recent,
        };
        emit(options.json ?? false, payload, () => {
          console.log(`Agent ${name}`);
          console.log(`  integration: ${agentConfig.integration}`);
          console.log(`  command:     ${agentConfig.command ?? "(none)"}`);
          console.log(`  input mode:  ${agentConfig.inputMode ?? "stdin"}`);
          console.log(`  env policy:  ${resolveEnvPolicy(agentConfig)}`);
          if (agentConfig.cwd) console.log(`  working dir: ${agentConfig.cwd}`);
          if (agentConfig.timeoutMs) console.log(`  timeout:     ${agentConfig.timeoutMs}ms`);
          if (agentConfig.maxOutputBytes) console.log(`  max output:  ${agentConfig.maxOutputBytes} bytes/stream`);
          if (agentConfig.allowExternalCwd) console.log(`  external cwd allowed`);
          console.log(`  recent tasks: ${recent.map((t) => `${t.id}:${t.status}`).join(", ") || "(none)"}`);
        });
      }),
  );
}

/** Registers `provider inspect` on the provider group. */
export function registerProviderInspect(providerGroup: Command): void {
  jsonOption(
    providerGroup
      .command("inspect <name>")
      .description("Show a provider's authentication status and capabilities.")
      .action(async (name: string, options: { json?: boolean }) => {
        const config = loadConfig();
        const providerConfig = config.project.providers.find((p) => p.name === name);
        if (!providerConfig) throw new OmniNodeError("PROVIDER_NOT_FOUND", `No provider "${name}" is configured.`);
        const { createProvider } = await import("../../providers/index.js");
        const provider = createProvider(providerConfig);
        const payload = {
          config: providerConfig,
          providerId: provider.providerId,
          authentication: provider.authentication,
          capabilities: providerConfig.capabilities ?? [],
          memoryConfigured: config.project.memory
            ? { provider: config.project.memory.provider, required: config.project.memory.required ?? false }
            : undefined,
          memoryEntries: config.project.memory
            ? await new MemoryService(createMemoryProvider(config.project.memory)).providerRef.query({ limit: 10_000 }).then((e) => e.length)
            : undefined,
          roles: buildRoleRegistry(config).list().length,
        };
        emit(options.json ?? false, payload, () => {
          console.log(`Provider ${name}`);
          console.log(`  providerId:    ${provider.providerId}`);
          console.log(`  type:          ${providerConfig.type}`);
          console.log(`  base URL:      ${providerConfig.baseUrl}`);
          console.log(`  auth:          ${provider.authentication.method}${provider.authentication.envVar ? ` ($${provider.authentication.envVar})` : ""}`);
          console.log(`  credentials:   ${provider.authentication.configured ? "configured" : "MISSING"}`);
          if (providerConfig.capabilities?.length) {
            console.log(`  capabilities:  ${providerConfig.capabilities.join(", ")}`);
          }
        });
      }),
  );
}
