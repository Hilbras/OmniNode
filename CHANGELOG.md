# Changelog

All notable changes to `@hilbras/omninode`. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org).

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