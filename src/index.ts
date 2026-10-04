/**
 * OmniNode public API.
 *
 * Only intentionally public APIs are exported here (roadmap §23, Public
 * Exports). Implementation details stay reachable only inside the package —
 * tests and internal modules import their own paths directly, and
 * `tests/public-api.test.ts` guards this surface.
 */

// Types are the documented public contract.
export type * from "./types/index.js";

// Errors
export {
  OmniNodeError,
  isOmniNodeError,
  ConfigError,
  ProviderError,
  AgentError,
  TaskError,
  PipelineError,
  PlannerError,
  ProtocolError,
  MemoryError,
} from "./errors/index.js";

// Logging
export { Logger, ConsoleLogSink, configureLogger, logger } from "./logger/index.js";
export type { LogLevel, LogFormat, LogSink, LoggerOptions } from "./logger/index.js";

// Configuration
export {
  loadConfig,
  loadConfigDetailed,
  findConfigFile,
  expandEnvRefs,
  scanForInlineSecrets,
  describeSecretFindings,
  configDiagnostics,
  defaultProjectConfigYaml,
  appConfigSchema,
  projectConfigSchema,
  providerConfigSchema,
  agentConfigSchema,
  roleConfigSchema,
  pipelineConfigSchema,
  pipelineStepConfigSchema,
  plannerConfigSchema,
} from "./config/index.js";
export type { AppConfig, LoadConfigOptions, LoadConfigResult } from "./config/index.js";

// Providers
export {
  createProvider,
  OPENAI_COMPATIBLE_TYPES,
  OpenAICompatibleProvider,
  OmniHilbrasProvider,
  resolveApiKey,
  authHeaders,
  requestJson,
  providerHttpError,
  providerTransportError,
  kindFromStatus,
  isRetryable,
  isTimeoutError,
  isNetworkError,
  extractMessage,
  parseRetryAfter,
} from "./providers/index.js";
export type { CreateProviderOptions } from "./providers/factory.js";

// Model registry
export { ModelRegistry, registryKey } from "./registry/index.js";

// Agents
export {
  createAgent,
  buildAgentRegistry,
  defaultAgentAdapters,
  ProcessAgent,
  ProcessAgentAdapter,
  AgentAdapterRegistry,
  AgentRegistry,
  composeTaskText,
  killTree,
  sanitizeChunk,
  describeExit,
  DEFAULT_MAX_OUTPUT_BYTES,
  resolveEnvPolicy,
  buildChildEnv,
  validateWorkingDirectory,
} from "./agents/index.js";
export type { IAgentAdapter, CwdValidation, EnvPolicy } from "./agents/index.js";

// Roles
export { RoleRegistry, buildRoleRegistry } from "./roles/index.js";

// Tasks
export { TaskEngine, createTaskEngine, FileTaskStore } from "./tasks/index.js";
export type {
  TaskEngineOptions,
  RunTaskOptions,
  CreateTaskInput,
  TaskStore,
  TaskStoreFilter,
} from "./tasks/index.js";

// Pipelines
export {
  PipelineEngine,
  buildPipelineEngine,
  createDefaultChatFn,
  FilePipelineRunStore,
  budgetContext,
  DEFAULT_MAX_PARALLEL_STEPS,
  MAX_COMBINED_CONTEXT_CHARS,
} from "./pipelines/index.js";
export type {
  PipelineRunStore,
  PipelineRunFilter,
  DefaultChatOptions,
} from "./pipelines/index.js";
export type { IPipelineExecutor, RunPipelineOptions } from "./pipelines/engine.js";

// Reports
export {
  ReportService,
  extractReportFromText,
  aggregateReports,
  detectConflicts,
  similar,
  validateReport,
  normalizeEvidence,
  normalizeFinding,
  FileReportStore,
  MAX_REPORT_BYTES,
  MAX_COMBINED_FINDINGS,
} from "./reports/index.js";
export type { ReportStore, ReportFilter, CombinedReportFilter } from "./reports/index.js";

// Planner
export {
  ModelPlanner,
  HeuristicPlanner,
  buildPlanner,
  buildPlannerContext,
  parsePlanJson,
  validatePlan,
  planJsonSchema,
  FilePlanStore,
} from "./planner/index.js";
export type {
  IPlanner,
  PlanRequest,
  PlanStore,
  PlanFilter,
  PlanValidationResult,
  PlanValidationIssue,
} from "./planner/index.js";
export type { ModelPlannerOptions } from "./planner/model.js";

// Memory
export {
  createMemoryProvider,
  LocalMemoryProvider,
  RememberaMemoryProvider,
  MemoryService,
  MAX_CONTEXT_CHARS,
} from "./memory/index.js";
export type {
  RememberaConfig,
  MemoryTaskContext,
  MemoryServiceOptions,
  MemoryContextQuery,
  MemoryProviderConfig,
} from "./memory/index.js";

// Audit & persistence
export { FileAuditLog, DEFAULT_AUDIT_MAX_BYTES } from "./audit/index.js";
export type { AuditEvent, AuditAction, AuditSink } from "./audit/index.js";
export {
  JsonFileStore,
  ProjectStores,
  migrateProjectStores,
  SCHEMA_VERSION,
  inspectDocument,
  readDocument,
  writeFileAtomic,
} from "./persistence/index.js";
export type {
  JsonDocument,
  JsonFileStoreOptions,
  DocumentState,
  Durability,
  MigrationReport,
  PipelineStore,
  MemoryStore,
  AuditStore,
} from "./persistence/index.js";

// Agent protocol v2
export {
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  MAX_MESSAGE_BYTES,
  isSupportedProtocol,
  envelope,
  newMessageId,
  encodeMessage,
  decodeMessage,
  validateEnvelope,
  ProtocolDecoder,
  ProtocolSession,
  parseHello,
  buildHello,
  buildHelloAck,
} from "./agent-protocol/index.js";
export type {
  ProtocolEnvelope,
  ProtocolMessageType,
  ProtocolNodeToAgentType,
  ProtocolAgentToNodeType,
  ArtifactPayload,
  QuestionPayload,
  ReportPayload,
  AskedQuestion,
  AgentDescriptor,
  HelloResult,
  DecodeResult,
  ProtocolViolation,
  ProtocolViolationCode,
  SessionIds,
  QuestionResponder,
} from "./agent-protocol/index.js";

export { OMNINODE_VERSION } from "./version.js";
