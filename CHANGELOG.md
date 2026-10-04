# Changelog

All notable changes to `@hilbras/omninode`. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org).

## [2.0.0-alpha.18] — v2 Phase 18 (Documentation Overhaul)

### Added

- New documents completing the roadmap's set:
  - **AGENTS.md** — registering agents, the three input modes, process
    handling and states, writing native adapters
  - **PIPELINES.md** — pipeline definitions, step kinds, scheduling semantics,
    conditions, retries, results
  - **TROUBLESHOOTING.md** — symptom → cause → fix across configuration,
    providers, agents, pipelines and state
  - **MIGRATION.md** — v1 → v2: compatibility summary, storage migration,
    configuration additions, behavior changes, deprecations, upgrade steps
  - **CONTRIBUTING.md** — setup, the branch→release workflow, the rules this
    codebase holds itself to
- **README rewritten** for v2 accuracy: what OmniNode is and is not, the v1.0
  capability table, the v2 phase-by-phase status, a real quick start
  (install → configure → pipeline → one-command run → inspect), roadmap with
  the prerelease channel, and the full documentation index.

## [2.0.0-alpha.17] — v2 Phase 17 (Testing Expansion)

### Added

- **Failure matrix suite** (`tests/failure-matrix.test.ts`, §21): explicit,
  auditable coverage for provider rate limits, server errors, invalid keys,
  missing key references, model unavailable, network loss, malformed gateway
  responses, OmniHilbras unavailable, agent crash/timeout/missing executable,
  malformed JSONL, huge stdout, duplicate execution, partial pipeline
  failure, corrupted persistence, duplicate configuration names, Remembera
  unavailable (tolerated and required), and malformed reports.
- **Duplicate configuration names are rejected**: two providers/agents/roles/
  pipelines with the same name used to silently shadow each other.
- **Protocol diagnostics on task results**: `result.protocol` carries the
  agent descriptor, questions and violations for `task inspect`.
- docs/TESTING.md: the failure matrix table, regression-test list and how to
  run the suite.
- Tests: 446 (was 427).

## [2.0.0-alpha.16] — v2 Phase 16 (Configuration v2)

### Added

- **Source precedence** (§16): CLI arguments → environment →
  project file → user file → profile overlay → defaults, with
  `loadConfigDetailed()` returning provenance (`projectFile`, `userFile`,
  `profile`, `envOverrides`, `defaults`). User configuration lives at
  `~/.omninode/config.yaml` (`OMNINODE_USER_CONFIG` overrides it).
- **Profiles** (§16): `profile:` in the file plus a `profiles:` block of
  partial overlays (`development` / `production` / `testing`), selected by
  `--profile` > `OMNINODE_PROFILE` > file; unknown profiles fail with the
  known set. `omninode config profiles` lists them.
- **Environment overrides**: `OMNINODE_CONFIG`, `OMNINODE_PROFILE`,
  `OMNINODE_LOG_LEVEL`, `OMNINODE_LOG_FORMAT`, `OMNINODE_MEMORY_PROVIDER`,
  `OMNINODE_MEMORY_REQUIRED`.
- **Global CLI options** `--config` / `--profile`, honored by every command.
- **Actionable diagnostics** (§16): `configDiagnostics()` produces messages
  like `Provider "deepseek": API key reference is missing — add
  api_key_env_var: <ENV_VAR> …`, printed by `config validate` together
  with the sources and defaults that were applied.
- docs/CONFIGURATION.md: precedence table, profiles, secrets, diagnostics.
- Tests: 427 (was 411).

## [2.0.0-alpha.15] — v2 Phase 15 (CLI v2)

### Added

- **Documented exit codes** (§19): `EXIT` map + `exitCodeFor()` /
  `exitCodeForStatus()` — 0 success, 1 general, 2 invalid input, 3 config,
  4 provider, 5 agent, 6 timeout, 7 cancelled, 8 not found, 9 not
  implemented. Errors and failed tasks/pipelines now exit with the class
  code instead of always 1.
- **`config` command group**: `config show` (credential *references* only —
  never values), `config path`, `config validate` (schema + inline-secret
  scan).
- **`pipeline create <id> --from <file>`**: builds a pipeline from a
  YAML/JSON definition, validates it (deps, cycles, agents) and appends it to
  `omninode.yaml` without ever writing an invalid config.
- **`provider remove <name>`**: implemented for real (was a stub).
- **`agent run <name> "<objective>"`**: run one task through an agent
  immediately.
- **`model` alias** for `models`, and **`--json`** output on the list/inspect
  commands (task, pipeline, provider, agent, role, plan, report, model,
  memory).
- docs/CLI.md: command map, output modes, exit-code table, recipes, secrets
  note.
- Tests: 411 (was 401).

## [2.0.0-alpha.14] — v2 Phase 14 (Audit & Observability)

### Added

- **Correlated audit events** (§18): every event carries `taskId`,
  `pipelineId`, `executionId`, `agentId`, `providerId` alongside the subject
  id, so a task → execution → pipeline run → agent → provider chain can be
  reconstructed.
- **New audit actions**: `agent.started`, `agent.completed`,
  `provider.error` (with the normalized error kind), and distinct
  `pipeline.run.failed` / `pipeline.run.cancelled`.
- **Provider error auditing**: OpenAI-compatible adapters record
  `provider.error` with the operation and normalized kind; the pipeline
  engine passes its audit log to providers, so plan-step provider failures
  land in the trail.
- **Structured logs**: `logging.format: json` emits one JSON object per line
  (level, message, timestamp, context) for log shipping.
- **CLI diagnostics**: `omninode task inspect <id>` (executions, last error,
  result, reports), `pipeline inspect <run-id>` (steps, task ids, plan/report
  ids, result), `agent inspect <name>` (effective config, env policy, recent
  tasks), `provider inspect <name>` (auth method, credential status) — all
  with `--json`.
- Tests: 401 (was 393) — correlation ids on lifecycle events, provider-error
  auditing, JSON log format, and all four inspect commands.

### Changed

- Store writes default to atomic-rename durability; `fsync` (data + directory
  flush) is now opt-in per store instead of always-on — same torn-read
  protection, a fraction of the I/O cost.

## [2.0.0-alpha.13] — v2 Phase 13 (Security Hardening)

### Added

- **Inline-secret detection** (§17): `omninode.yaml` is scanned before
  parsing; literal `api_key` / `token` / `password` / `secret` / `credential`
  values are refused with line numbers and **redacted** excerpts plus the fix
  (`api_key_env_var: MY_API_KEY`). References (`${VAR}`, `$VAR`, `<store>`,
  empty) pass.
- **Report size limit** (§17): reports over `MAX_REPORT_BYTES` (256 KiB) are
  rejected with diagnostics instead of being persisted.
- **`omninode security audit`**: advisory review of a project — agents
  inheriting the full environment, agents allowed outside the project root,
  explicit per-agent env injection, providers/memory without credential
  references — followed by the plain trust-model statement.
- **Static guards**: tests fail the build if shell execution (`exec`,
  `execSync`, `shell: true`) appears anywhere in `src/`, or if the process
  adapter stops using `spawn`.
- SECURITY.md: output-limit table, agent trust model, an explicit "OmniNode is
  not a sandbox" boundary, and the audit command.
- Tests: 393 (was 383).

## [2.0.0-alpha.12] — v2 Phase 12 (Persistence Layer v2)

### Added

- **Durable atomic writes** (§16): temp file → fsync → atomic rename →
  directory fsync for every JSON store, and fsynced appends for the audit log.
- **Corruption recovery**: unparseable store files are **quarantined**
  (`<name>.corrupt-<timestamp>`) rather than deleted or silently overwritten —
  the damaged data stays inspectable and the store continues empty.
- **Schema versioning**: documents carry `schemaVersion` (current: 2); files
  written by a newer OmniNode are refused instead of misread.
- **Migration path**: v1 bare-array documents are migrated in place;
  `omninode migrate [--check]` and `migrateProjectStores()` report per-file
  state (`missing`/`empty`/`v1-legacy`/`current`/`future`/`corrupt`) and never
  touch future or corrupt files.
- **Canonical storage interfaces** (`src/persistence/store-types.ts`):
  `PipelineStore`, `MemoryStore`, `AuditStore` aliases documented alongside the
  v1 names.
- docs/PERSISTENCE.md: interfaces, durability model, corruption handling,
  migration, custom backends.
- Tests: 383 (was 375) — document state classification, future-version
  refusal, atomic writes leaving no temp files, audit durability, migration
  (dry run, apply, idempotence), and the `omninode migrate` CLI.

## [2.0.0-alpha.11] — v2 Phase 11 (Planner v2)

### Added

- **Full planner input** (§15): task, project context, agent reports,
  **aggregated findings** (consensus + conflicts made explicit in the prompt),
  relevant memory and **constraints**. Plan steps accept `constraints:` in
  configuration; the pipeline engine aggregates upstream reports and hands
  the combined findings to the planner.
- **Plan goal**: plans (and model output) carry an explicit `goal`.
- **Plan validation** (§15): `validatePlan()` checks steps, duplicate ids,
  unknown dependencies and summary; every generated plan is validated before
  it is accepted.
- **Structured rejection**: invalid model output yields a `PLAN_INVALID`
  PlannerError carrying `details.reason` + `details.issues`; with a fallback
  configured the heuristic planner takes over instead.
- **Planner independence**: a guard test fails if the planner module gains a
  dependency on any specific provider.
- Tests: 375 (was 366) — context assembly, validation accept/reject, fallback
  vs structured error, conflicts-as-risks in heuristic plans, independence
  guard, and an end-to-end pipeline asserting the planner receives aggregated
  findings and constraints.

### Changed

- Model planner output contract now requires `goal`; heuristic plans derive a
  goal and surface unresolved agent disagreements as risks.

## [2.0.0-alpha.10] — v2 Phase 10 (Aggregation Improvements)

### Added

- **Conflict detection** (§14): when agents disagree about the same finding,
  both positions are preserved instead of silently choosing one. Conflict
  types: `severity` (different severities) and `recommendation` (divergent
  proposed fixes), each carrying every agent's position and an explanatory
  note.
- **Agreements**: findings independently reported by 2+ agents with the same
  severity are recorded as consensus.
- **Confidence preservation**: the strongest reported confidence is kept and
  per-agent values are recorded (`confidenceBySource`), alongside
  `severityBySource`.
- **Provenance-rich combined reports**: `agreements`, `conflicts` and metadata
  counters (`agents`, `reports`, `rawFindings`, `findingGroups`, `agreements`,
  `conflicts`).
- CLI: `report combined` flags conflicts in listings; `report show` prints
  every position of a conflict.
- Tests: 366 (was 358) — agreement vs conflict detection, both position
  preservation, confidence preservation, determinism (identical input →
  identical structure).

## [2.0.0-alpha.9] — v2 Phase 9 (Report System v2)

### Added

- **Report validation** (§13): `validateReport()` (zod) runs on every report
  entering the system. `ReportService.collectFromTasks()` drops malformed
  reports and records `lastDiagnostics` (`collected` / `accepted` /
  `rejected[]` with per-issue paths) — malformed reports can no longer enter
  aggregation.
- **Typed evidence** (§13): `file`, `line`, `url`, `command`, `observation`,
  `artifact` with ref/line/excerpt/agent. Plain strings still accepted and
  normalized to observation evidence.
- **Richer findings**: `description`, `confidence`, `source` provenance
  (agent/reportId/pipelineRunId) and `recommendation`.
- **Report-level additions**: `agentId`, `pipelineRunId`, `evidence[]`,
  `artifacts[]`.
- docs/REPORTS.md: schema, validation, provenance, CLI, authoring.
- Tests: 358 (was 351).

### Changed

- Text-extracted reports now emit `description` alongside `detail`, and
  extracted evidence is typed rather than a raw string array.
- Aggregation normalizes evidence from both legacy strings and objects.

## [2.0.0-alpha.8] — v2 Phase 8 (Remembera Integration v2)

### Added

- **Formalized memory contract** (§12): `retrieve` / `store` / `search` /
  `metadata` on `IMemoryProvider`; the v1 `query` / `write` names remain as
  aliases so existing integrations keep compiling. Shared helpers supply the
  default search/metadata behavior.
- **Structured memory categories** (§12): `project`, `architecture`,
  `decisions`, `tasks`, `problems`, `solutions`, `conventions`,
  `agent_reports` — with filtering on both adapters and category-aware task
  outcomes (findings recorded as `problems`).
- **Task-oriented, budgeted retrieval** (§12): `MemoryService.contextFor()`
  returns the selected entries, prompt-ready text and a `truncated` flag —
  OmniNode never loads all memory into a prompt.
- **Failure policy** (§12): `memory.required: true` turns backend failures
  into `MemoryError` (a task that needs context fails loudly); the default
  remains warn-and-continue.
- Contract parity suite: the same expectations run against the local and
  Remembera adapters.
- docs/MEMORY.md: contract, scopes/categories, the §20 loop, failure policy,
  backends, extension guide.
- Tests: 351 (was 339).

### Fixed

- Context truncation could exceed its character budget by one (the ellipsis
  was appended after the slice).

## [2.0.0-alpha.7] — v2 Phase 7 (OmniHilbras Integration v2)

### Added

- **Streaming where supported** (§11): `IChatProvider.stream(request, onChunk)`
  with SSE parsing shared by every OpenAI-compatible gateway — deltas are
  emitted in order and the resolved response carries the assembled text and
  finish reason.
- **Provider-level timeouts**: `timeout_ms` on provider config, applied to
  model discovery, chat and stream (distinct from agent/pipeline budgets per
  the Phase 2 timeout model).
- **Gateway metadata across the boundary** (§11): the OmniHilbras adapter
  captures gateway-level metadata from the discovery response (version, tier,
  region…) and attaches it to every discovered model, exposed via
  `gatewayMetadata()`.
- **Separation guarantees** (§11 exit criterion):
  - a guard test fails the build if any module outside the provider layer,
    config schema/loader, the barrel or the provider CLI references
    OmniHilbras;
  - an end-to-end test runs a full pipeline with no OmniHilbras configured.

### Fixed

- `chat()` now actually applies the provider-level timeout (the setting was
  only reaching model discovery).

- Tests: 339 (was 331) — gateway metadata, provider timeout, SSE streaming,
  separation guard, core-without-OmniHilbras pipeline.

## [2.0.0-alpha.6] — v2 Phase 6 (Provider Infrastructure v2)

### Added

- **Standardized provider interface** (§10): `providerId`, secret-free
  `authentication` summary (`{ method, envVar, configured }`), declared
  `capabilities`, and the discovery surface `connect()` / `getModel()`
  alongside `listModels()` / `healthCheck()`.
- **Model metadata** (§10): context window, input/output modalities, and
  tool / structured-output / streaming support derived from
  `supported_parameters`, when a gateway reports them.
- **Provider error normalization** (§10): every failure carries a stable
  `details.kind` — AUTHENTICATION_ERROR, RATE_LIMIT_ERROR, INVALID_REQUEST,
  MODEL_NOT_FOUND, TIMEOUT, NETWORK_ERROR, SERVER_ERROR, UNKNOWN_ERROR —
  with `retryable`, `retryAfterMs` (from `Retry-After`) and actionable
  fallback messages. Legacy stable `error.code` values preserved.
- `HttpResponseError` distinguishes malformed provider responses from
  transport failures; the HTTP layer now stays transport-level and adapters
  own the semantics.
- docs/PROVIDERS.md: contract, configuration, metadata, error matrix,
  extension guide.
- Tests: 331 (was 311) — full status→kind matrix, retryability, metadata
  mapping, connect/getModel caching, secret-free auth summary.

### Fixed

- Providers now resolve auth through the environment captured at
  construction (consistent with the `authentication` summary).
- `OmniHilbrasProvider.connect(registry)` renamed to
  `connectAndRegister(registry)` to align with the base `connect()`
  contract; the CLI `--connect` path uses it.

## [2.0.0-alpha.5] — v2 Phase 5 (Pipeline Lifecycle v2)

### Added

- **First-class pipeline cancellation** (§9.2): `engine.cancel(runId)` records
  the request on the run and terminates tasks running in the same process;
  the scheduler checks between waves, cancels pending steps, persists
  `status: "cancelled"`. CLI: `omninode pipeline cancel <run-id>` (works for
  runs executing in other processes at their next check point).
- **Execution-model separation** (§9.1): runs carry `attempt` and an
  `attempts` history; step runs carry `attempt` and `executionIds`, so
  Pipeline / Run / Step / StepRun / Attempt are no longer conflated.
- **`IPipelineExecutor`** interface (`validate` / `run` / `cancel` / `get` /
  `listRuns`) — the contract orchestration code depends on.
- **Hardened pre-run validation** (§9.5): plan-step model references are
  validated (`provider:model-id` shape + provider configured), alongside the
  existing dependency/cycle/agent checks. CLI: `omninode pipeline validate <id>`.
- **Recovery awareness** (§9.6): `pipeline runs` and `pipeline status` flag
  runs persisted as `running` without a `finishedAt` as interrupted, pointing
  at `pipeline retry`.
- Robustness fix: a task cancelled while its agent is finishing stays
  `cancelled` instead of throwing on an invalid transition.
- Concurrency fix: persisting a run no longer clobbers a cancellation
  request set by another process.
- Tests: 311 (was 297) — cancellation mid-run, external cancellation
  request, attempt bookkeeping, the validation matrix, interrupted-run
  awareness.

## [2.0.0-alpha.4] — v2 Phase 4 (Agent Adapter Hardening)

### Added

- Environment policies (§8): `inherit` (default), `allowlist`, `denylist`,
  `explicit` via `env_policy` + `env_allowlist` / `env_denylist`; the v1
  `inherit_env: false` keeps working (maps to `explicit`).
- Process-tree cleanup: agents run in their own process group on POSIX;
  timeout, cancel **and OmniNode's own SIGINT/SIGTERM** reap the whole tree
  (verified by a test where an orphaned grandchild would write a marker).
- Output protection: per-stream byte budget (`max_output_bytes`, default
  5 MiB) truncates output and kills a flooding agent instead of exhausting
  memory; output decoding strips NUL bytes so binary noise cannot poison the
  protocol decoder.
- Working-directory validation: existence, directory-ness, access and path
  normalization, plus project-boundary enforcement (`allow_external_cwd`
  opt-in).
- Native adapter interface `IAgentAdapter` + `AgentAdapterRegistry`:
  `createAgent(config, adapters)` consults the registry, so API-level
  integrations plug in without modifying core.
- Exit/signal interpretation (`describeExit`) surfaced in task errors.
- Tests: 297 (was 282) — env policy matrix, tree-cleanup proof, output-flood
  kill, cwd validation matrix, adapter registry.

### Changed

- `agent add` gained `--env-policy`, `--allow-env`, `--deny-env`,
  `--max-output-bytes`, `--allow-external-cwd`.
- Unregistered `native` integrations now say "no native adapter is
  registered" and point at the registry API.

## [2.0.0-alpha.3] — v2 Phase 3 (Agent Protocol v2)

### Added

- `src/agent-protocol/`: the OmniNode Agent Protocol v2 as a first-class,
  dependency-free module — envelope, codec, handshake, session.
- Explicit protocol versioning (`omninode-agent-protocol/2`); unversioned v1
  messages still accepted; unsupported versions rejected, never misread.
- Standardized envelope with full correlation (messageId, requestId, taskId,
  agentId, pipelineId, executionId) and the complete message-type set
  (TASK, CONTEXT, INSTRUCTION, RESPONSE, CANCEL, HELLO_ACK / HELLO,
  TASK_ACCEPTED, TASK_STARTED, STATUS, QUESTION, REPORT, ARTIFACT, COMPLETION,
  ERROR, CANCELLED).
- HELLO/HELLO_ACK handshake with agent descriptors (name, version,
  capabilities, supported message types).
- Interactive QUESTION → RESPONSE round-trips driven by an optional responder.
- Hardened decoding: total (never throws), 1 MiB message/line limits, and
  typed violations (INVALID_JSON, NOT_AN_OBJECT, UNKNOWN_TYPE, MISSING_FIELD,
  INVALID_PAYLOAD, UNSUPPORTED_VERSION, OVERSIZED) surfaced on the task.
- docs/PROTOCOL.md: the specification external agents integrate against.
- Tests: 270 (was 251) — versioning, the full malformed matrix, streaming
  decoder, handshake, question round-trips, and real v2-speaking and
  garbage-emitting agent processes.

### Changed

- Process adapter protocol mode now emits v2 envelopes (previously ad-hoc
  `{meta, message}` objects) and returns protocol diagnostics (descriptor,
  questions, violations) on the task result.

## [2.0.0-alpha.2] — v2 Phase 2 (Execution Reliability)

### Added

- Execution states `timed_out`, `unknown`, `partially_completed` on tasks and
  `partial` on pipeline runs, with a documented strict state machine
  (invalid transitions rejected).
- **Timeout ≠ failure**: an adapter timeout after dispatch marks the task
  `unknown` (the agent may already have performed side effects); only a
  timeout provably raised before dispatch becomes `timed_out`.
- Execution identity and history per task: `executionId` per attempt,
  cumulative `attempt` counter, `lastError`, bounded execution records.
- Retry safety: `run(id, { maxAttempts, retryBackoffMs })` with bounded
  retries, linear backoff, and a retryable-error allow-list (agent crashes).
  Unknown/timed-out outcomes are never auto-retried; `task retry` starts an
  explicit fresh execution instead.
- Pipeline failure propagation: partial fan-out yields a `partial` step and
  `partial` run (downstream still runs), hard failures still fail the run and
  skip on-success steps.
- Process-adapter timeout errors now carry operation, duration and a
  `dispatched` flag.
- Tests: 251 (was 240) — the execution failure matrix: unknown vs timed_out,
  retryable vs non-retryable, bounded history, strict transitions,
  partial fan-out, hard-failure skip.

## [2.0.0-alpha.1] — v2 Phase 1 (Architecture & API Stabilization)

### Added

- `src/persistence/`: shared `JsonFileStore<T>` base (atomic write-then-
  rename, serialized read-modify-write, schema-versioned envelope, corruption
  tolerance that never destroys data, v1 bare-array compatibility) and a
  `ProjectStores` facade bundling every local store.
- `ChatFn` type in the neutral `src/types/chat` layer.
- Documents: `docs/API_STABILITY.md` (tiers, semver rules, deprecation
  process, extension contracts), `docs/API.md` (public API inventory),
  `docs/DEPRECATIONS.md`, `docs/ROADMAP_V2.md` (the v2 roadmap), this changelog.
- Tests for the persistence contract: atomic writes, schema envelope,
  50-way concurrent writes, corrupt-file handling, v1 file compatibility.

### Changed

- All five local stores (tasks, pipeline runs, reports, plans, memory) now
  build on `JsonFileStore` — removing ~5x duplicated load/mutate/write logic.
  Persisted files now use a `{ schemaVersion, items }` envelope (v1 files are
  still read correctly).
- Dependency direction corrected: the planner adapter no longer imports from
  the pipeline engine module.

### Deprecated

- `ChatFn` re-exported from `src/pipelines` (still available; use the types
  module). See `docs/DEPRECATIONS.md`.

## [1.0.0] — v1 Complete

The full v1 plan (phases 0–11): provider abstraction with the OpenAI-compatible
and OmniHilbras adapters, CLI agent system (stdin/arg/protocol modes), roles,
tasks, pipelines with DAG scheduling, multi-AI report aggregation, planner
(model + heuristic), memory (local + Remembera), the end-to-end workflow,
audit logging, agent env isolation, security and architecture docs, and an
example project. 174 tests at release.