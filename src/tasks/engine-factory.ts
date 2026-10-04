/** Assembles a TaskEngine from the project configuration (local-first defaults). */
import type { AppConfig } from "../config/index.js";
import { FileAuditLog } from "../audit/index.js";
import { buildAgentRegistry } from "../agents/index.js";
import { createMemoryProvider, MemoryService } from "../memory/index.js";
import { buildRoleRegistry } from "../roles/index.js";
import { logger, type Logger } from "../logger/index.js";
import { TaskEngine } from "./engine.js";
import { FileTaskStore } from "./store.js";

export function createTaskEngine(config: AppConfig, log: Logger = logger, directory?: string): TaskEngine {
  const agents = buildAgentRegistry(config, log);
  const roles = buildRoleRegistry(config);
  return new TaskEngine({
    agents,
    roles,
    store: new FileTaskStore(directory),
    ...(config.project.memory !== undefined
      ? { memory: new MemoryService(createMemoryProvider(config.project.memory), log) }
      : {}),
    audit: new FileAuditLog(),
    log,
  });
}
