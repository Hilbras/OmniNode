import type { AppConfig } from "../config/index.js";
import { buildAgentRegistry } from "../agents/index.js";
import { createMemoryProvider, MemoryService } from "../memory/index.js";
import { buildPlanner } from "../planner/index.js";
import { FilePlanStore } from "../planner/store.js";
import { buildRoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { ReportService } from "../reports/index.js";
import { FileReportStore } from "../reports/store.js";
import { TaskEngine } from "../tasks/index.js";
import { FileTaskStore } from "../tasks/store.js";
import { PipelineEngine, createDefaultChatFn } from "./engine.js";
import { FilePipelineRunStore } from "./store.js";

export function buildPipelineEngine(config: AppConfig, log: Logger = logger): PipelineEngine {
  const agents = buildAgentRegistry(config, log);
  const roles = buildRoleRegistry(config);
  const chat = createDefaultChatFn(config.project.providers);
  const tasks = new TaskEngine({
    agents,
    roles,
    store: new FileTaskStore(),
    ...(config.project.memory !== undefined
      ? { memory: new MemoryService(createMemoryProvider(config.project.memory), log) }
      : {}),
    log,
  });
  return new PipelineEngine({
    tasks,
    agents,
    roles,
    providers: config.project.providers,
    store: new FilePipelineRunStore(),
    chat,
    ...(config.project.planner !== undefined
      ? { planner: buildPlanner(config.project.planner, chat, log) }
      : {}),
    plans: new FilePlanStore(),
    reports: new ReportService(new FileReportStore(), log),
    log,
  });
}
