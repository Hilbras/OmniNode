# Public API Inventory

Everything exported from the package root, grouped by subsystem, with the
stability tier from [API_STABILITY.md](API_STABILITY.md).

## Types (`src/types`)

| Export | Description | Tier |
| --- | --- | --- |
| `ProviderConfig`, `ProviderStatus`, `IProvider`, `IChatProvider` | provider abstraction, model discovery, chat | Stable |
| `ModelInfo`, `ModelCapabilities` | normalized model registry entries | Stable |
| `AgentConfig`, `AgentInfo`, `AgentTaskInput`, `AgentTaskOutput`, `IAgent`, `AgentInputMode` | CLI agent abstraction and process adapter contract | Stable |
| `RoleDefinition` | provider-independent roles | Stable |
| `Task`, `TaskStatus`, `TaskContext`, `TaskResult` | task model and lifecycle states | Stable |
| `PipelineDefinition`, `PipelineStep`, `PipelineRun`, `PipelineStepRun` | pipeline definitions and run records | Stable |
| `Plan`, `PlanStep` | planner output schema | Stable |
| `Report`, `Finding`, `Confidence`, `CombinedReport`, `AggregatedFinding`, `FindingSource` | report model | Stable |
| `MemoryEntry`, `MemoryQuery`, `MemoryScope`, `IMemoryProvider` | memory abstraction | Stable |
| `Project` | project entity | Stable |
| `ChatMessage`, `ChatRequest`, `ChatResponse`, `ChatRole`, `ChatUsage`, `ChatFn` | chat contracts; `ChatFn` was re-exported from `pipelines` in v1 and remains so | Stable |
| `MessageEnvelope`, `AgentToNodeMessage`, `NodeToAgentMessage` | JSON-lines agent protocol envelope | Experimental |
| `AuditEvent`, `AuditAction`, `AuditSink`, `FileAuditLog` | append-only audit log | Experimental |

## Errors (`src/errors`)

`OmniNodeError` (stable, carries a stable `code` union), plus subclasses
`ConfigError`, `ProviderError`, `AgentError`, `TaskError`, `PipelineError`,
`PlannerError`, `ProtocolError`, `MemoryError` — Stable. Message text is not
part of the contract.

## Configuration (`src/config`)

`loadConfig`, `findConfigStore`-style helpers (`findConfigFile`),
`expandEnvRefs`, the zod schemas (`appConfigSchema`, `providerConfigSchema`,
`agentConfigSchema`, `roleConfigSchema`, `pipelineConfigSchema`,
`plannerConfigSchema`), `AppConfig`, and `defaultProjectConfigYaml` — Stable
for `loadConfig`/`AppConfig`/schemas; helpers Experimental.

## Providers (`src/providers`)

| Export | Description | Tier |
| --- | --- | --- |
| `IProvider`/`IChatProvider` contracts | see types | Stable |
| `OpenAICompatibleProvider` | OpenAI/OpenRouter/local-runtime adapter | Stable |
| `OmniHilbrasProvider` | OmniHilbras adapter (optional) | Stable |
| `createProvider`, `OPENAI_COMPATIBLE_TYPES` | config→adapter factory | Stable |
| `resolveApiKey`, `authHeaders`, `AuthRef` | credential resolution from env | Stable |
| `requestJson` | internal HTTP helper | Experimental |

## Registry, agents, roles (`src/registry`, `src/agents`, `src/roles`)

`ModelRegistry`, `registryKey` (Stable); `ProcessAgent`, `composeTaskText`,
`buildChildEnv`, `createAgent`, `buildAgentRegistry` (Stable); `RoleRegistry`,
`buildRoleRegistry` (Stable).

## Tasks (`src/tasks`)

`TaskEngine`, `createTaskEngine`, `TaskEngineOptions`, `CreateTaskInput`,
`FileTaskStore`, `TaskStore`, `TaskStoreFilter` — Stable.

## Pipelines (`src/pipelines`)

`PipelineEngine` (+ options, `RunPipelineOptions`), `buildPipelineEngine`,
`createDefaultChatFn`, `ChatFn` (compat re-export), `FilePipelineRunStore`,
`PipelineRunStore`, `PipelineRunFilter` — Stable; scheduling internals
Experimental.

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

`JsonFileStore`, `ProjectStores` — Experimental (v2 work in progress; the
on-disk schema is versioned but may change until Phase 12).

## Logging (`src/logger`)

`Logger`, `ConsoleLogSink`, `LogSink`, `LogLevel`, `logger` — Stable.