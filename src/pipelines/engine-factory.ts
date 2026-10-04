/** Assembles a PipelineEngine from the project configuration (local-first defaults). */
import type { AppConfig } from "../config/index.js";
import { buildAgentRegistry } from "../agents/index.js";
import { buildRoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { TaskEngine } from "../tasks/index.js";
import { FileTaskStore } from "../tasks/store.js";
import { PipelineEngine, createDefaultChatFn } from "./engine.js";
import { FilePipelineRunStore } from "./store.js";

export function buildPipelineEngine(config: AppConfig, log: Logger = logger): PipelineEngine {
  const agents = buildAgentRegistry(config, log);
  const roles = buildRoleRegistry(config);
  const tasks = new TaskEngine({
    agents,
    roles,
    store: new FileTaskStore(),
    log,
  });
  return new PipelineEngine({
    tasks,
    agents,
    roles,
    providers: config.project.providers,
    store: new FilePipelineRunStore(),
    chat: createDefaultChatFn(config.project.providers),
    log,
  });
}
