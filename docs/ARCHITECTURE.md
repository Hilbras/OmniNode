# OmniNode Architecture

OmniNode is a provider-agnostic orchestration layer. It never talks to a model
directly — every AI system (provider API or CLI agent) plugs in through a
replaceable interface, which is what keeps the core free of Hilbras
dependencies and any other vendor.

## Layers

```
CLI (src/cli)
  └── config (src/config)          omninode.yaml → typed AppConfig (strict, env-expanded)
        ├── providers (src/providers)   IProvider / IChatProvider — model discovery, chat
        ├── agents (src/agents)         IAgent — process adapter over stdin/stdout (§21 protocol)
        ├── roles (src/roles)           RoleRegistry — provider-independent roles
        ├── tasks (src/tasks)           TaskEngine — lifecycle, retry, execution
        ├── pipelines (src/pipelines)   PipelineEngine — DAG scheduling, steps, runs
        ├── reports (src/reports)       normalization, aggregation, combined reports
        ├── planner (src/planner)       IPlanner — ModelPlanner / HeuristicPlanner → Plan
        ├── memory (src/memory)         IMemoryProvider — local JSON or Remembera
        ├── registry (src/registry)     ModelRegistry (provider:model keys)
        └── audit (src/audit)           append-only lifecycle log
```

Data flows through one direction only: config → engines → stores. Every store
is an interface (`TaskStore`, `PipelineRunStore`, `ReportStore`, `PlanStore`,
`AuditSink`, `IMemoryProvider`) with a local JSON default.

## The workflow (§28)

```
User
  ↓ omninode run <pipeline> "<objective>"
PipelineEngine (validates the DAG, schedules steps)
  ├── research step  → TaskEngine → ProcessAgent × N (parallel, independent)
  │                     ↓ AgentTaskOutput
  │                   ReportService (normalize, store, aggregate → CombinedReport)
  ├── plan step      → IPlanner (ModelPlanner with heuristic fallback) → Plan
  ├── execute step   → TaskEngine → ProcessAgent (receives the full plan)
  └── final          → resultSummary on the run record
MemoryService: relevant memory is injected before every task; outcomes are
written back afterwards (findings of high/critical severity become project-level
"known problems").
```

## Local state (`.omninode/`, gitignored)

| File | Contents |
| --- | --- |
| `tasks.json` | Task records incl. status, results, truncated raw agent output |
| `pipelines.json` | Pipeline runs: per-step status, task ids, plan/report ids |
| `reports.json` | Raw reports and combined reports with source attribution |
| `plans.json` | Implementation plans (steps, acceptance criteria, risks) |
| `memory.json` | Local memory provider entries |
| `audit.jsonl` | Append-only lifecycle events |

## Pipeline lifecycle (v2 Phase 5)

```
PipelineDefinition ──run()──▶ PipelineRun (attempt, cancellationRequested)
                                 └── PipelineStepRun (attempt, taskIds, executionIds)
                                       └── Task (attempt, executionId per attempt)
```

- **Cancellation** is first-class: `cancel(runId)` flags the run (visible to
  other processes) and terminates in-process tasks — their agent processes
  die with them (Phase 4 tree cleanup). At the next wave boundary the
  scheduler stops dispatching, marks pending steps `cancelled`, and the run
  persists as `cancelled`.
- **Failure propagation**: a hard failure fails the run and skips
  on-success downstream steps; a partial fan-out yields a `partial` run;
  cancellation wins over both.
- **Validation** happens before anything executes: duplicate ids, unknown or
  cyclic dependencies, unregistered agents, and malformed/unconfigured plan
  model references all fail fast (`omninode pipeline validate <id>`).
- **Recovery**: a run persisted as `running` with no `finishedAt` is
  reported as interrupted; `omninode pipeline retry <run-id>` re-runs it.
  This is state understanding, not replay.

## Execution states (v2 Phase 2)

```
created ──▶ queued ──▶ running ──┬─▶ completed
   │           │         │        ├─▶ failed            (outcome known, work not done)
   │           │         │        ├─▶ timed_out        (timeout provably before dispatch)
   └───────────┴─────────┴────────┼─▶ unknown           (killed after dispatch — may have succeeded)
                                  ├─▶ cancelled
                                  └─▶ partially_completed (fan-out: some units succeeded)
```

- A timeout after dispatch is **not** a failure — the agent may have already
  done the work remotely. Such tasks end `unknown` and are resolved by an
  explicit `task retry` (a new execution) or by inspecting artifacts.
- Automatic retries apply only to allow-listed transient errors
  (`AGENT_FAILED`), with bounded attempts and linear backoff. Unknown
  outcomes are never retried automatically, to avoid duplicating side effects.
- Every attempt has an `executionId`, a cumulative `attempt` number and a
  bounded execution history on the task.
- Pipeline runs derive `failed` (any hard failure) > `partial` (any partial or
  unprovable step) > `completed`.

## v2 additions (Phase 1)

```
src/persistence/         JsonFileStore<T> — the single local persistence base
  ├── tasks (FileTaskStore)
  ├── pipelines (FilePipelineRunStore)
  ├── reports (FileReportStore)
  ├── planner (FilePlanStore)
  └── memory (LocalMemoryProvider)
ProjectStores            one facade over every store for a project directory
```

Rules (enforced by review and the API inventory test):

1. **Dependency direction is one-way**: `types` ← engines ← adapters ← CLI.
   Adapters never import engine modules — shared contracts live in
   `src/types` (e.g. `ChatFn`).
2. **Engines never touch `fs`** — they go through store interfaces; the
   atomic write, serialization and schema envelope live in one place.
3. **Extension points are interfaces only**: `IProvider`, `IAgent`,
   `IPlanner`, `IMemoryProvider`, the store family, `AuditSink`.

Persisted files use a versioned envelope:

```json
{ "schemaVersion": 1, "items": [ … ] }
```

v1 bare-array files remain readable (schema migrations land in v2 Phase 12).

## Design principles (from the plan)

1. **Provider agnostic** — the core imports no vendor SDK.
2. **Agent agnostic** — CLI agents integrate over stdin/stdout or the §21
   protocol; no agent's internals are assumed.
3. **Memory agnostic** — Remembera is one implementation of `IMemoryProvider`.
4. **Modular** — every boundary (provider, agent, role, pipeline, transport,
   storage, memory) is an interface with a local default.
5. **Local first** — no cloud service is required for any core operation.