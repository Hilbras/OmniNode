# Public API Inventory

The package root (`@hilbras/omninode`) is the entire public surface. Only
intentional APIs are exported from it; implementation details live in their
modules and are not reachable by consumers (the package `exports` map exposes
the root only).

Two CI guards keep it that way:

- `tests/api-surface.test.ts` — every documented export still exists.
- `tests/public-api.test.ts` — internal helpers (`keywords`, `applyDefaults`,
  `decodeStream`, …) stay unexported, the surface stays within its expected
  size, and `createProvider` / `createAgent` / `createMemoryProvider` validate
  their arguments at runtime for callers who bypass the configuration schema.

Everything exported from the package root, grouped by subsystem, with the
stability tier from [API_STABILITY.md](API_STABILITY.md).

## Types (`src/types`)

| Export | Description | Tier |
| --- | --- | --- |
| `ProviderConfig`, `ProviderStatus`, `IProvider`, `IChatProvider` | provider abstraction, model discovery, chat | Stable |
| `ModelInfo`, `ModelCapabilities` | normalized model registry entries | Stable |
| `AgentConfig`, `AgentInfo`, `AgentTaskInput`, `AgentTaskOutput`, `IAgent`, `AgentInputMode` | CLI agent abstraction and process adapter contract | Stable |
| `RoleDefinition` | provider-independent roles | Stable |
| `Task`, `TaskStatus`, `TaskContext`, `TaskResult`, `ExecutionRecord` | task model, lifecycle states and execution history | Stable |
| `PipelineDefinition`, `PipelineStep`, `PipelineRun`, `PipelineStepRun` | pipeline definitions and run records | Stable |
| `Plan`, `PlanStep` | planner output schema | Stable |
| `Report`, `Finding`, `Confidence`, `Evidence`, `EvidenceKind`, `EvidenceInput`, `FindingOrigin`, `ReportArtifact`, `CombinedReport`, `AggregatedFinding`, `FindingSource`, `ReportConflict`, `ConflictPosition` | report model (v2) | Stable |
| `validateReport`, `normalizeEvidence`, `normalizeFinding`, `ReportValidationResult`, `detectConflicts` | report validation & conflict detection (§13–§14) | Stable |
| `MemoryEntry`, `MemoryQuery`, `MemoryScope`, `MemoryCategory`, `MemoryProviderMetadata`, `IMemoryProvider` | memory contract (v2) | Stable |
| `MemoryTaskContext`, `MemoryServiceOptions`, `MemoryContextQuery`, `MAX_CONTEXT_CHARS`, `CONTEXT_TRUNCATION_MARKER` | context manager, budgeted context result (with `originalSize`/`finalSize`/`truncated`) and the explicit truncation marker; `defaultSearch`/`defaultMetadata` remain internal | Stable |
| `Project` | project entity | Stable |
| `ChatMessage`, `ChatRequest`, `ChatResponse`, `ChatRole`, `ChatUsage`, `ChatFn`, `ChatStreamChunk` | chat contracts (incl. streaming chunks); `ChatFn` was re-exported from `pipelines` in v1 and remains so | Stable |
| `MessageEnvelope`, `AgentToNodeMessage`, `NodeToAgentMessage` | JSON-lines agent protocol envelope | Experimental |
| `AuditEvent`, `AuditAction`, `AuditSink`, `FileAuditLog` | append-only correlated audit log (§18) | Stable |
| `Logger`, `ConsoleLogSink`, `LogSink`, `LogLevel`, `LogFormat`, `configureLogger` | logging (text or JSON lines) | Stable |

## Agent Protocol v2 (`src/agent-protocol`)

`PROTOCOL_V2`, `SUPPORTED_PROTOCOL_VERSIONS`, `isSupportedProtocol`,
`MAX_MESSAGE_BYTES`, `envelope`, `newMessageId`, `decodeMessage`,
`encodeMessage`, `validateEnvelope`, `ProtocolDecoder`, `ProtocolSession`,
`parseHello`, `buildHello`, `buildHelloAck`, `decodeStream`,
`requireCompletion`, and types (`ProtocolEnvelope`, `AgentDescriptor`,
`DecodeResult`, `ProtocolViolation`, `AskedQuestion`, `ArtifactPayload`, …) —
Stable. Spec: docs/PROTOCOL.md.

## Errors (`src/errors`)

`OmniNodeError` (stable, carries a stable `code` union), plus subclasses
`ConfigError`, `ProviderError`, `AgentError`, `TaskError`, `PipelineError`,
`PlannerError`, `ProtocolError`, `MemoryError` — Stable. Message text is not
part of the contract.

## Configuration (`src/config`)

`loadConfig`, `loadConfigDetailed`, `LoadConfigResult`, `findConfigFile`,
`expandEnvRefs`, `scanForInlineSecrets`, `describeSecretFindings`,
`configDiagnostics`, `findConfigV1Patterns`, `applyConfigMigration`, `mergeConfig`, `resolveProfile`, `userConfigPath`,
`KNOWN_PROFILES`, `ConfigSources`, the zod schemas (`appConfigSchema`, `providerConfigSchema`,
`agentConfigSchema`, `roleConfigSchema`, `pipelineConfigSchema`,
`plannerConfigSchema`), `AppConfig`, and `defaultProjectConfigYaml` — Stable
for `loadConfig`/`AppConfig`/schemas; helpers Experimental.

## Providers (`src/providers`)

| Export | Description | Tier |
| --- | --- | --- |
| `IProvider`/`IChatProvider` contracts | see types | Stable |
| `OpenAICompatibleProvider` | OpenAI/OpenRouter/local-runtime adapter (chat + `stream`) | Stable |
| `streamChatCompletion` | shared SSE streaming implementation | Stable |
| `OmniHilbrasProvider` | OmniHilbras adapter (optional) | Stable |
| `createProvider`, `OPENAI_COMPATIBLE_TYPES` | config→adapter factory | Stable |
| `resolveApiKey`, `authHeaders`, `AuthRef` | credential resolution from env | Stable |
| `providerHttpError`, `providerTransportError`, `kindFromStatus`, `isTimeoutError`, `isNetworkError`, `isRetryable`, `extractMessage`, `parseRetryAfter`, `ProviderErrorKind` | error normalization (§10) | Stable |
| `requestJson`, `HttpResponseError` | transport-level HTTP helper | Experimental |

## Registry, agents, roles (`src/registry`, `src/agents`, `src/roles`)

`ModelRegistry`, `registryKey` (Stable); `ProcessAgent`, `composeTaskText`,
`createAgent`, `buildAgentRegistry`, `defaultAgentAdapters` (Stable);
`buildChildEnv`, `resolveEnvPolicy`, `EnvPolicy`, `validateWorkingDirectory`,
`AgentAdapterRegistry`, `ProcessAgentAdapter`, `IAgentAdapter`, `killTree`,
`describeExit`, `sanitizeChunk`, `DEFAULT_MAX_OUTPUT_BYTES` (Stable);
`RoleRegistry`, `buildRoleRegistry` (Stable).

## Tasks (`src/tasks`)

`TaskEngine`, `createTaskEngine`, `TaskEngineOptions`, `CreateTaskInput`,
`FileTaskStore`, `TaskStore`, `TaskStoreFilter` — Stable.

## Pipelines (`src/pipelines`)

`PipelineEngine` (+ options, `PipelineRunOptions`), `buildPipelineEngine`,
`createDefaultChatFn`, `ChatFn` (compat re-export), `FilePipelineRunStore`,
`PipelineRunStore`, `PipelineRunFilter` — Stable; `IPipelineExecutor`,
`PipelineRunAttempt` — Stable (v2); scheduling internals Experimental.

## Reports (`src/reports`)

`ReportService`, `extractReportFromText`, `aggregateReports`, `similar`,
`FileReportStore`, `ReportStore`, `ReportFilter`, `CombinedReportFilter` —
Stable.

## Planner (`src/planner`)

`IPlanner`, `PlanRequest` (types), `ModelPlanner`, `HeuristicPlanner`,
`parsePlanJson`, `buildPlannerContext`, `buildPlanner`, `FilePlanStore`,
`PlanStore` — Stable.

## Memory (`src/memory`)

`LocalMemoryProvider`, `RememberaMemoryProvider`, `createMemoryProvider`,
`MemoryService` — Stable.

## Persistence (`src/persistence`)

`JsonFileStore`, `ProjectStores`, `SCHEMA_VERSION`, `inspectDocument`,
`readDocument`, `writeFileAtomic`, `migrateProjectStores`, `MigrationReport`,
`STORE_FILES`, `DocumentState` — Stable (v2). Canonical interface aliases
(`PipelineStore`, `MemoryStore`, `AuditStore`) in `store-types.ts` — Stable.

## CLI helpers (`src/cli`)

`EXIT`, `ExitCode`, `exitCodeFor`, `exitCodeForStatus` — Stable. `configureLogger`
— Stable.

## Logging (`src/logger`)

`Logger`, `ConsoleLogSink`, `LogSink`, `LogLevel`, `logger` — Stable.