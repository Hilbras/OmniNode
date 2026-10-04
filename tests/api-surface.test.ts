/**
 * Guards the public API surface: every runtime export named in
 * docs/API.md must remain exported (see docs/API_STABILITY.md). A removal
 * fails here before it ships.
 */
import { describe, expect, it } from "vitest";
import * as omninode from "../src/index.js";

const STABLE_RUNTIME_EXPORTS = [
  // config
  "loadConfig", "findConfigFile", "expandEnvRefs", "defaultProjectConfigYaml",
  // providers
  "createProvider", "OpenAICompatibleProvider", "OmniHilbrasProvider",
  "resolveApiKey", "authHeaders", "requestJson",
  // model registry
  "ModelRegistry", "registryKey",
  // agents
  "createAgent", "buildAgentRegistry", "ProcessAgent", "AgentRegistry",
  "composeTaskText", "buildChildEnv",
  // roles
  "RoleRegistry", "buildRoleRegistry",
  // tasks
  "TaskEngine", "createTaskEngine", "FileTaskStore",
  // pipelines
  "PipelineEngine", "buildPipelineEngine", "createDefaultChatFn", "FilePipelineRunStore",
  // reports
  "ReportService", "extractReportFromText", "aggregateReports", "similar", "FileReportStore",
  // planner
  "buildPlanner", "ModelPlanner", "HeuristicPlanner", "parsePlanJson", "buildPlannerContext",
  "FilePlanStore",
  // memory
  "createMemoryProvider", "LocalMemoryProvider", "RememberaMemoryProvider", "MemoryService",
  // persistence
  "JsonFileStore", "ProjectStores",
  // audit / logging / errors
  "FileAuditLog", "Logger", "ConsoleLogSink", "logger",
  "OmniNodeError", "ConfigError", "ProviderError", "AgentError", "TaskError",
  "PipelineError", "PlannerError", "ProtocolError", "MemoryError", "isOmniNodeError",
  // misc
  "OMNINODE_VERSION",
] as const;

describe("public API surface", () => {
  it.each(STABLE_RUNTIME_EXPORTS)("exports %s", (name) => {
    expect(omninode).toHaveProperty(name);
  });

  it("version is a non-empty string", () => {
    expect(typeof omninode.OMNINODE_VERSION).toBe("string");
    expect(omninode.OMNINODE_VERSION.length).toBeGreaterThan(0);
  });
});