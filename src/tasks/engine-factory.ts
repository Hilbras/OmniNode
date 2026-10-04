/** Assembles a TaskEngine from the project configuration (local-first defaults). */
import type { AppConfig } from "../config/index.js";
import { buildAgentRegistry } from "../agents/index.js";
import { buildRoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { TaskEngine } from "./engine.js";
import { FileTaskStore } from "./store.js";

export function createTaskEngine(config: AppConfig, log: Logger = logger, directory?: string): TaskEngine {
  return new TaskEngine({
    agents: buildAgentRegistry(config, log),
    roles: buildRoleRegistry(config),
    store: new FileTaskStore(directory),
    log,
  });
}
