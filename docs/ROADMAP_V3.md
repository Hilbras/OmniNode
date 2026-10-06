# OmniNode v3 — Future Development Roadmap

> **Status: PLANNED.** This document is the forward-looking roadmap for the
> v3 architecture. The v2.0.x line is a completed, hardened foundation
> (v2.0.0 shipped all 24 phases; v2.0.1–v2.0.3 are hardening releases). The
> goal here is to add advanced orchestration capabilities **without
> destabilizing the v2 core** — every v3 feature is designed to build on
> interfaces that already exist, and to remain an optional, opt-in layer.

**Project:** Hilbras OmniNode
**Current Version:** v2.0.3
**Target:** v3.0.0
**Package:** `@hilbras/omninode`
**License:** MIT
**Runtime:** Node.js 20+
**Language:** TypeScript

---

## 1. Guiding principles

The v2 core is strong enough to support the future. The rules of the road:

1. **Build on stable interfaces.** New features use `IProvider`, `IAgent`,
   `IPlanner`, `IMemoryProvider`, the store family and `AuditSink` — they do
   **not** reach into engine internals.
2. **Optional by default.** A feature ships off until a config section or
   capability flag enables it. The zero-config path keeps working exactly
   as it does today.
3. **Observability is a contract.** Every new capability emits correlated
   audit events and appears in `inspect` output before it is considered done.
4. **No silent behavior changes.** Semantics (especially task/pipeline
   state) change only in `v3.0.0`-major form, announced in
   [DEPRECATIONS.md](DEPRECATIONS.md) ahead of time.
5. **Correctness > reliability > safety > observability > compatibility >
   performance > new features** — the same ordering the v2 hardening followed.

---

## 2. v2.0.4 — quick wins (ship before any v3 feature)

Small, low-risk hardening items that close operational gaps left by v2.0.3.
These are independent of v3 and are safe to land on the `v2` line.

| # | Item | Why |
| --- | --- | --- |
| A | **Windows CI lane** | Platform behavior (process groups, grandchild reaping, cancellation) is *documented* in SECURITY.md / AGENTS.md but only exercised on `ubuntu-latest`. Add a `windows-latest` runner so those claims are verified, not just asserted. Group-kill tests graceful-skip where unsupported. |
| B | **Release automation token** | Document the one-time `NPM_TOKEN` repo secret so tag-triggered npm publish + GitHub release runs fully automatically (today the publish step fails without it and requires a manual `npm publish`). |
| C | **Coverage gate** | Add a `vitest --coverage` floor (target ≥ 85% on `src/`) so new features cannot erode the v2 hardening silently. Report per-file and fail CI below threshold. |
| D | **Protocol fuzz tests** | The JSON-lines agent protocol is an untrusted-input boundary. Add a fuzz harness over `ProtocolDecoder` / `decodeMessage` (truncated, malformed, oversized, garbage, and non-UTF-8 envelopes) to keep "malformed input never crashes the orchestrator" proven. |
| E | **Docs: NPM_TOKEN + release flow** | Fold item B into CONTRIBUTING.md so a fresh maintainer can wire up release automation in one step. |

Definition of done: `v2.0.4` passes every existing gate **plus** the Windows
lane and coverage floor, and the release pipeline is green end-to-end.

---

## 3. v3 phases — advanced orchestration

Each phase is scoped to a bounded set of new types/config plus the audit and
documentation that proves it. Phases are ordered so earlier ones unblock
later ones; skip order is discouraged, but any single phase is independently
shippable as a prerelease.

### Phase 1 — Human approval gates

A plan step or an execute step can be gated behind an explicit human decision
before the next step (or the agent) runs. This is the smallest of the "big"
capabilities and slots directly into the existing pipeline state machine.

- **New:** a step `gate: { on: "plan" | "execute", by: "human" }` option
  (`PipelineStep.gate`). While gated, the run persists as a new
  `awaiting_approval` status (a v3 terminal-pause state, **not** `running`).
- **New:** `omninode pipeline approve <run-id> [--yes|--no]` and a
  `--timeout` / `--on-timeout` policy for unattended approval (approve /
  reject / fail).
- **Builds on:** `PipelineRun.status`, `AuditSink` (`pipeline.run.approved`,
  `pipeline.run.rejected`), and the persisted-run store that already makes
  runs survive process boundaries (see PIPELINES.md, cross-process note).
- **Non-goals:** no web UI. Approval is CLI + config. (UI is a separate,
  later capability.)

Done when: a gated run is observable (`inspect`, audit), can be resumed after
a process restart, and a timeout policy is honored without a human present.

### Phase 2 — Cost & token budgeting

Providers already return `ChatResponse.usage` (`promptTokens`,
`completionTokens`, `totalTokens`). This phase makes that first-class:
per-step and per-pipeline budgets, with enforcement and reporting.

- **New:** `project.budget` config (per-step / per-run / per-project caps in
  tokens and/or cost units, plus `policy: "warn" | "enforce"`).
- **Behavior:** over-budget in `warn` mode logs + marks the run; in
  `enforce` mode a step is settled as `partial` (never silently `failed`)
  with a diagnostic, and downstream on-success steps are skipped.
- **Builds on:** `ChatUsage`, `Report`/`metadata` (a `budget` provenance
  block), and the existing `partial` propagation rules.
- **CLI:** `omninode status` reports cumulative usage; `--json` exposes it.

Done when: a run that exceeds its budget is reported, reproducible, and never
mismapped to a false `failed`; usage is attributable per step and per model.

### Phase 3 — Provider failover

Multi-provider retry strategy for *retryable* errors (429/5xx/timeout)
within a single step attempt, with per-provider classification already in
place.

- **New:** `project.providers[].fallback: string[]` (ordered alternate
  providers) and a `provider_policy: { maxFailovers, retryOn: [...] }`.
- **Rule:** failover applies only to error codes already classified
  retryable; **never** to `unknown` outcomes (preserves the v2 side-effect
  guarantee — see Fix 13). A failover records a correlated audit event.
- **Builds on:** `ProviderError` normalized `kind`, `ModelRegistry`,
  `IChatProvider` error contract.

Done when: a step surviving a provider outage is deterministic, audited, and
still honors the "unknown is never blindly retried" invariant.

### Phase 4 — Context compression

The next layer above v2.0.3's boundary-safe truncation: when a compressor
provider/model is configured, memory context over budget is summarized
instead of dropped; truncation is the fallback when compression is unavailable.

- **New:** `memory.compressor` (provider + model + `when: "over-budget"`).
- **Behavior:** compression is best-effort and non-fatal (memory stays
  optional); compressed context carries a provenance marker so consumers know
  it is summarized. Original entry metadata is preserved (extends the
  `originalSize`/`finalSize` contract from Fix 01).
- **Builds on:** `MemoryService` context budget, `ChatFn`, and the
  `CONTEXT_TRUNCATION_MARKER` safety floor.

Done when: compression is strictly better than truncation *and* degrades to
today's safe truncation when no compressor is configured.

### Phase 5 — Role packs

Validated, versioned, installable bundles of role definitions.

- **New:** `omninode role install <pack>` (a pack is a small manifest of
  `RoleDefinition`s + associated agent suggestions) and `role list`
  annotations for pack membership. Packs are validated at install time
  (unknown agents/roles surface as diagnostics, not mid-run failures).
- **Builds on:** `RoleRegistry`, config validation, and the `agent add` /
  `role` CLI groups.
- **Non-goals:** no remote registry in v3.0.0; packs are local files /
  git refs. (A hosted marketplace is a post-v3 idea.)

Done when: a pack installs, validates, and its roles drive a pipeline with no
hand-edited config.

### Phase 6 — Learning from outcomes

Heuristic agent/provider selection ranked by historical success, read from
memory that `recordTaskOutcome` already writes.

- **New:** a `planner.recommender` that reads task-outcome + known-problem
  memory entries and biases agent/provider choice for the objective, with a
  transparent `why` (the cited evidence), never an opaque score.
- **Builds on:** `recordTaskOutcome`, memory categories (`tasks`,
  `problems`), and the heuristic planner fallback.
- **Guardrail:** recommendation is advisory in v3.0.0 — explicit config or
  a `--auto` flag is required to act on it. No silent re-routing.

Done when: a recommendation can be traced to stored evidence, and turning it
off restores deterministic selection.

### Phase 7 (stretch) — Event sourcing & replayable execution

The audit log *looks* like an event stream but is deliberately **not**
replayable (see `AuditEvent.eventId` and the ARCHITECTURE.md semantics
section: "this is state understanding, not replay"). This phase decides the
boundary between an observability record and an executable event log, and
adds an opt-in `--replay` reconstruction path only after that boundary is
written down.

- **Sequencing:** after Phases 1–5, and only if the replay-vs-observation
  boundary is explicitly specified.
- **Non-goals:** distributed execution, a distributed database, and
  "learning" that mutates persisted history.

Done when: replay of a recorded run is deterministic, bounded, and clearly
separated from the observational audit trail.

---

## 4. Explicit non-goals (deferred past v3.0.0)

The following remain out of scope and are **not** part of v3.0.0:

- Distributed workers / a distributed database
- Full OS-level sandboxing (containers / seccomp / Job objects stay the
  user's responsibility — OmniNode stays process isolation + policy)
- A major UI / dashboard redesign (approval and observability are CLI-first)
- A new AI provider SDK or a new agent integration framework
- A hosted role-packs marketplace or consensus engine
- Consensus / evidence-based findings across many agents (a post-v3 idea
  that would build on Phase 6's evidence trail)

---

## 5. Release strategy

```text
v2.0.4 (quick wins A–E)
   ↓
v3.0.0-alpha.1  (Phase 1: approval gates)
   ↓
v3.0.0-alpha.2  (Phase 2: cost & token budgeting)
   ↓
v3.0.0-alpha.3  (Phase 3: provider failover)
   ↓
v3.0.0-beta.1   (Phases 4–5: compression + role packs)
   ↓
v3.0.0          (Phase 6 learning; Phase 7 only if the boundary is specified)
```

Rule: no new *architecture* lands in a `-beta` or final release. After a
`-beta`, only bug fixes, security fixes, documentation, test, and release
fixes are allowed — the same discipline used for v2.0.3.

---

## 6. Definition of done (v3.0.0)

A v3.0.0 release is complete when, in addition to all v2 guarantees:

- **Gates**: a gated pipeline run is observable, resumable across a process
  restart, and has a defined unattended-timeout policy.
- **Budgets**: over-budget work is reported and reproducible, never a false
  `failed`, and usage is attributable per step and per model.
- **Failover**: provider failover is deterministic and audited, and preserves
  the "unknown is never blindly retried" invariant.
- **Memory**: compression is strictly better than truncation and degrades to
  the v2.0.3 safe-truncation floor.
- **Roles**: a pack installs, validates, and drives a pipeline.
- **Learning**: every recommendation is traceable to stored evidence and is
  advisory unless explicitly enabled.
- **Compatibility**: with all v3 features off, behavior is byte-identical to
  v2.0.3.
- **Observability**: every new capability emits correlated audit events and
  renders in `inspect`.
- **Tests**: the failure matrix, migration matrix, side-effect safety, and
  process-tree suites all pass *with the new features on and off*, and the
  new coverage floor is met.

The standing quality bar is unchanged: an unexpected failure must never make
OmniNode lose execution history, falsely report success, blindly retry a
possibly-completed operation, corrupt persisted state, or expose secrets.
