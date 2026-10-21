# v3 Deep Audit — Full-System Scan

A full-surface audit of OmniNode v2.0.3 (fixed in v2.0.4): every module, every cross-cutting
concern, and every documented surface were scanned for bugs, unimplemented
features, dead code, and contract breaks.

- **Date:** 2026-10-21
- **Commit:** `736a8c5` ("ci: make smoke:cli portable to the Windows runner")
- **Baseline (all green):** `tsc --noEmit` clean · `eslint .` clean · 48 test files / 528 tests passing (~56 s) · coverage gate met

## Method

1. **Scout** — 20 parallel read-only agents, one per module plus six
   cross-cutting sweeps (dead code, stubs, security/resource, async/concurrency,
   state machines, docs-vs-code). Each read its scope in full and grepped the
   whole repo for each exported symbol before calling it dead.
2. **Verify** — the 26 highest-impact claims were re-checked by a second wave of
   26 agents that wrote executable probes in `/tmp` (never in the repo) and
   reproduced or refuted each claim against real behaviour.
3. **Confirm** — the surviving critical/high findings were independently
   reproduced by hand in this session.

**Result: 391 unique findings** (456 raw, after merging duplicates that
different agents reported for the same defect): 170 bug · 66 inconsistency ·
61 dead-code · 54 contract · 28 resource · 12 unimplemented.
By severity (as labelled by the scanning agents): 5 critical · 48 high ·
171 medium · 167 low. The severity tally in the appendix is the *scan's* own
labelling; §1 below is a **re-ranked** critical tier — issues that were
reproduced by probe and that corrupt data, break the published package, or
hang/crash the process. It is larger than the raw critical count because
several of the scan's "high" findings are critical in practice.

Of the 26 claims that went through executable verification:

| Outcome | Count |
| --- | --- |
| CONFIRMED | 21 |
| PARTIALLY CONFIRMED | 5 |
| REFUTED | 1 |

The green test suite does **not** mean the system is correct. Most of the
findings below are uncovered by the 528 tests, and the audit also found three
places where the test suite itself asserts the wrong thing.

---

## 1. Critical — published-package and data-loss defects

### 1.1 The published package advertises two exports that do not exist at runtime

`src/index.ts:11` re-exports the types barrel with `export type * from
"./types/index.js"`. That erases values at runtime, but the tsup `.d.ts`
bundler still resolves two *values* through it:

- `src/types/task.ts:26` — `export const TERMINAL_TASK_STATUSES` (the only
  runtime value in the whole `src/types/` barrel)
- `src/persistence/store-types.ts:10` — `export type { LocalMemoryProvider as
  MemoryStore }`; `LocalMemoryProvider` is a **class**, so the bundler emits
  the alias as a value export. The sibling aliases (`PipelineStore`,
  `AuditStore`) are interfaces and are correctly emitted as `type`.

Verified against a fresh `npm run build`:

```
d.ts value exports: 125   runtime exports: 123
MISSING AT RUNTIME: MemoryStore, TERMINAL_TASK_STATUSES
```

A consumer that imports either name in a value position gets a hard module-load
failure, not `undefined`:

```
SyntaxError: The requested module '.../dist/index.js'
does not provide an export named 'MemoryStore'
```

A type-position-only import is elided by `tsc`, which is why the internal suite
never trips over it — but plain JavaScript, `verbatimModuleSyntax`, or
`import { MemoryStore }` used as a value all fail.

**Fix.** Either move the constant into a runtime module and export it as a
value, or make `src/types/index.ts` type-only (`export type * from
"./task.js"`) so the bundler cannot surface it. If the class alias is
intentional, declare it as `export type MemoryStore = LocalMemoryProvider;`
(a type alias, not an `export type { X as Y }` re-export) so it is emitted
type-only.

### 1.2 A throwing pipeline step leaves the run stuck in `running` forever

`src/pipelines/engine.ts:315-402` — the step-execution phase is not wrapped in
`try/catch/finally`. When a step throws, the exception escapes `run()` before
the run record is finalised.

Confirmed by probe: the persisted run is left with `status: "running"`, no
`finishedAt`, no failure audit event, and the run's entry in the `activeRuns`
map is never released — so the run can neither be cancelled nor re-run.

**Fix.** Wrap the execution phase in `try/catch/finally`; on the error path
set the run to `failed` with a `finishedAt` and an error, emit the failure
audit event, and always delete the `activeRuns` entry in `finally`.

### 1.3 Concurrent `run()` calls execute the agent twice

`src/tasks/engine.ts:137` — the task record is read, mutated and written back
without synchronisation. Two concurrent `run()` calls on the same task both
pass the "is this runnable?" check and both invoke the adapter.

Confirmed by probe: the agent's `execute` is called twice for a single task,
and the resulting task record loses one of the updates.

**Fix.** Guard the transition (an in-flight set keyed by task id, or an atomic
compare-and-set on the task record) before invoking the adapter.

### 1.4 `cancel()` destroys the in-flight attempt's result and execution history

`src/tasks/engine.ts:280` — `cancel()` writes a stale snapshot of the task
back to the store, overwriting the result and `executionHistory` that the
running attempt produced. At `src/tasks/engine.ts:202-235` the failure path
overwrites a concurrent cancellation, so a cancelled task is resurrected as
`failed` / `unknown`.

Confirmed by probe: after cancelling a running task, the cancellation does not
survive and the execution history is lost.

**Fix.** Re-read the record inside `cancel()`, merge only the status/`
cancelledAt` fields, and have the failure path re-check the store for a
cancellation before writing a terminal status.

### 1.5 The process adapter never closes the child's stdin in `arg` mode

`src/agents/process/index.ts:185` — in `input_mode: "arg"` the child's stdin
pipe is never `end()`ed. Any agent that reads stdin waits forever until the
timeout expires.

Confirmed by probe: a child that reads stdin never observes EOF.

**Fix.** `child.stdin.end()` after writing the payload (or `child.stdin.destroy()`).

### 1.6 An un-awaited `session.handle()` can crash the whole process

`src/agents/process/index.ts:320` — `session.handle(...)` is called without
`await` and without a `.catch()`. An async throw inside the protocol handler
becomes an unhandled rejection, which terminates Node by default.

**Fix.** `void session.handle(...).catch(...)` with an error path that records
the violation instead of crashing.

### 1.7 Installing a SIGINT/SIGTERM listener permanently removes Node's default exit

`src/agents/process/index.ts:387-397` — registering a `SIGINT`/`SIGTERM`
listener replaces Node's default terminate behaviour. Ctrl+C no longer exits
the process, and the default "exit on second signal" safety net is gone.

**Fix.** Call `process.exit()` explicitly in the handler (after cleanup), and
re-raise the default behaviour for a repeated signal.

### 1.8 A store file written by a newer OmniNode is silently destroyed

`src/persistence/json-file-store.ts:127` — when the on-disk `schemaVersion` is
*newer* than the code understands, `readDocument()` returns `[]` and the next
`writeAll()` overwrites the file at the current `schemaVersion`.

Confirmed by probe:

```
BEFORE : {"schemaVersion":99,"items":[{"id":"newer-plan", ...}]}
save() threw: NO EXCEPTION
AFTER  : {"schemaVersion":2,"items":[{"id":"local-plan", ...}]}
=> future-schema file destroyed: true
```

`src/planner/store.ts:24-31` is **not** an independent reimplementation — it is
the same bug: `FilePlanStore extends JsonFileStore` and inherits the shared
`mutate()`. `FileTaskStore` shares the same base and is affected too. The
read path is safe; only the write path destroys data.

**Fix.** Refuse to write when the on-disk version is newer — throw a
`StoreVersionError` (or quarantine the file) instead of overwriting.

### 1.9 `pipeline create` can brick a project

`src/cli/commands/pipelines.ts:208-227` — creating a pipeline whose name
already exists writes a second pipeline with the same id and exits 0. Every
subsequent config load then fails.

Confirmed end-to-end:

```
$ omninode pipeline create demo --from def.yaml   -> Created pipeline "demo"   (exit 0)
$ omninode pipeline create demo --from def2.yaml  -> Created pipeline "demo"   (exit 0)  <-- no error
$ omninode pipeline list  -> error: [CONFIG_INVALID] Duplicate pipeline name "demo" ... (exit 3)
$ omninode status         -> error: [CONFIG_INVALID] Duplicate pipeline name "demo" ... (exit 3)
```

Recovery requires `omninode init --force`, which **destroys the whole project
config** (providers, agents, roles, pipelines).

Note the mechanism: the generated YAML *passes* the zod schema — it is rejected
by the loader's separate duplicate-name assertion, which the create path never
runs. So the fix belongs in the create path (reject a duplicate name up front),
not in the schema.

### 1.10 An empty config file crashes with an opaque `TypeError`

`src/config/loader.ts:140` — an empty or comment-only YAML file produces
`Cannot read properties of undefined` instead of a clean `ConfigError` /
`CONFIG_INVALID`.

**Fix.** Validate the parsed document's shape before accessing it and raise
`CONFIG_INVALID` with an actionable message.

---

## 2. High — confirmed, with impact

| # | Location | Finding | Conf |
| --- | --- | --- | --- |
| H1 | `src/config/loader.ts:143` | The profile example in `docs/CONFIGURATION.md:41` is **unloadable** — it fails with `CONFIG_INVALID`. The docs teach a config that does not work. | yes |
| H2 | `src/cli/commands/config.ts:29,63,81` | The whole `config` command group ignores the global `--config` and `--profile`. `config show --config <path>` reads the wrong file; `config profiles --profile X` is ignored. Other command groups honour them. | yes |
| H3 | `src/cli/exit-codes.ts:39` | A task ending in status `unknown` — the normal outcome of an agent timeout — makes the CLI exit **0**. CI silently treats a timed-out task as a pass. | yes |
| H4 | `src/agent-protocol/codec.ts:158-175` | `ProtocolDecoder.push()` is **O(n²)** on a newline-free stream (it re-scans/re-concatenates the whole buffer on every push). The project's own `tests/protocol-fuzz.test.ts:147` case is timing-fragile: `vitest.config.ts` sets no `testTimeout`, so it inherits the 5 s default. It passed in a clean local run, but it is a coin-flip in CI. | yes |
| H5 | `src/agent-protocol/codec.ts:118` | The 1 MiB message limit counts **UTF-16 code units, not bytes**. A 600,078-unit CJK message (1.8 MB UTF-8) is accepted — 1.7× over the documented byte limit. The error text "message of N bytes" also reports characters. | yes |
| H6 | `src/persistence/json-file-store.ts:58` | `writeFileAtomic` uses a **fixed temp path**, so two concurrent writers corrupt each other's file. | yes |
| H7 | `src/memory/local.ts:29` | The `token.length >= 4` rule silently disables text search for short queries: `retrieve({text:"api"})` returns 0 results with no warning, and `retrieve({tags:["api"], text:"api"})` returns **0** where the tag alone would have matched. It reaches the agent context path (`contextFor({objective:"api"})` → 0 entries) and the CLI (`omninode memory query api` → "No relevant memory found."). | yes |
| H8 | `src/reports/aggregate.ts:62` | "Agreement" is counted per **report occurrence**, not per distinct agent, so an agent that reports twice is double-weighted. | yes |
| H9 | `src/reports/aggregate.ts:157` | When agents' recommendations conflict, **every** agent's fix is attributed to the first agent. | yes |
| H10 | `src/providers/omnihilbras/index.ts:63` | `connectAndRegister` reads `process.env` directly instead of the injected environment, so a caller-supplied env is ignored. | yes |
| H11 | `src/providers/omnihilbras/index.ts:30,33` | Every `listModels()` call performs **two** `/models` requests. | yes |
| H12 | `src/providers/openai-compatible/index.ts:367` | A mid-stream SSE failure escapes as a **raw, un-normalized error** instead of the provider error type, so callers cannot handle it uniformly. | yes |
| H13 | `src/config/migrate-config.ts:33,62` | The agent half of the v1→v2 config migration **never runs** — `doc.getIn([..., "length"])` is `undefined` for a YAML mapping, so the branch is never taken and v1 configs with `agents:` are silently not migrated. | yes |
| H14 | `src/agents/process/index.ts:298` | The documented interactive QUESTION → RESPONSE round trip is **never performed** by the process adapter; `src/agent-protocol/session.ts:115` is unreachable from the CLI. | yes |
| H15 | `src/agent-protocol/codec.ts:169` | After an OVERSIZED violation the decoder does **not resynchronise** to the next newline, so the tail of the oversized line is re-parsed and produces a second, bogus `INVALID_JSON` violation on the task's `protocol.violations`. | yes |
| H16 | `src/agent-protocol/codec.ts:67` | The legacy v1 branch hardcodes `timestamp: new Date().toISOString()`, silently replacing the agent's timestamp — v1 agents are not traceable, and `timestamp: 123` is accepted for v1 but rejected for v2. | yes |
| H17 | `src/tasks/engine.ts:233` | A memory write-back failure makes `TaskEngine.run()` **reject after the task already succeeded** (the record says `completed`, the caller sees an exception). | yes |
| H18 | `src/agents/cwd.ts:38-47` | The "access" check is a no-op duplicate `statSync` of the path checked immediately before it, so the documented permission validation cannot fail. | yes |
| H19 | `src/registry/index.ts:38` | `omninode models --capability <c>` can **never** return a model — `ModelInfo.capabilities` is never populated by any provider. | yes |
| H20 | `src/errors/index.ts:19` | `PLANNER_FAILED` is never thrown; the planner's transport failures are mis-coded. | yes |

---

## 3. Dead code and unimplemented features

No literal `TODO` / `not implemented` / `HACK` markers exist anywhere in
`src/`. The gaps are **behavioural**: code that is parsed, exported, documented
or displayed but never actually read, honoured, or sent.

### 3.1 Parsed, documented, or displayed — then ignored

| Location | Feature | Status |
| --- | --- | --- |
| `src/config/loader.ts:109`, `src/config/profiles.ts:83` | `OMNINODE_CONFIG` | Documented as the **highest-precedence** config source in `docs/CONFIGURATION.md:12`, `docs/DEVELOPMENT.md` and `CHANGELOG.md`. **Never read anywhere in `src/`.** |
| `src/config/schema.ts:16`, `src/config/loader.ts:333` | `provider.enabled` | Parsed, mapped, and displayed as "(disabled)" by `providers list` — but **never honoured**. A disabled provider is still created and used. |
| `src/config/loader.ts:367` | `preferred_agents`, `system_prompt` | Parsed, validated and mapped onto `RoleConfig` — **never consumed** by the role or task engine. |
| `src/types/agent.ts:47` | `AgentConfig.allowedModels` | Declared — **never honoured** when dispatching a task. |
| `src/types/provider.ts:52` | `ProviderConfig.capabilities` | Never populated; the documented `capabilities:` YAML key is **rejected by the schema** (`src/config/schema.ts:8`). |
| `src/providers/errors.ts:124` | `Retry-After` | `parseRetryAfter(undefined)` is called with a literal `undefined`, so `details.retryAfterMs` is **never** populated. |
| `src/providers/factory.ts:43` | `shared` options object | Built, then **discarded**. |
| `src/config/profiles.ts:22` | `KNOWN_PROFILES` | Exported, never used. |
| `src/config/loader.ts:253` | `agent.integration !== "custom"` | Unreachable branch. |
| `src/pipelines/engine.ts:121` | `budgetContext` | Computes a value it never uses; its fallback branch is unreachable. |
| `src/agents/env.ts:39-59` | unknown `env_policy` | `buildChildEnv` has no `default` branch, so an unrecognised policy returns `undefined` and `spawn` then **inherits the entire parent environment**, API keys included. The config file is safe (`env_policy` is a zod enum at `src/config/schema.ts:33`), so this is only reachable through the programmatic `AgentConfig` API. |

### 3.2 Exported but never called

| Location | Symbol |
| --- | --- |
| `src/cli/commands/shared.ts:7` | `notImplemented()` — the whole "not implemented" error path (and exit code 9) is **unreachable** in production. |
| `src/cli/index.ts:84` | `handleError` — exported, never imported. |
| `src/agent-protocol/session.ts:142` | `decodeStream`, `requireCompletion` — exported, never called; the only v2 adapter re-implements the logic without awaiting. |
| `src/agent-protocol/session.ts:55` | `ProtocolSession.helloAck()` — never called, so **HELLO_ACK is never sent**. |
| `src/agents/process/index.ts:284` | `runningTaskIds()` — never called anywhere. |
| `src/memory/service.ts:82` | `MemoryService.isRequired` — no callers. |
| `src/memory/local.ts:116` | `count()` — never called, not part of the contract. |
| `src/memory/index.ts:1` | `keywords` — re-exported from the internal barrel, imported nowhere. |
| `src/planner/schema.ts:70` | `PlanJsonInput` — exported, never used. |
| `src/reports/schema.ts:107` | `normalizeFinding` — a second, divergent normalization implementation that nothing uses. |
| `src/types/task.ts:26` | `TERMINAL_TASK_STATUSES` — **zero references** anywhere in the repo. |

### 3.3 Declared in the public surface but unreachable at runtime

| Location | Declaration |
| --- | --- |
| `src/types/task.ts:17` | The `waiting` task status is advertised but **no state machine transition can produce it**. |
| `src/tasks/engine.ts:37` | Two task states are unreachable: `waiting` and `partially_completed`. |
| `src/types/agent.ts:8-14` | `AgentStatus` declares six states; the runtime produces one. |
| `src/types/task.ts:60-61` | `TaskResult.reportId` and `TaskResult.artifacts` are never written by the task engine. |
| `src/types/task.ts:56` | `TaskContext.memoryKeys` is never set or read. |
| `src/types/pipeline.ts:123` | `PipelineRunOptions.maxAttempts` is declared but never read; `PipelineRun.attempt` is always 1 and `attempts[]` always holds one entry. |
| `src/types/role.ts:12-13` | `RoleDefinition.preferredAgents` / `systemPrompt` are never consumed. |
| `src/types/protocol.ts:1-35` | The v1 protocol types are exported publicly but describe a wire format the runtime rejects. |
| `src/types/project.ts:1-14` | The `Project` interface is exported and documented as Stable but never imported, and does not match the runtime shape. |
| `src/memory/service.ts:18` | `MemoryContextQuery.project` is public API, populated by the engine, and never read. |
| `src/audit/index.ts:27` | Two `AuditAction` members (`memory.context.gathered`, `memory.outcome.recorded`) and `AuditEvent.actor` are never produced. |
| `src/tasks/engine.ts:155` | The same two audit actions are declared but never emitted. |
| `src/reports/extract.ts:11` | `ExtractionMeta.model` is never supplied, so `Report.model` can never be set. |
| `src/planner/heuristic.ts:20-23,55,58` | `ContributedFinding.agent` is computed but never read. |
| `src/planner/types.ts:19,22,23` | Three `PlanRequest` fields are never supplied or read by the only producer. |
| `src/pipelines/engine.ts:63-66` | `RunPipelineOptions` is a public type that no function accepts. |
| `src/agents/process/index.ts:229` | The `timed_out` task state is unreachable for process agents. |
| `src/agents/process/index.ts:326-338` | `ARTIFACT` messages are decoded and collected, then **silently dropped**. |
| `src/agent-protocol/session.ts:33` | ARTIFACT payloads are collected into a write-only sink and never surfaced. |
| `src/agent-protocol/types.ts:55` | Four published payload-schema types are never used to validate anything. |
| `src/config/schema.ts:132` | `AppConfigYaml`, `ProjectConfigYaml`, `PlannerConfigYaml`, `PipelineStepConfigYaml` are declared but never used. |
| `src/agents/process/index.ts:279` | The `CANCEL` protocol message is never sent. |
| `src/pipelines/engine.ts:665-675` | Three `PlanRequest` fields are never populated, so the planner never receives memory or context. |

### 3.4 Documented but not implemented

- `docs/CONFIGURATION.md:12` — `OMNINODE_CONFIG` (see 3.1).
- `docs/CONFIGURATION.md:41` — the profile example does not load (H1).
- `docs/PROTOCOL.md` — the RESPONSE flow is unreachable from the CLI (H14); the HELLO handshake is never answered.
- `docs/API.md` — **9 documented public names are not in the package `.d.ts` at
  all**: `ReportValidationResult`, `KNOWN_PROFILES`, `ConfigSources`,
  `AuthRef`, `ProviderErrorKind`, `HttpResponseError`, `STORE_FILES`, `EXIT`,
  `ExitCode`.

---

## 4. Release and CI defects

| Location | Finding | Conf |
| --- | --- | --- |
| `.github/workflows/release.yml:31` | The publish path **never runs the release gates**. | yes |
| `.github/workflows/release.yml:36` | The git tag is **never compared** against the published package version, so a mismatched tag publishes silently. | yes |
| `scripts/release-gates.mjs:45` | `execFileSync("npm", …)` cannot launch `npm.cmd` on Windows — the package gate always fails there. The failure is swallowed by the `catch` at `:51`, and the asserting test at `tests/release-gates.test.ts:109` is skipped on the Windows lane (it runs `npm test` before `npm run build`, and `dist/` is untracked), so the defect is currently invisible. Plain `"npm.cmd"` is **not** a valid fix — Node disallows direct `.cmd` spawning. | partial |
| `vitest.config.ts` | No `testTimeout` is set, so the coverage CI job inherits vitest's 5 s default and the fuzz test is fragile (H4). | yes |
| `vitest.config.ts` | Coverage thresholds are a **tree-wide average** (85/75/88/85), so a brand-new untested module can be absorbed by the average — the "do-not-decrease" claim in `ci.yml:66` is not actually enforced. | yes |
| `scripts/release-gates.mjs:73` | The `.tgz` and `.omninode/` forbidden-content checks are unreachable. | yes |
| `tests/release-gates.test.ts:119` | Asserts only on `result.files`, which is `[]` on Windows — the test **passes vacuously** and would pass even if the package shipped `tests/` and `src/`. | yes |

---

## 5. Test-suite problems

- `tests/protocol-fuzz.test.ts:147` — the "bounds an endless no-newline stream"
  case exceeds vitest's default 5 s timeout under load. Not reproduced in a
  clean local run, but it is a real CI flake risk (H4).
- `tests/api-surface.test.ts:9` — the guard's stated contract ("every runtime
  export named in `docs/API.md` must remain exported") is not what the test
  actually checks, so the documented drift in §3.4 is invisible to it.
- `tests/release-gates.test.ts:109` — skipped on the Windows lane and skipped
  whenever `dist/` is absent.
- `tests/release-gates.test.ts:119` — vacuous on Windows.
- No test anywhere passes `role` to `contextFor` / `gatherContext`, so the role
  memory path is untested (it happens to work — see §6).
- `tests/public-api.test.ts` asserts a runtime export count of 80–130, which
  is why the two phantom exports in §1.1 escaped detection.

---

## 6. Refuted findings (recorded for honesty)

These were reported by the scan and then **disproved** by executable probe.
They are listed so they are not re-investigated.

- **`src/memory/service.ts:92` — "role is a hard AND-filter that hides
  role-tagged memory"** — REFUTED. The query sends exactly one tag, so AND ≡
  "entry carries the role tag", which is a match, not an exclusion. A probe
  confirmed a `known-problems`-tagged entry *is* returned and *does* reach the
  agent context. (The provider-level AND only bites with ≥2 query tags.)
- **`src/memory/service.ts:139` — "`recordTaskOutcome` throws, contradicting its
  best-effort contract"** — REFUTED. The throw is specified behaviour, documented
  in `src/memory/service.ts:6-8` and `docs/MEMORY.md`, and asserted by
  `tests/memory-v2.test.ts:193-202` and `tests/failure-matrix.test.ts:339-367`.
  The real contract violation is on the **engine** side (H17).
- **`src/pipelines/engine.ts:586` — "one branch's rejection discards sibling
  results"** — PARTIALLY CONFIRMED. An *agent* failure is caught and resolved
  as a failed task, so siblings survive (`run.status = "partial"`). The abort
  only happens when `tasks.run` itself throws (infrastructure failure) — and
  even then the sibling's task output survives in the task store; what is lost
  is the pipeline run record and downstream steps.
- **`src/reports/extract.ts:84` + `src/reports/store.ts:35` — cross-agent
  report-id collision** — PARTIALLY CONFIRMED. The mechanism is exactly right
  (same `taskId` → identical `${taskId}-report` ids; `saveReports` upserts by
  id, so the earlier report is destroyed and the log still says "Stored 2
  report(s)"), but the cross-agent collision is **not reachable through any
  shipped code path**. The in-tree data loss comes from a different line.
- **`src/planner/store.ts:24-31` — independent reimplementation of the
  future-schema bug** — REFUTED as an independent bug: it is the same shared
  `JsonFileStore.mutate()` helper (§1.8). Fixing the base class fixes all three
  stores.

---

## 7. Recommended fix order

1. **§1.1** — the published package is broken for consumers. One-line export
   fix, highest blast radius.
2. **§1.2, §1.3, §1.4** — the three state-machine defects that silently lose
   or corrupt task/run state. They share one root cause: state transitions are
   not exception-safe or atomic.
3. **§1.8** — silent destruction of a future-version store file. Data loss
   across upgrades, and it affects three stores at once.
4. **§1.5, §1.6, §1.7** — process-adapter lifecycle: hangs, process crashes,
   and a Ctrl+C that no longer exits.
5. **§1.9, §1.10** — CLI data-loss and an opaque crash.
6. **§3.1** — either honour the parsed-but-ignored config keys or delete them.
   `provider.enabled` and `OMNINODE_CONFIG` are the two that actively mislead
   users.
7. **H1, H2, H3** — documentation that teaches a broken config; a global flag
   that a whole command group ignores; and a timeout that exits 0.
8. **§4** — add the release gates to the publish path, and compare the git tag
   against the package version before publishing.
9. **§5** — `testTimeout` in `vitest.config.ts`, per-file coverage thresholds,
   and fix the two vacuous tests.

---

## 8. Remediation status

Every confirmed critical and high finding, and where it was fixed. Branch:
`fix/audit-m0-m4-correctness`. Each fix ships with a regression test that
fails without it.

**Status: every confirmed critical and high finding is fixed.** The gate is
green: `npm run verify` (lint + typecheck + 70 test files / 1017 tests +
build), `npm run test:coverage` (97.12% statements / 90.48% branches / 98.37%
functions / 97.63% lines, and a per-file floor), and `npm run gates`.

| # | Finding | Fixed in | Test |
| --- | --- | --- | --- |
| 1.1 | Published package advertises two non-existent exports | `563c489` | `tests/package-exports.test.ts` |
| 1.2 | A throwing step leaves the run `running` forever | `f07b7b8` | `tests/state-integrity.test.ts` |
| 1.3 | Concurrent `run()` executes the agent twice | `f07b7b8` | `tests/state-integrity.test.ts` |
| 1.4 | `cancel()` destroys the attempt's result/history | `f07b7b8` | `tests/state-integrity.test.ts` |
| 1.5 | stdin never closed in `arg` mode | `3bed470` | `tests/process-lifecycle.test.ts` |
| 1.6 | Un-awaited `session.handle()` can crash the process | `3bed470` | `tests/process-lifecycle.test.ts` |
| 1.7 | SIGINT listener removes Node's default exit | `3bed470` | `tests/process-lifecycle.test.ts` |
| 1.8 | A store file from a newer OmniNode is destroyed | `755a152` | `tests/persistence-durability.test.ts` |
| 1.9 | `pipeline create` can brick a project | `6defc34` | `tests/cli-correctness.test.ts` |
| 1.10 | Empty config crashes with an opaque `TypeError` | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H1 | Documented profile example does not load | `2bd3cfd` | `tests/docs-examples.test.ts` |
| H2 | `config` group ignores `--config` / `--profile` | `6defc34` | `tests/cli-correctness.test.ts` |
| H3 | A timed-out task exits 0 | `6defc34` | `tests/cli-correctness.test.ts` |
| H4 | Protocol message budget counted in code units | `bb5d23b` | `tests/protocol-codec.test.ts` |
| H5 | `ProtocolDecoder` is O(n²) | `bb5d23b` | `tests/protocol-codec.test.ts` |
| H6 | Decoder does not resync after OVERSIZED | `bb5d23b` | `tests/protocol-codec.test.ts` |
| H7 | `max_output_bytes` counted in code units | `3bed470` | `tests/process-lifecycle.test.ts` |
| H8 | Agreement counted per occurrence, not per agent | `928c20d` | `tests/report-aggregation.test.ts` |
| H9 | Every agent's fix attributed to the first | `928c20d` | `tests/report-aggregation.test.ts` |
| H10 | `connectAndRegister` reads `process.env` | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H11 | `listModels()` performs two requests | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H12 | Mid-stream failure escapes un-normalized | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H13 | The agent half of the config migration never runs | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H14 | QUESTION → RESPONSE round trip unreachable | doc-corrected in `2bd3cfd` | `docs/PROTOCOL.md` |
| H15 | Legacy v1 branch discards the timestamp | `bb5d23b` | `tests/protocol-codec.test.ts` |
| H16 | `Retry-After` never read | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| H17 | Memory write-back rejects after success | `f07b7b8` | `tests/state-integrity.test.ts` |
| H18 | The cwd "access" check can never fail | `3bed470` | `tests/process-lifecycle.test.ts` |
| H19 | `models --capability` can never return a model | v3.0.0 | — |
| H20 | `PLANNER_FAILED` never thrown | v3.0.0 | — |
| — | `provider.enabled` parsed but never honoured | `dbbdea5` | `tests/config-provider-correctness.test.ts` |
| — | `OMNINODE_CONFIG` documented but never read | v3.0.0 | — |
| — | `AgentConfig.allowedModels` never honoured | v3.0.0 | — |
| — | Concurrent atomic writes corrupt each other | `755a152` | `tests/persistence-durability.test.ts` |
| — | stderr flooding truncates but does not kill | `3bed470` | `tests/process-lifecycle.test.ts` |
| — | `cancel()` has no SIGKILL escalation | `3bed470` | `tests/process-lifecycle.test.ts` |
| — | Unknown `env_policy` fails open | `3bed470` | `tests/process-lifecycle.test.ts` |
| — | Release path never runs the gates | `63bdefe` | — |
| — | Tag never compared to the package version | `63bdefe` | — |
| — | `npm.cmd` on Windows fails the package gate | `63bdefe` | `tests/release-gates.test.ts` |
| — | No `testTimeout` in the vitest config | `f679f77` | — |
| — | Coverage gate is a tree-wide average | `b736436` | — |
| — | The package-contents test is vacuous | `63bdefe` | `tests/release-gates.test.ts` |
| — | The api-surface guard checks the wrong contract | `563c489` | `tests/package-exports.test.ts` |

### Extra defects found while closing the coverage gaps

| Finding | Fixed in | Test |
| --- | --- | --- |
| `omninode agent add --allow-env HOME` crashed with `TypeError: previous is not iterable` — the repeatable-option accumulator spread `previous` directly, but Commander passes `undefined` for an option with no default | `2ed3ae4` | `tests/cli-agents-audit-roles-coverage.test.ts` |

**Deferred to v3.0.0** (public-API or semantic changes, per
`docs/ROADMAP_V3.md` principle 4): the `HELLO_ACK` / `CANCEL` / `ARTIFACT`
protocol round trips, `OMNINODE_CONFIG`, model `capabilities`, agent
`allowedModels`, the public-API pruning listed in §3.2–§3.3, and the
remaining 301 medium/low findings in the appendix.

## Appendix — all 391 findings

### `src/agents/` — 34 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| critical | bug | H | `src/agents/process/index.ts:320` | Un-awaited `session.handle()` lets agent stdout crash the whole OmniNode process |
| high | bug | H | `src/agents/process/index.ts:185` | in `input_mode: "arg"` the child's stdin is never closed, so any agent that reads stdin hangs until the timeout |
| high | resource | H | `src/agents/process/index.ts:185` | in `arg` input mode the child's stdin is never closed, so agents that read stdin hang until the timeout |
| high | unimplemented | H | `src/agents/process/index.ts:298` | the QUESTION → RESPONSE round trip is never performed by the process adapter |
| high | bug | H | `src/agents/process/index.ts:387-397` | Installing a SIGINT/SIGTERM listener permanently removes Node's default exit behaviour, so Ctrl-C no longer stops OmniNode. |
| medium | dead-code | H | `src/agents/cwd.ts:38-47` | The "access"/permission check is a no-op duplicate `statSync`, so the documented permission validation never happens. |
| medium | bug | H | `src/agents/env.ts:39-59` | An unrecognised `env_policy` fails open: the child inherits the entire parent environment, including API keys. |
| medium | bug | H | `src/agents/process/index.ts:163` | `max_output_bytes` counts UTF-16 code units, not bytes, so the documented 5 MiB budget is exceeded and the runaway kill never fires |
| medium | inconsistency | H | `src/agents/process/index.ts:171` | stderr over the limit is truncated but the agent is *not* killed and the run still reports success |
| medium | inconsistency | H | `src/agents/process/index.ts:171-177` | stderr flooding is truncated but never kills the agent, unlike stdout. |
| medium | bug | H | `src/agents/process/index.ts:185-192` | In `arg` mode the child's stdin pipe is never closed, so agents that read stdin block until the task timeout. |
| medium | resource | M | `src/agents/process/index.ts:214` | the run promise can hang forever when a grandchild holds the stdout pipe |
| medium | resource | M | `src/agents/process/index.ts:279` | `cancel()` sends SIGTERM with no SIGKILL escalation, unlike the timeout path |
| medium | unimplemented | H | `src/agents/process/index.ts:279` | the `CANCEL` protocol message is never sent |
| medium | bug | H | `src/agents/process/index.ts:279-282` | `cancel()` sends SIGTERM only and never escalates to SIGKILL. |
| medium | unimplemented | H | `src/agents/process/index.ts:295` | the protocol QUESTION→RESPONSE round trip and the HELLO handshake are never wired |
| medium | unimplemented | M | `src/agents/process/index.ts:314` | The protocol RESPONSE flow documented in docs/PROTOCOL.md is unreachable from the CLI |
| medium | bug | H | `src/agents/process/index.ts:318` | `session.handle()` is called without `await` (floating promise) in the protocol interpreter |
| medium | bug | H | `src/agents/process/index.ts:318-324` | `session.handle()` is async but is never awaited: floating promise, and the `questions` diagnostic is captured before it is filled. |
| medium | bug | H | `src/agents/process/index.ts:353` | A protocol agent that produced no usable output is reported as `completed`. |
| medium | bug | H | `src/agents/process/index.ts:387` | SIGINT kills the current child but does not stop the pipeline, and it removes Node's default exit behaviour |
| medium | bug | H | `src/agents/process/index.ts:433-435` | `sanitizeChunk` corrupts multi-byte UTF-8 that straddles a chunk boundary. |
| low | dead-code | H | `src/agents/cwd.ts:38` | the "Access check" re-stats the same path and can never fail |
| low | bug | H | `src/agents/cwd.ts:51` | `rel.startsWith("..")` misclassifies an in-project directory whose name starts with two dots. |
| low | bug | M | `src/agents/factory.ts:24-27` | `assertAgentConfig` demands a `command` for the `process` integration even when a custom adapter is registered under that key. |
| low | bug | M | `src/agents/process/index.ts:103-105` | The confinement boundary is `process.cwd()`, not the project root of the loaded configuration. |
| low | bug | M | `src/agents/process/index.ts:124` | the `running` map is keyed by `taskId`, so concurrent runs of one task evict each other |
| low | resource | M | `src/agents/process/index.ts:139` | The SIGKILL escalation timer is never cancelled, so it can signal a recycled process group. |
| low | dead-code | H | `src/agents/process/index.ts:229` | the `timed_out` task state is unreachable for process agents |
| low | bug | M | `src/agents/process/index.ts:267-271` | The output-limit error swallows the real termination cause. |
| low | dead-code | H | `src/agents/process/index.ts:284` | `runningTaskIds()` is never called anywhere in src/, tests/ or docs/ |
| low | dead-code | H | `src/agents/process/index.ts:326-338` | `ARTIFACT` messages are decoded and collected but silently dropped. |
| low | resource | H | `src/agents/process/index.ts:390` | the SIGINT/SIGTERM handler suppresses Node's default termination |
| low | contract | H | `src/agents/process/index.ts:452-453` | `normalizeReport` casts `findings`/`recommendations` without validating them, so the returned object is not a valid `Report`. |

### `src/cli/` — 44 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| critical | bug | H | `src/cli/commands/pipelines.ts:208-227` | `pipeline create` can write a config that OmniNode refuses to load |
| high | bug | H | `src/cli/commands/config.ts:29` | `config show`, `config validate` and `config profiles` ignore the global `--config`/`--profile` options |
| high | bug | H | `src/cli/commands/config.ts:29,63,81` | `config show` / `config profiles` / `config validate` ignore `--config` and `--profile`, so they report on a *different* file than the one they name |
| high | bug | H | `src/cli/commands/pipelines.ts:217` | `pipeline create` can duplicate a pipeline id and render the whole project unusable |
| high | inconsistency | H | `src/cli/exit-codes.ts:39` | a task that ends `unknown` (the normal outcome of an agent timeout) exits with code 0 |
| medium | bug | H | `src/cli/commands/agents.ts:136` | the duplicate-agent error points at a command that does not exist |
| medium | bug | H | `src/cli/commands/config.ts:62` | `omninode config profiles` crashes on an empty configuration file |
| medium | bug | H | `src/cli/commands/init.ts:14` | the project name is interpolated raw into YAML and can produce a broken configuration |
| medium | bug | H | `src/cli/commands/memory.ts:71` | `--scope` is not validated and invalid scopes are persisted to disk |
| medium | bug | H | `src/cli/commands/migrate.ts:21` | `omninode migrate` ignores `--config` and always operates on the current working directory |
| medium | bug | H | `src/cli/commands/migrate.ts:41` | `omninode migrate` ignores `--config` and always migrates `./omninode.yaml` and `./.omninode` |
| medium | bug | H | `src/cli/commands/models.ts:59` | `omninode models --json` emits human-readable lines before the JSON, so the output is not machine-parseable |
| medium | bug | H | `src/cli/commands/pipelines.ts:208` | a pipeline file's own `id` silently overrides the id given on the command line |
| medium | contract | H | `src/cli/commands/pipelines.ts:215` | `pipeline create` validates the definition in the wrong shape, so `depends_on` is never checked |
| medium | bug | H | `src/cli/commands/pipelines.ts:215` | `omninode pipeline create` validates the wrong object shape |
| medium | inconsistency | H | `src/cli/commands/pipelines.ts:96` | `pipeline validate` does not perform the validation the docs attribute to it |
| medium | bug | H | `src/cli/commands/plan.ts:41` | a missing plan is reported as `PLAN_INVALID` (exit 2) instead of "not found" (exit 8) |
| medium | resource | H | `src/cli/commands/providers.ts:136` | `provider remove` destroys every comment in the `project.providers` block |
| medium | bug | H | `src/cli/commands/reports.ts:85` | `omninode report show` prints every evidence entry as `[object Object]` |
| medium | bug | H | `src/cli/commands/tasks.ts:157-189` | `task status` / `task inspect` never show `result.protocol`, which the docs say they do |
| medium | bug | H | `src/cli/exit-codes.ts:29` | "not found" maps to different exit codes depending on the resource type |
| medium | inconsistency | M | `src/cli/exit-codes.ts:29-31` | the documented "not found" exit code (8) is unreachable for agent and provider errors |
| medium | bug | H | `src/cli/index.ts:64` | `--config` / `--profile` never reach the logger configuration |
| medium | bug | H | `src/cli/index.ts:64-76` | The logging configuration is applied before `--config` / `--profile` are known |
| medium | bug | H | `src/cli/index.ts:75` | Logging is configured from the default config because `applyLoggingConfig()` runs before the `preAction` hook |
| medium | unimplemented | H | `src/cli/options.ts:10` | `OMNINODE_CONFIG` is documented as precedence level 2 but is never read |
| low | inconsistency | H | `src/cli/commands/agents.ts:171` | `agent test` hardcodes exit code 1 instead of using `exitCodeForStatus` |
| low | inconsistency | M | `src/cli/commands/audit.ts:16-20` | `omninode audit` drops the correlation ids the docs emphasise |
| low | bug | H | `src/cli/commands/audit.ts:8` | `--limit 0` prints the entire log, and a non-numeric limit is accepted |
| low | inconsistency | H | `src/cli/commands/migrate.ts:41` | `omninode migrate` ignores `--config` |
| low | inconsistency | H | `src/cli/commands/pipelines.ts:12` | no `pipeline remove` (or `agent remove`) although `provider remove` exists |
| low | bug | H | `src/cli/commands/pipelines.ts:202` | malformed YAML is not detected; the `try/catch` claims to catch it but `parseDocument` never throws |
| low | contract | H | `src/cli/commands/plan.ts:41` | a missing plan is reported with the `PLAN_INVALID` error code |
| low | bug | H | `src/cli/commands/reports.ts:84` | object evidence is printed as `[object Object]` |
| low | bug | H | `src/cli/commands/reports.ts:86` | `report show` prints "[object Object]" for evidence |
| low | bug | M | `src/cli/commands/security.ts:23` | an unknown action exits 0 |
| low | resource | M | `src/cli/commands/shared.ts:48` | configuration files are written non-atomically |
| low | dead-code | H | `src/cli/commands/shared.ts:7` | `notImplemented()` is exported but never called anywhere |
| low | resource | M | `src/cli/commands/status.ts:48` | `status`, `memory status` and `provider inspect` issue unbounded memory queries |
| low | inconsistency | H | `src/cli/commands/tasks.ts:191` | `truncate` is re-implemented locally instead of imported from `shared.ts` |
| low | bug | H | `src/cli/commands/tasks.ts:81` | an invalid `--status` value is silently accepted and returns an empty list |
| low | contract | M | `src/cli/exit-codes.ts:31` | `*_NOT_FOUND` codes never reach the documented "not found" exit code for the provider and agent domains |
| low | inconsistency | M | `src/cli/index.ts:64-72` | logger configuration is applied before `--config`/`--profile` are parsed |
| low | dead-code | M | `src/cli/index.ts:84` | `handleError` is exported but never imported anywhere |

### `src/persistence/` — 11 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| critical | bug | H | `src/persistence/json-file-store.ts:127` | a store file written by a newer OmniNode is silently destroyed on the next write |
| critical | contract | H | `src/persistence/store-types.ts:10` | `MemoryStore` is emitted as a value export in the published `.d.ts` but has no runtime binding |
| high | bug | H | `src/persistence/json-file-store.ts:58` | `writeFileAtomic` uses a fixed temp path, so two concurrent writers corrupt each other |
| medium | resource | H | `src/persistence/json-file-store.ts:127` | a store written by a newer OmniNode is silently treated as empty and then overwritten |
| medium | bug | H | `src/persistence/json-file-store.ts:145` | `readDocument` never checks that `items` is an array, so a malformed store crashes the CLI and loses data |
| medium | contract | H | `src/persistence/json-file-store.ts:176` | The documented durability ("temp file → fsync → atomic rename → directory fsync") is not the default and is never enabled |
| medium | inconsistency | H | `src/persistence/json-file-store.ts:53` | the documented durability ("temp file → fsync → atomic rename → directory fsync") is not the default |
| medium | resource | H | `src/persistence/json-file-store.ts:58` | Atomic writes use a predictable temp path and `writeFile` follows symlinks |
| low | bug | H | `src/persistence/json-file-store.ts:125` | a structurally corrupt store is silently overwritten instead of being quarantined |
| low | resource | M | `src/persistence/json-file-store.ts:142` | an unreadable (but valid) store file is treated as empty and overwritten |
| low | resource | H | `src/persistence/json-file-store.ts:61` | a failed write leaves `<target>.tmp` behind |

### `tests/` — 16 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| critical | bug | H | `tests/protocol-fuzz.test.ts:147` | the suite is RED: "bounds an endless no-newline stream" exceeds vitest's default 5 s timeout |
| high | contract | H | `tests/api-surface.test.ts:9` | the guard's stated contract ("every runtime export named in docs/API.md must remain exported") is not implemented |
| medium | bug | H | `tests/agent-hardening.test.ts:159` | `expect(["resolved", "rejected"]).toContain(settled.kind)` is a tautology |
| medium | bug | H | `tests/architecture.test.ts:84` | "every src file maps to a known layer" is a tautology that can never fail |
| medium | bug | H | `tests/cli-tasks.test.ts:90` | "task run exits non-zero when the agent fails" never checks the exit code |
| medium | bug | H | `tests/execution-states.test.ts:246` | "downstream still ran" is asserted with `toBeDefined()`, which is insensitive to the behaviour it claims to test |
| medium | resource | H | `tests/failure-matrix.test.ts:412` | the hanging HTTP server is closed only on the success path |
| medium | bug | H | `tests/pipeline-lifecycle.test.ts:186` | the "interrupted-run recovery awareness (§9.6)" test exercises no recovery logic at all |
| medium | contract | H | `tests/planner.test.ts:148` | `PLANNER_FAILED` is a declared error code that no code path can produce |
| medium | bug | H | `tests/providers.test.ts:80` | "maps HTTP 401 to PROVIDER_AUTH_FAILED" never reaches the HTTP layer |
| medium | contract | H | `tests/public-api.test.ts:16` | `WITHHELD_INTERNALS` directly contradicts `docs/API.md` |
| medium | bug | H | `tests/resource-limits.test.ts:57` | "keeping the most recent part" is never asserted |
| low | bug | H | `tests/config.test.ts:122` | the `details` assertion is inside a catch that may never run |
| low | bug | H | `tests/failure-matrix.test.ts:366` | `expect(entries).toEqual([])` asserts on an array that is never written to |
| low | bug | M | `tests/memory-v2.test.ts:115` | "survives the local→remembera round trip" contains no round trip |
| low | resource | H | `tests/tasks.test.ts:53` | twelve hard-coded, never-cleaned `/tmp` directories |

### `src/agent-protocol/` — 25 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/agent-protocol/codec.ts:158` | `ProtocolDecoder.push()` is O(n²) on a newline-free stream |
| high | bug | H | `src/agent-protocol/codec.ts:159` | `ProtocolDecoder.push()` is quadratic on a newline-free stream, and the project's own fuzz test times out |
| high | bug | H | `src/agent-protocol/codec.ts:160-175` | `ProtocolDecoder.push` is quadratic and the new fuzz test times out |
| high | unimplemented | H | `src/agent-protocol/session.ts:115` | The documented interactive QUESTION → RESPONSE round trip cannot reach a real agent |
| high | inconsistency | H | `src/agent-protocol/session.ts:98` | `CANCELLED` and `TASK_REQUEST` are declared agent→node types but are recorded as protocol violations |
| medium | bug | H | `src/agent-protocol/codec.ts:118` | the "1 MiB" message limit is measured in UTF-16 code units, not bytes |
| medium | bug | H | `src/agent-protocol/handshake.ts:17` | `parseHello` performs no protocol-version check |
| medium | inconsistency | H | `src/agent-protocol/handshake.ts:45` | `buildHelloAck` advertises a different protocol set than the build actually accepts |
| medium | dead-code | H | `src/agent-protocol/session.ts:142` | `decodeStream` and `requireCompletion` are exported but never called, and `decodeStream` is unreachable by consumers |
| medium | unimplemented | H | `src/agent-protocol/session.ts:142-148` | `decodeStream` is never used; the only v2 adapter re-implements it without awaiting and never answers the agent |
| medium | contract | H | `src/agent-protocol/session.ts:150` | `requireCompletion` never requires a completion |
| medium | contract | H | `src/agent-protocol/session.ts:150-154` | `requireCompletion()` does not require a completion |
| medium | unimplemented | H | `src/agent-protocol/session.ts:33` | ARTIFACT payloads are collected into a write-only sink and never surfaced |
| medium | dead-code | H | `src/agent-protocol/session.ts:55` | `ProtocolSession.helloAck()` is never called; HELLO_ACK is never sent |
| medium | unimplemented | H | `src/agent-protocol/session.ts:55` | the HELLO → HELLO_ACK handshake is never answered |
| medium | bug | H | `src/agent-protocol/session.ts:60` | `handle()` is async but the only in-repo caller does not await it, losing questions |
| medium | bug | H | `src/agent-protocol/session.ts:98-105` | `CANCELLED` and `TASK_REQUEST` are accepted by the codec but flagged as protocol violations |
| medium | dead-code | H | `src/agent-protocol/types.ts:55` | Four published payload-schema types are never used to validate anything |
| medium | contract | H | `src/agent-protocol/types.ts:88` | `ReportPayload` contradicts the documented and implemented REPORT wire format |
| low | contract | H | `src/agent-protocol/codec.ts:107` | `metadata` accepts an array but is typed `Record<string, unknown>` |
| low | bug | H | `src/agent-protocol/codec.ts:140` | `encodeMessage` throws a bare `Error` instead of a typed protocol error |
| low | bug | H | `src/agent-protocol/codec.ts:169` | Decoder does not resynchronise after an OVERSIZED reset, producing a second, bogus violation |
| low | inconsistency | H | `src/agent-protocol/codec.ts:56` | Legacy branch does not enforce the `{type, payload}` shape its own comment claims |
| low | bug | H | `src/agent-protocol/codec.ts:67` | The legacy (v1) branch silently replaces the agent's timestamp instead of preserving it |
| low | inconsistency | M | `src/agent-protocol/session.ts:42` | `ProtocolSession`'s `maxBytes` option bounds only inbound decoding |

### `src/config/` — 34 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/config/loader.ts:140` | An empty (or comment-only) config file crashes with an opaque `TypeError` instead of a `ConfigError` |
| high | contract | H | `src/config/loader.ts:143` | the profile example from `docs/CONFIGURATION.md` makes the configuration unloadable |
| high | bug | H | `src/config/migrate-config.ts:33` | `findConfigV1Patterns` never iterates agents, so the whole agent-migration path is dead |
| high | bug | H | `src/config/migrate-config.ts:33,62` | The agent half of the migration never runs: `doc.getIn([...,"length"])` is `undefined` for a YAML sequence, so `agentCount` is always `0` |
| high | bug | H | `src/config/secrets.ts:39` | The inline-secret scanner rejects legitimate quoted `${VAR}` and `<from-store>` references |
| medium | bug | H | `src/config/default.ts:4` | `omninode init --name` interpolates the name into YAML unescaped, producing an invalid or injected config |
| medium | bug | H | `src/config/default.ts:5` | The project name is interpolated into YAML unescaped, so `omninode init --name "Acme: Corp"` writes an unparseable config |
| medium | dead-code | H | `src/config/loader.ts:109` | `OMNINODE_CONFIG` is documented as the highest-precedence config source but is never read |
| medium | inconsistency | H | `src/config/loader.ts:141-150` | The profile overlay is applied *over* the project/user files, contradicting the documented precedence table |
| medium | bug | H | `src/config/loader.ts:219` | A missing explicit `--config` file raises a raw `ENOENT` Error, not `ConfigError("CONFIG_NOT_FOUND")` |
| medium | bug | H | `src/config/loader.ts:226` | `${VAR}` expansion runs on the raw file text *before* YAML parsing, so an env value containing YAML metacharacters silently corrupts the document |
| medium | bug | H | `src/config/loader.ts:228` | an empty or comment-only `omninode.yaml` crashes the loader with a raw `TypeError` |
| medium | dead-code | H | `src/config/loader.ts:333` | `provider.enabled` is parsed and mapped but never consulted at runtime |
| medium | dead-code | H | `src/config/loader.ts:367` | `preferred_agents` and `system_prompt` are parsed, validated and mapped but never consumed |
| medium | contract | H | `src/config/loader.ts:49` | `AppConfig["logging"]` omits `format`, although the zod schema and the runtime object both carry it |
| medium | contract | H | `src/config/loader.ts:49-51` | `AppConfig.logging` omits `format`, which the schema and loader actually produce |
| medium | resource | H | `src/config/migrate-config.ts:89` | The config file is rewritten non-atomically even though the repo ships an atomic-write helper |
| medium | bug | H | `src/config/profiles.ts:56-58` | `mergeConfig(base, null)` returns `null`, discarding the whole base document |
| medium | dead-code | H | `src/config/profiles.ts:83` | `OMNINODE_CONFIG` is documented as the highest-precedence config source but is never read |
| medium | bug | H | `src/config/profiles.ts:98-112` | `OMNINODE_MEMORY_REQUIRED` / `OMNINODE_MEMORY_PROVIDER` create a `project.memory` section the project never configured |
| medium | dead-code | H | `src/config/schema.ts:16` | the provider `enabled` flag is parsed and displayed but never honoured |
| medium | bug | H | `src/config/secrets.ts:22,29-47` | The inline-secret scanner misses flow-style mappings and any credential that is not stored under a keyword-named key |
| medium | bug | H | `src/config/secrets.ts:29` | The scanner misses inline-flow YAML mappings and block scalars, so real secrets pass the guard |
| low | dead-code | H | `src/config/loader.ts:253` | The `agent.integration !== "custom"` branch in `configDiagnostics` is unreachable |
| low | bug | H | `src/config/loader.ts:253` | `configDiagnostics` reports "no command configured" for native agents |
| low | contract | H | `src/config/loader.ts:50` | `AppConfig.logging` omits `format`, which the loader produces and the CLI consumes |
| low | bug | H | `src/config/migrate-config.ts:29,61` | A malformed YAML file throws a raw `YAMLParseError` instead of a `ConfigError` |
| low | bug | H | `src/config/profiles.ts:107` | `OMNINODE_MEMORY_REQUIRED` only accepts the exact lowercase string `"false"` as "off" |
| low | bug | H | `src/config/profiles.ts:109` | `OMNINODE_MEMORY_REQUIRED` treats every value except the exact string "false" as true |
| low | dead-code | H | `src/config/profiles.ts:22` | `KNOWN_PROFILES` is never used |
| low | bug | H | `src/config/profiles.ts:91,121-127` | A malformed `logging:` block is silently replaced instead of failing loudly |
| low | inconsistency | M | `src/config/profiles.ts:98` | `OMNINODE_MEMORY_REQUIRED` alone silently *enables* memory for projects that opted out |
| low | dead-code | H | `src/config/schema.ts:132` | `AppConfigYaml`, `ProjectConfigYaml`, `PlannerConfigYaml` and `PipelineStepConfigYaml` are exported but never referenced anywhere |
| low | dead-code | H | `src/config/schema.ts:8` | `provider_id` and `capabilities` are documented provider options but are rejected by the strict schema |

### `docs/` — 13 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | contract | H | `docs/API.md:59-65` | eight documented public exports are not reachable from the package root |
| high | bug | H | `docs/CONFIGURATION.md:12` | `OMNINODE_CONFIG` is documented as a config source but is never read by the code |
| high | bug | H | `docs/CONFIGURATION.md:41` | the documented profile example fails to load with `CONFIG_INVALID` |
| medium | contract | H | `docs/API.md:45` | The API inventory lists exports that the package root does not (and deliberately does not) export |
| medium | contract | H | `docs/API.md:73` | the API inventory advertises public exports the package root does not export |
| medium | dead-code | H | `docs/CONFIGURATION.md:16` | `OMNINODE_CONFIG` is documented as an environment-level configuration source but is never read |
| medium | inconsistency | H | `docs/CONFIGURATION.md:37-48` | The documented profile example is rejected by the strict schema |
| medium | contract | M | `docs/PROVIDERS.md:34` | the documented provider YAML is rejected by the configuration schema |
| medium | inconsistency | H | `docs/PROVIDERS.md:4` | "adding a provider … **no core changes**" is not achievable |
| low | inconsistency | H | `docs/API.md:17` | the inventory omits twelve exported symbols |
| low | inconsistency | H | `docs/API.md:59-65` | The documented public API contradicts the code and the API guard test |
| low | inconsistency | M | `docs/CLI.md:8-25` | the command tree omits three existing commands |
| low | inconsistency | H | `docs/PERSISTENCE.md:24` | "Every write is temp file → fsync → atomic rename → directory fsync" is false by default |

### `src/providers/` — 23 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/providers/omnihilbras/index.ts:30` | every `listModels()` call performs two `/models` requests |
| high | bug | H | `src/providers/omnihilbras/index.ts:33` | model discovery issues two identical `GET /models` requests |
| high | bug | H | `src/providers/omnihilbras/index.ts:63` | `connectAndRegister` reads `process.env` instead of the provider's injected environment |
| high | bug | H | `src/providers/openai-compatible/index.ts:367` | mid-stream failures escape as raw, un-normalized errors |
| medium | bug | H | `src/providers/auth.ts:36` | `authHeaders` merges a bearer token into headers without removing a pre-existing `Authorization` header |
| medium | dead-code | H | `src/providers/errors.ts:124` | `parseRetryAfter` is never used with a real value, so `retryAfterMs` is never populated |
| medium | unimplemented | H | `src/providers/errors.ts:124` | `Retry-After` is never read, so `details.retryAfterMs` is always absent |
| medium | contract | H | `src/providers/errors.ts:124` | `retryAfterMs` is never populated, although docs/PROVIDERS.md promises it comes from the `Retry-After` header |
| medium | inconsistency | H | `src/providers/errors.ts:150` | A 5xx with a non-JSON body is classified `UNKNOWN_ERROR` (not retryable) while a 5xx with a JSON body is `SERVER_ERROR` (retryable) |
| medium | bug | H | `src/providers/http.ts:54` | a non-JSON error body is reported as `UNKNOWN_ERROR` and the HTTP status is lost |
| medium | bug | H | `src/providers/http.ts:57` | `requestJson` discards the response headers, so `Retry-After` is never read |
| medium | dead-code | H | `src/providers/openai-compatible/index.ts:148` | `ModelInfo.capabilities` is never populated, so `omninode models --capability <x>` always returns nothing |
| medium | inconsistency | H | `src/providers/openai-compatible/index.ts:185` | stream failures are never recorded in the audit trail |
| medium | inconsistency | M | `src/providers/openai-compatible/index.ts:272` | chat errors omit `durationMs` / `dispatched`, discovery errors include them |
| medium | bug | M | `src/providers/openai-compatible/index.ts:343` | the streaming timeout is a total deadline, so long generations are cut off |
| medium | bug | H | `src/providers/openai-compatible/index.ts:364` | the final SSE event is dropped when the stream ends without a trailing newline |
| medium | contract | H | `src/providers/openai-compatible/index.ts:59` | `config.providerId` can never be populated from a project configuration |
| low | inconsistency | M | `src/providers/errors.ts:93` | `isNetworkError()` disagrees with the classification used by `providerTransportError()` |
| low | dead-code | H | `src/providers/factory.ts:43` | `createProvider` builds a `shared` options object and then discards it |
| low | bug | H | `src/providers/omnihilbras/index.ts:40` | the `connectAndRegister` JSDoc is orphaned above `gatewayMetadata()` |
| low | inconsistency | H | `src/providers/openai-compatible/index.ts:176` | `ModelInfo.supportsVision` and `supportsReasoning` and `ModelStatus` "unavailable"/"deprecated" are never produced |
| low | dead-code | H | `src/providers/openai-compatible/index.ts:277` | the explicit `MODEL_NOT_FOUND` override for HTTP 404 is redundant |
| low | inconsistency | H | `src/providers/openai-compatible/index.ts:290` | one provider failure path is not audited |

### `src/memory/` — 20 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/memory/local.ts:29` | the ≥4-character token rule silently disables text search entirely for short queries |
| high | bug | H | `src/memory/service.ts:139` | `recordTaskOutcome` throws when memory is `required`, contradicting its "best-effort" contract |
| high | bug | H | `src/memory/service.ts:92` | `role` is sent as a hard `tags` AND-filter, hiding the "known problems" memory from every role-bearing task |
| medium | resource | H | `src/memory/local.ts:102` | the memory store grows without bound and is fully re-read and re-written on every task |
| medium | bug | H | `src/memory/local.ts:107` | upsert destroys the original `createdAt` |
| medium | bug | H | `src/memory/local.ts:78` | on-disk entries are never validated, so a malformed store surfaces as an opaque `TypeError` |
| medium | contract | M | `src/memory/remembera.ts:111` | the HTTP status is lost when the error body is not JSON |
| medium | bug | H | `src/memory/service.ts:138` | a memory *write-back* failure turns an already-completed task into a failed `run()` |
| medium | dead-code | H | `src/memory/service.ts:18` | `MemoryContextQuery.project` is public API, is populated by the engine, and is never read |
| medium | bug | H | `src/memory/service.ts:200` | one oversized high-priority entry suppresses *all* lower-priority content |
| low | dead-code | M | `src/memory/index.ts:1` | `keywords` is re-exported from the internal barrel but imported nowhere |
| low | dead-code | H | `src/memory/local.ts:116` | `count()` is never called and is not part of the contract |
| low | dead-code | M | `src/memory/local.ts:16` | `STOPWORDS` contains a duplicate and is never consulted for the "were" token |
| low | inconsistency | M | `src/memory/local.ts:51` | the memory store inherits the weaker write durability while the docs promise the stronger one |
| low | contract | M | `src/memory/remembera.ts:128` | the entry `metadata` field is dropped on retrieval |
| low | contract | H | `src/memory/remembera.ts:136` | `category` is cast to `MemoryCategory` without validation |
| low | dead-code | M | `src/memory/remembera.ts:65` | the published capability metadata is never consumed by any caller |
| low | bug | M | `src/memory/service.ts:152` | entries with an unrecognised `scope` are silently dropped from the text |
| low | bug | M | `src/memory/service.ts:46` | the truncation marker states the opposite of what happened |
| low | dead-code | H | `src/memory/service.ts:82` | `MemoryService.isRequired` has no callers anywhere |

### `src/pipelines/` — 38 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | resource | H | `src/pipelines/engine.ts:233` | A throwing step leaves the persisted run stuck in `running` forever and leaks the `activeRuns` entry |
| high | bug | H | `src/pipelines/engine.ts:315-402` | an exception during step execution leaves the persisted run in `running` forever |
| high | bug | H | `src/pipelines/engine.ts:346-367` | a step-level exception aborts the whole run; the persisted run stays `running` and the `activeRuns` entry leaks |
| high | bug | H | `src/pipelines/engine.ts:586` | `Promise.all` over fan-out tasks: one rejection discards the siblings' results and aborts the run |
| medium | bug | H | `src/pipelines/engine.ts:146` | `persist()` is a read-then-write TOCTOU that can lose a cancellation request |
| medium | bug | H | `src/pipelines/engine.ts:146-154` | `persist()` is a non-atomic read-modify-write and can silently drop a cancellation request |
| medium | bug | H | `src/pipelines/engine.ts:227` | an explicit empty `dependsOn: []` is silently turned into the implicit previous-step dependency |
| medium | dead-code | H | `src/pipelines/engine.ts:414` | `PipelineRun.attempt` is always 1 and `attempts[]` always holds a single entry |
| medium | resource | H | `src/pipelines/engine.ts:456` | an exception during a run leaves the persisted run stuck in `running` forever |
| medium | bug | H | `src/pipelines/engine.ts:456` | the run is never finalized when anything throws |
| medium | inconsistency | H | `src/pipelines/engine.ts:481-495` | `cancel()` accepts a terminal run and rewrites it as cancellation-requested |
| medium | inconsistency | H | `src/pipelines/engine.ts:589-611` | a fan-out whose tasks all end `unknown`/`timed_out` is reported as a hard failure, contradicting both `runSingle` and the project's own state model |
| medium | contract | H | `src/pipelines/engine.ts:621-652` | `PipelineStepRun.executionIds` is never populated for single-agent steps, nor for partial fan-outs |
| medium | bug | H | `src/pipelines/engine.ts:680-686` | `this.getChat()` is called outside the step error boundary, so a missing chat fn aborts the run instead of failing the step |
| medium | inconsistency | H | `src/pipelines/engine.ts:712-723` | the `plan.generated` audit event uses different correlation ids from every other event |
| medium | inconsistency | H | `src/pipelines/engine.ts:743-757` | `formatPlan` drops acceptance criteria, dependencies and source findings |
| low | bug | H | `src/pipelines/engine.ts:108-123` | `budgetContext` returns a string longer than the requested budget when `maxChars < 47` |
| low | dead-code | H | `src/pipelines/engine.ts:121` | `budgetContext` computes a value it never uses, making its fallback branch unreachable |
| low | bug | H | `src/pipelines/engine.ts:121` | `budgetContext` checks the length of the wrong string and breaks below a 47-char budget |
| low | bug | H | `src/pipelines/engine.ts:157-185` | `validate()` accepts a pipeline with zero steps |
| low | dead-code | H | `src/pipelines/engine.ts:283` | `PipelineRun.attempt` is always 1 |
| low | inconsistency | H | `src/pipelines/engine.ts:385-392` | a condition-skipped step is recorded as `cancelled` |
| low | inconsistency | M | `src/pipelines/engine.ts:435` | a cancelled run still collects, stores and generates a combined report |
| low | inconsistency | H | `src/pipelines/engine.ts:449` | `run.reports` holds two different things depending on the pipeline shape |
| low | bug | M | `src/pipelines/engine.ts:450` | `run.reports` is overwritten and reports from non-research steps are lost |
| low | bug | H | `src/pipelines/engine.ts:451` | `run.reports` is overwritten, dropping reports produced by execute/custom steps |
| low | inconsistency | H | `src/pipelines/engine.ts:520-531` | retried steps lose the earlier attempts' task ids |
| low | inconsistency | H | `src/pipelines/engine.ts:556` | An `analyze` step with no agent silently reports `completed` although no work was done |
| low | resource | M | `src/pipelines/engine.ts:570-586` | the agent fan-out is not bounded by `maxParallelSteps` |
| low | bug | M | `src/pipelines/engine.ts:587` | execution correlation ids are dropped when a fan-out is partial or failed |
| low | dead-code | H | `src/pipelines/engine.ts:63-66` | `RunPipelineOptions` is a public type that no function accepts |
| low | inconsistency | H | `src/pipelines/engine.ts:635-645` | a task cancelled mid-flight is recorded as a *failed* step |
| low | inconsistency | H | `src/pipelines/engine.ts:646-651` | single-agent steps never record `executionIds`, research fan-out does |
| low | inconsistency | M | `src/pipelines/engine.ts:659-662` | The planner's `aggregated` report is built differently from the persisted one, and the `maxFindings` branch is a no-op |
| low | unimplemented | H | `src/pipelines/engine.ts:665-675` | three `PlanRequest` fields are never populated, so the planner never receives memory or a task link |
| low | inconsistency | M | `src/pipelines/engine.ts:681-686` | a per-step plan model ignores the project's configured planner instruction |
| low | contract | M | `src/pipelines/store.ts:13-17` | the store contract has no atomic update primitive, forcing callers into unsafe read-modify-write |
| low | resource | M | `src/pipelines/store.ts:24-31` | the run store grows without bound, and no run is ever pruned |

### `src/tasks/` — 30 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/tasks/engine.ts:137` | unsynchronised read-modify-write on a whole task record loses concurrent updates |
| high | bug | H | `src/tasks/engine.ts:202-235` | a concurrent cancellation is overwritten by the failure path |
| high | bug | H | `src/tasks/engine.ts:233` | a memory write-back failure makes `TaskEngine.run()` reject after the task already succeeded |
| high | bug | H | `src/tasks/engine.ts:280` | `cancel()` writes a stale snapshot and destroys the in-flight attempt's result/execution history |
| medium | inconsistency | H | `src/tasks/engine-factory.ts:17` | the `directory` parameter moves the task store but not the audit log |
| medium | bug | H | `src/tasks/engine.ts:148` | a role that is no longer defined is silently dropped: the task runs to "completed" with no role at all |
| medium | bug | H | `src/tasks/engine.ts:155` | a "required memory" failure escapes `TaskEngine.run` and aborts the whole pipeline run |
| medium | bug | H | `src/tasks/engine.ts:183` | `TaskContext.files` is stored and displayed but never delivered to the agent |
| medium | inconsistency | H | `src/tasks/engine.ts:215` | the two failure paths record the error differently |
| medium | contract | H | `src/tasks/engine.ts:233, 274-276` | the memory write-back is documented as "never fatal" but throws when `memory.required: true` |
| medium | contract | H | `src/tasks/engine.ts:256` | an agent reporting `status: "cancelled"` is recorded as a **failed** task |
| medium | bug | H | `src/tasks/engine.ts:280-290` | `cancel()` can throw before the task is transitioned, leaving it `running` |
| medium | bug | H | `src/tasks/engine.ts:324` | `retry()` leaves the previous attempt's `lastError` on the task |
| medium | dead-code | H | `src/tasks/engine.ts:37` | two task states are unreachable: `waiting` and `partially_completed` |
| medium | contract | H | `src/tasks/engine.ts:377` | the audit action written for `timed_out`/`unknown`/`partially_completed` is not a valid `AuditAction` |
| medium | inconsistency | H | `src/tasks/engine.ts:52` | the documented automatic retry never triggers for the real process adapter |
| medium | resource | H | `src/tasks/store.ts:25` | Task, report, plan and memory stores grow without bound |
| medium | bug | H | `src/tasks/store.ts:34` | the store's read path is not serialized with its write path |
| low | inconsistency | H | `src/tasks/engine-factory.ts:11` | The `directory` argument applies to the task store only; audit, memory and the pipeline stores ignore it |
| low | inconsistency | H | `src/tasks/engine-factory.ts:25` | the factories ignore the store directory for the audit log and the memory provider |
| low | dead-code | H | `src/tasks/engine.ts:155` | `memory.context.gathered` and `memory.outcome.recorded` are declared audit actions but never emitted |
| low | bug | M | `src/tasks/engine.ts:165` | `maxAttempts` is not sanitized: `NaN` silently skips the run, `Infinity` loops forever |
| low | bug | H | `src/tasks/engine.ts:202` | an agent that returns `undefined` is reported with the error message "undefined" |
| low | bug | M | `src/tasks/engine.ts:204` | an agent that throws or returns `undefined` produces the literal error message "undefined" |
| low | bug | H | `src/tasks/engine.ts:256` | an agent result of `cancelled` is recorded as `failed` |
| low | bug | H | `src/tasks/engine.ts:257` | `lastError` is never cleared, so a successfully retried task still reports the previous failure |
| low | bug | M | `src/tasks/engine.ts:297` | `recoverStaleTasks()` has no liveness check |
| low | bug | H | `src/tasks/engine.ts:327` | a second retry overwrites the preserved `lastResult` |
| low | dead-code | H | `src/tasks/engine.ts:377` | `to === "queued" ? "queued" : to` is a no-op ternary |
| low | bug | M | `src/tasks/store.ts:25` | `save()` is a whole-file read-modify-write, so two writers on the same `tasks.json` lose each other's tasks |

### `src/planner/` — 17 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/planner/model.ts:139-150` | fallback step ids come from the pre-sort index: collisions discard a valid model plan |
| high | resource | H | `src/planner/store.ts:24-31` | `save()` destroys a `plans.json` written by a newer OmniNode |
| medium | bug | H | `src/planner/context.ts:49-62` | the aggregated section drops per-agent attribution, agreement details and the aggregated recommendations |
| medium | resource | H | `src/planner/context.ts:9-79` | the planner prompt is unbounded |
| medium | bug | H | `src/planner/factory.ts:19-24` | a malformed or unknown-provider planner model in `omninode.yaml` silently degrades to the heuristic |
| medium | inconsistency | H | `src/planner/heuristic.ts:32-71` | critical remediations are planned *after* trivial recommendations |
| medium | bug | H | `src/planner/heuristic.ts:47` | `sourceFindings` points at synthetic ids, not report finding ids |
| medium | contract | H | `src/planner/model.ts:56, 100` | transport failures are reported as `PLAN_INVALID`; `PLANNER_FAILED` is never thrown |
| medium | bug | H | `src/planner/schema.ts:42-55` | `validatePlan` never checks that a step has an id |
| medium | dead-code | H | `src/planner/types.ts:19, 22, 23` | three `PlanRequest` fields are never supplied (or never read) by the only producer |
| low | dead-code | M | `src/planner/heuristic.ts:122` | the heuristic planner sets a `recommendation` property that `PlanStep` does not declare |
| low | dead-code | H | `src/planner/heuristic.ts:20-23, 55, 58` | `ContributedFinding.agent` is computed but never read |
| low | inconsistency | H | `src/planner/heuristic.ts:28-111` | the heuristic planner never validates its own output |
| low | bug | H | `src/planner/heuristic.ts:98-100` | plan summary miscounts the steps it produced |
| low | resource | H | `src/planner/model.ts:55-57, 100-102, 161-163` | the original model-call error is swallowed |
| low | bug | H | `src/planner/schema.ts:42-67` | `validatePlan` accepts dependency cycles, duplicate `order` values and negative `order` |
| low | dead-code | H | `src/planner/schema.ts:70` | `PlanJsonInput` is exported but never used and never re-exported |

### `src/reports/` — 23 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `src/reports/aggregate.ts:157` | Recommendation conflicts attribute every agent's fix to the first agent |
| high | bug | H | `src/reports/aggregate.ts:62` | "Agreement" is counted per *report occurrence*, not per distinct agent |
| high | contract | H | `src/reports/extract.ts:84` | The generated report id contains no agent component, so ids collide across agents |
| high | bug | H | `src/reports/store.ts:35-38` | `saveReports` upserts by `report.id`, so colliding ids silently destroy the earlier report |
| medium | bug | H | `src/reports/aggregate.ts:131-139` | A single agent can be reported as being in conflict with itself |
| medium | bug | H | `src/reports/aggregate.ts:170,193` | Aggregation reads the legacy `finding.detail`, so v2 findings aggregate to empty text |
| medium | bug | H | `src/reports/aggregate.ts:181` | `severityBySource` is last-write-wins per agent, so it can contradict the group's own severity |
| medium | contract | H | `src/reports/aggregate.ts:191-202` | `location` and `tags` are dropped when findings are aggregated |
| medium | resource | H | `src/reports/aggregate.ts:68-71,87-88` | `maxFindings` bounds only the `findings` array; `agreements` and `conflicts` are unbounded |
| medium | bug | H | `src/reports/extract.ts:71-73` | A section matching two patterns is emitted twice (as findings *and* as evidence) |
| medium | bug | H | `src/reports/extract.ts:73` | The `/log/` evidence pattern matches "login", "logic", "catalog", "dialog" |
| medium | contract | H | `src/reports/schema.ts:89-95` | `validateReport` mirrors `detail → description` only, leaving `detail` empty for v2 findings |
| low | contract | H | `src/reports/aggregate.ts:169,191` | `AggregatedFinding.details` is documented as "distinct" but duplicates are pushed verbatim |
| low | bug | M | `src/reports/aggregate.ts:61` | `agreements` and `conflicts` are computed over all groups while `findings` is capped, so the combined report can reference findings it does not contain |
| low | dead-code | H | `src/reports/extract.ts:11` | `ExtractionMeta.model` is never supplied by any caller, so `Report.model` can never be set |
| low | bug | H | `src/reports/extract.ts:67` | Summary fallback leaks the raw markdown marker when the heading has no space |
| low | contract | H | `src/reports/extract.ts:9-13` | `ExtractionMeta` has no `pipelineRunId`, so extracted reports lose pipeline provenance |
| low | dead-code | H | `src/reports/schema.ts:107` | `normalizeFinding` is a second, divergent normalization implementation that nothing uses |
| low | contract | H | `src/reports/schema.ts:29` | the zod finding schema is a strict superset of the `Finding` TypeScript interface |
| low | inconsistency | M | `src/reports/service.ts:32,90` | `lastDiagnostics` is shared mutable state on a service instance shared across concurrent pipeline runs |
| low | contract | H | `src/reports/service.ts:50-62` | Structured and text reports take different normalization paths, so their fields differ |
| low | contract | H | `src/reports/store.ts:48-49,72` | Filters use truthiness, so an empty-string filter value silently disables filtering |
| low | resource | M | `src/reports/store.ts:53-61` | `saveCombined` rewrites the entire `reports.json` for every combined report |

### `(repo root)/` — 8 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `vitest.config.ts:12` | the CI coverage step runs with vitest’s default 5 s test timeout and two tests exceed it, so the `gates` job goes red |
| medium | bug | H | `README.md:164` | the README quick-start pipeline cannot run |
| medium | inconsistency | H | `omninode.yaml.example:52` | the example (and the `init` template) suggest a `memory:` block that fails at runtime |
| medium | inconsistency | H | `package.json:26` | a top-level `prepublishOnly` key is dead configuration |
| medium | inconsistency | H | `vitest.config.ts:12` | no `testTimeout`/`hookTimeout` is configured, so the coverage job inherits the 5 s default |
| low | inconsistency | H | `package.json:21` | `files` omits `assets/logo-wordmark.svg`, which the shipped README references and documents |
| low | bug | L | `tsup.config.ts:11` | the two build configs run concurrently while the first deletes the whole `dist/` tree, so the CLI output can be wiped by the library build’s clean |
| low | inconsistency | H | `vitest.config.ts:15` | `coverage.include: ["src/**/*.ts"]` counts never-imported files as 0 %, so a single new untested module is diluted across the whole tree |

### `scripts/` — 7 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `scripts/release-gates.mjs:45` | `execFileSync("npm", …)` cannot launch `npm.cmd` on Windows, so the package gate always fails there |
| medium | resource | H | `scripts/release-gates.mjs:107` | the walker follows symlinked directories with no cycle guard, so a self-referential symlink crashes the gate with an unhandled `ELOOP` |
| medium | bug | H | `scripts/release-gates.mjs:115` | the secret-scan allowlist is matched with POSIX separators, so on Windows the gate flags the repo's own test fixtures |
| medium | bug | H | `scripts/release-gates.mjs:62` | the package gate only requires *some* file under `dist/`, so it passes for a tarball whose `bin`/`main`/`exports` targets are absent |
| low | contract | H | `scripts/release-gates.d.mts:18` | the hand-written declarations are never checked against the `.mjs` implementation |
| low | bug | H | `scripts/release-gates.mjs:140` | an unknown gate name silently runs *every* gate |
| low | dead-code | H | `scripts/release-gates.mjs:73` | the `.tgz` and `.omninode/` forbidden checks are unreachable |

### `.github/workflows/` — 4 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| high | bug | H | `.github/workflows/release.yml:31` | the publish path never runs the release gates |
| high | bug | H | `.github/workflows/release.yml:36` | the git tag is never compared against the published package version |
| medium | inconsistency | H | `.github/workflows/ci.yml:66` | the comment promises a “do-not-decrease” coverage gate, but vitest.config.ts enforces fixed absolute floors |
| low | inconsistency | M | `.github/workflows/ci.yml:49` | `npm test` runs before `npm run build`, so the tarball-content test is skipped on every platform |

### `src/types/` — 27 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| medium | contract | H | `src/types/agent.ts:47` | `AgentConfig.allowedModels` is a public configuration field that is never read and cannot even be set from `omninode.yaml` |
| medium | contract | H | `src/types/model.ts:24` | `ModelInfo.capabilities` is never populated by any provider, so the documented capability filter always returns empty |
| medium | contract | H | `src/types/pipeline.ts:119` | `PipelineRunOptions.maxAttempts` is part of the public contract but is silently ignored |
| medium | contract | H | `src/types/pipeline.ts:123` | `PipelineRunOptions.maxAttempts` is accepted by the public `IPipelineExecutor` interface but silently ignored by `PipelineEngine.run()` |
| medium | dead-code | H | `src/types/pipeline.ts:123` | `PipelineRunOptions.maxAttempts` is declared but never read; the run attempt counter never advances |
| medium | contract | H | `src/types/plan.ts:17-33` | the `Plan` interface has no `constraints` field, but both planners write one onto every plan object |
| medium | dead-code | H | `src/types/protocol.ts:13` | the v1 protocol types are exported from the package root but used by nothing |
| medium | inconsistency | H | `src/types/protocol.ts:32` | The pre-v2 `{meta, message}` protocol model is still public API and still described by the process adapter |
| medium | dead-code | H | `src/types/provider.ts:52` | `ProviderConfig.capabilities` is never populated; the documented `capabilities:` YAML key is rejected |
| medium | contract | H | `src/types/provider.ts:83` | `IProvider.getModel` is documented as "re-discovers if unknown", but the implementation returns `undefined` without re-discovering |
| medium | contract | H | `src/types/report.ts:45` | `Finding.detail` is required by the type but defaulted to `""` by zod, so a v2 finding's `description` is silently replaced by an empty string during aggregation |
| medium | contract | H | `src/types/report.ts:66` | `Report.agentId` is documented as the v2 spelling of `agent` but is never populated by any producer |
| medium | unimplemented | H | `src/types/task.ts:17` | the `waiting` status is advertised but unreachable |
| medium | dead-code | H | `src/types/task.ts:26` | `TERMINAL_TASK_STATUSES` is referenced nowhere in the repository |
| low | dead-code | H | `src/types/agent.ts:47` | `AgentConfig.allowedModels` is declared but never honoured |
| low | dead-code | H | `src/types/agent.ts:52,55` | `AgentInfo.version` and `AgentInfo.metadata` are never populated by any agent implementation |
| low | dead-code | H | `src/types/agent.ts:8-14` | `AgentStatus` declares six states but the runtime only ever produces one |
| low | contract | M | `src/types/memory.ts:56` | `IMemoryProvider` requires six methods while the docs say two suffice |
| low | dead-code | H | `src/types/project.ts:1-14` | the `Project` interface is exported publicly but never imported and does not match the runtime project shape |
| low | dead-code | H | `src/types/project.ts:3` | the `Project` entity is exported and documented as Stable but never used |
| low | dead-code | H | `src/types/protocol.ts:1-35` | the v1 protocol types are exported publicly but describe a wire format the runtime rejects |
| low | inconsistency | H | `src/types/protocol.ts:13-30` | the public "v1" protocol contract disagrees with the v2 protocol that is actually spoken |
| low | contract | H | `src/types/provider.ts:51` | `ProviderConfig.capabilities` can never be set from configuration |
| low | dead-code | H | `src/types/task.ts:26-32` | `TERMINAL_TASK_STATUSES` is exported but never used |
| low | dead-code | H | `src/types/task.ts:55` | `TaskContext.memoryKeys` is never read or written anywhere |
| low | dead-code | H | `src/types/task.ts:56` | `TaskContext.memoryKeys` is never set or read anywhere |
| low | dead-code | H | `src/types/task.ts:60-61` | `TaskResult.reportId` and `TaskResult.artifacts` are never written by the task engine |

### `src/audit/` — 5 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| medium | bug | H | `src/audit/index.ts:123` | `recent(limit)` returns the whole log for `limit === 0` and the wrong window for negative/NaN limits |
| medium | inconsistency | M | `src/audit/index.ts:79` | rotation is not serialized with the append, and a rotation race destroys the previous backup |
| medium | contract | H | `src/audit/index.ts:91` | `record()` overwrites a caller-supplied `eventId` |
| low | dead-code | H | `src/audit/index.ts:27` | `"memory.context.gathered"` and `"memory.outcome.recorded"` are never emitted |
| low | resource | M | `src/audit/index.ts:79` | Audit rotation is a stat-then-rename TOCTOU, and `recent()` reads the whole log |

### `src/registry/` — 4 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| medium | inconsistency | H | `src/registry/index.ts:38` | the capability filter can never match a model discovered from a real provider |
| medium | dead-code | H | `src/registry/index.ts:38` | `omninode models --capability <c>` can never return a model |
| medium | bug | H | `src/registry/index.ts:38` | the `--capability` filter can never match a discovered model |
| low | inconsistency | H | `src/registry/index.ts:26` | `register()` silently overwrites a duplicate `provider:model` key |

### `src/logger/` — 3 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| medium | bug | H | `src/logger/index.ts:52` | `child()` snapshots `level`/`format`, so `configureLogger` never reaches already-created child loggers |
| low | bug | M | `src/logger/index.ts:78` | an unrecognized level disables level filtering entirely |
| low | bug | H | `src/logger/index.ts:82` | JSON log data can shadow the reserved `at`/`level`/`message` fields |

### `src/errors/` — 3 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| medium | dead-code | H | `src/errors/index.ts:19` | `PLANNER_FAILED` is never thrown, and the planner's transport failures are mis-coded |
| low | inconsistency | M | `src/errors/index.ts:47` | every domain has a typed subclass except reports |
| low | contract | H | `src/errors/index.ts:6` | the `OmniNodeErrorCode` union lists `PROVIDER_NOT_FOUND` and `TASK_NOT_FOUND` twice |

### `src/` — 1 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| low | contract | H | `src/index.ts:139` | `ReportValidationResult` is documented as a public Stable export but is not re-exported from the package root |

### `src/roles/` — 1 findings

| Sev | Cat | Conf | Location | Finding |
| --- | --- | --- | --- | --- |
| low | inconsistency | H | `src/roles/index.ts:8` | `register()` silently shadows an existing role, while the config layer treats duplicate role ids as fatal |
