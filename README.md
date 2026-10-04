# OmniNode

[![CI](https://github.com/Hilbras/OmniNode/actions/workflows/ci.yml/badge.svg)](https://github.com/Hilbras/OmniNode/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![npm downloads](https://img.shields.io/npm/dm/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![Node.js support](https://img.shields.io/node/v/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![License: MIT](https://img.shields.io/github/license/Hilbras/OmniNode)](LICENSE)
[![Roadmap phase](https://img.shields.io/badge/phase-0_%2F_11-Foundation-8A2BE2)](docs/DEVELOPMENT_PLAN.md)

**OmniNode** is a provider-agnostic multi-AI orchestration platform. It coordinates
CLI-based AI agents, AI providers, persistent memory, roles, reports and planning
into a unified execution system — so multiple AI systems can collaborate on complex
software engineering and knowledge-work tasks.

OmniNode is **not an AI provider** and is **not dependent on OmniHilbras** (or on
OpenAI, Gemini, DeepSeek, Qwen, or any other specific vendor). It orchestrates
existing intelligence; it does not try to become another model.

## Status

**v2.0.0-alpha.10 — v2 Phase 10: Aggregation Improvements**
(the reliability & interoperability line: architecture → execution →
protocol → adapters → pipelines → providers → OmniHilbras → memory → reports) (the v2
roadmap is [docs/ROADMAP_V2.md](docs/ROADMAP_V2.md); the v1 plan is complete:
the
full loop from §28 runs in one command —
`User → project context → memory → research agents → reports → aggregation →
planner → plan → execution → result` — with audit logging, error recovery and
production hardening (see [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)
for the plan and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design).

### What's new in v2 (so far)

- **Phase 10 — Aggregation Improvements**: when agents disagree,
  OmniNode now says so instead of flattening the answer — **conflict
  detection** preserves every position (severity spread, divergent
  recommended fixes), multi-agent **agreements** are recorded as
  consensus, confidence is preserved per source, and the combined
  report carries provenance-rich metadata. Still fully deterministic.
- **Phase 9 — Report System v2**: reports are validated machine-readable
  objects — `validateReport()` runs on everything entering the system and
  malformed reports are rejected with diagnostics instead of poisoning
  aggregation. Findings gain description/confidence/source/recommendation,
  evidence is typed (`file`, `line`, `url`, `command`, `observation`,
  `artifact`), and reports carry artifacts and run provenance.
  Details: [REPORTS.md](docs/REPORTS.md).
- **Phase 8 — Remembera / Memory v2**: the memory contract is formalized
  (`retrieve` / `store` / `search` / `metadata` with v1 `query` / `write`
  aliases kept working), memory gains structured **categories** (decisions,
  problems, conventions, tasks…), retrieval is **task-oriented and budgeted**
  (never "load all memory"), and `memory.required: true` makes backend
  failures fatal instead of tolerated. Details: [MEMORY.md](docs/MEMORY.md).
- **Phase 7 — OmniHilbras Integration v2**: the dedicated adapter now
  captures gateway-level metadata (version, tier, region) and attaches it
  to discovered models, honors provider-level `timeout_ms`, and supports
  streaming completions (`stream()` over SSE) — while a guard test proves
  the core references OmniHilbras *only* through the provider layer, and a
  full pipeline runs with no OmniHilbras configured at all.
- **Phase 6 — Provider Infrastructure v2**: standardized provider contract
  (`providerId`, secret-free `authentication`, declared `capabilities`,
  `connect()` / `getModel()` discovery), richer model metadata (context
  window, input/output modalities, tool/vision/structured-output/streaming
  support), and **unified error normalization** — every provider failure now
  carries a stable `kind` (auth, rate limit, invalid request, model not
  found, timeout, network, server, unknown) plus `retryable` and
  `retryAfterMs`. Details: [PROVIDERS.md](docs/PROVIDERS.md).
- **Phase 5 — Pipeline Lifecycle**: first-class pipeline cancellation
  (`omninode pipeline cancel <run-id>`: stop scheduling → cancel running
  tasks → terminate agent processes → persist a `cancelled` run), `pipeline
  validate` for pre-run checks (deps, cycles, agents, model references),
  explicit run/step **attempts** in the run record, the
  `IPipelineExecutor` contract, and recovery awareness — runs left `running`
  without a `finishedAt` are flagged as interrupted in `pipeline runs`.
- **Phase 4 — Agent Adapter Hardening**: process-tree cleanup (agents run in
  their own process group; timeout, cancel and Ctrl-C reap the whole tree, so
  no orphaned children), explicit environment policies
  (`inherit` / `allowlist` / `denylist` / `explicit`), working-directory
  validation against project boundaries, per-stream output limits that kill
  runaway agents, binary-safe output decoding, human-readable exit/signal
  reporting, and a native `IAgentAdapter` registry so new integration styles
  plug in without touching core.
- **Phase 3 — Agent Protocol v2**: versioned protocol
  (`omninode-agent-protocol/2`), fully correlated envelopes, the complete
  message-type set, HELLO handshake, QUESTION/RESPONSE round-trips, and
  malformed input that can never crash OmniNode. Spec:
  [PROTOCOL.md](docs/PROTOCOL.md).
- **Phase 2 — Execution Reliability**: a task killed after dispatch is
  `unknown`, **not** `failed` — retries never duplicate side effects blindly;
  bounded retries with backoff, execution identity and history.
- **Phase 1 — Architecture & API Stabilization**: one shared `JsonFileStore`
  behind every local store, corrected dependency direction, and a guarded
  public API ([API_STABILITY.md](docs/API_STABILITY.md), [API.md](docs/API.md),
  [DEPRECATIONS.md](docs/DEPRECATIONS.md)).

### What's in v1.0

| Capability | Where |
| --- | --- |
| Provider abstraction, custom providers, model discovery | `src/providers/`, `src/registry/` |
| OmniHilbras integration (optional) | `src/providers/omnihilbras/` |
| CLI agents (stdin/arg/protocol), agent registry | `src/agents/` |
| Roles, projects, tasks (lifecycle + retry) | `src/roles/`, `src/tasks/` |
| Pipelines (DAG, parallel, retries, conditions) | `src/pipelines/` |
| Multi-AI research + report aggregation | `src/reports/` |
| Planner layer (model + heuristic) | `src/planner/` |
| Remembera / local memory | `src/memory/` |
| CLI, configuration, security foundations, docs | `src/cli/`, `src/config/`, `docs/` |

What exists today:

- Core type contracts: provider, model, agent, role, task, report, pipeline,
  protocol, memory (`src/types/`)
- **Provider system** (`src/providers/`, `src/registry/`):
  - OpenAI-compatible adapter — works with OpenAI, OpenRouter, local runtimes
    (Ollama, LM Studio, vLLM) and custom gateways exposing `/models` and `/chat/completions`
  - Model discovery with normalization into the model registry (`provider:model` keys)
  - Health checks: connectivity, authentication and server-error classification
  - Authentication from environment variables only — keys never touch config files
  - Chat completions (`IChatProvider`) — the foundation for the planner phases
  - Provider factory mapping config to adapters; `omnihilbras` gets a
    dedicated adapter implementing the plan's connect flow —
    Connect → Authenticate → Fetch Models → Validate Models → Register
- **Agent system** (`src/agents/`):
  - Process adapter: spawns CLI agents as child processes with lifecycle
    management — environment, working directory, exit codes, stderr logs,
    per-task timeouts (SIGTERM → SIGKILL) and cancellation
  - Three input modes: `stdin` (composed task text on stdin), `arg` (prompt as
    last argument) and `protocol` (the §21 JSON-lines task protocol —
    `TASK`/`ROLE`/`CONTEXT`/`INSTRUCTION` envelopes in, `REPORT`/`COMPLETION`/
    `ERROR` messages out, parsed into structured reports)
  - Agent factory and registry (`createAgent`, `AgentRegistry`)
- **Roles & tasks** (`src/roles/`, `src/tasks/`):
  - `RoleRegistry` with assignment validation — a task can only reference roles
    and agents that actually exist
  - Task lifecycle (created → queued → running → completed/failed/cancelled)
    with transition enforcement
  - `TaskEngine` runs tasks through their assigned agent, records structured
    results (summary, reports, errors, timestamps)
  - `TaskStore` interface with a local-first JSON implementation in
    `.omninode/tasks.json` (atomic writes; swap in any backend)
- **Pipeline engine** (`src/pipelines/`):
  - Pipelines defined in `omninode.yaml` under `project.pipelines`, validated
    before every run (duplicate ids, unknown dependencies, cycles, missing
    agents)
  - Sequential execution by definition order; explicit `depends_on` unlocks
    parallel branches, and research steps fan out to several agents in
    parallel (§15)
  - Step kinds: `research` (multi-agent fan-out), `collect`, `analyze`,
    `plan` (calls a model as `provider:model-id` via the chat layer),
    `execute`/`custom` (hand-off to an execution agent)
  - Failure handling: retries per step, `on-success`/`on-failure`/`always`
    conditions, combined context threaded downstream; every task runs through
    the TaskEngine and every run is persisted to `.omninode/pipelines.json`
- **Multi-AI report system** (`src/reports/`):
  - Report collection from finished tasks — structured protocol reports pass
    through; plain text output is normalized via deterministic extraction
    (findings/recommendations/evidence sections, severity guessing)
  - Persistence in `.omninode/reports.json` with full source attribution
  - Aggregation (§17): duplicate/similar findings merged via deterministic
    token-set similarity, sources preserved, highest severity kept
  - Combined reports generated automatically at the end of every pipeline run
- **Memory** (`src/memory/`): the §20 loop — before a task runs, relevant
  memory is gathered and injected into the agent's context; after it finishes,
  the outcome is recorded back. High/critical findings are promoted to
  project-level "known problems". Opt in via a `memory:` config section:
  - `provider: local` (default) — JSON file at `.omninode/memory.json` with
    deterministic keyword/tag relevance scoring, zero dependencies
  - `provider: remembera` — the preferred Hilbras memory integration over
    HTTP (base URL + `api_key_env_var`); strictly optional, like every
    Hilbras component
  - Memory failures are best-effort: logged, never fatal to a task
- **Planner layer** (`src/planner/`):
  - Typed plan schema (`Plan` with ordered steps, targets, acceptance
    criteria, risks, and finding traceability via `sourceFindings`)
  - Planner context builder: objective + role + combined findings with
    sources + relevant memory + research context
  - `ModelPlanner` — asks a chat model (`provider:model-id`) for JSON matching
    the plan contract; unparseable output degrades gracefully to the heuristic
    fallback
  - `HeuristicPlanner` — deterministic, offline plan from recommendations and
    significant findings (also the fallback)
  - Plans persist to `.omninode/plans.json`; pipeline runs record `planId`
  - Configure with `planner: { kind: model | heuristic, model, instruction }`
    — never hardcoded to any provider
- **End-to-end workflow** (§28, §27 Phase 9):
  - One-command execution via the top-level `run` alias (`omninode run <pipeline> "<objective>"`)
  - `omninode status` — full project state overview: providers, agents,
    roles, pipelines, task/run/report/plan counts, memory provider + entries
  - Pipeline runs persist their objective and a final `resultSummary` (§28 "Result")
  - Error recovery: `task retry [--run]` (reset a failed/cancelled task) and
    `pipeline retry <run-id>` (re-run a recorded failed run as a new run)
  - Full integration test (`tests/e2e.test.ts`) drives the entire §28 workflow
    through the real CLI against a local gateway
- Typed error hierarchy (`src/errors/`)
- Leveled logger with pluggable sink (`src/logger/`)
- Configuration system: `omninode.yaml` with `${ENV_VAR}` expansion and strict
  validation (`src/config/`)
- CLI: `init`, `provider add/list/test`, `models`, `agent list`, `role list`,
  and honest stubs for the phase-dependent commands (`src/cli/`)
- Test infrastructure (Vitest) and CI (GitHub Actions)

## Requirements

- Node.js >= 20

## Quick start (from source)

```bash
npm install
npm run build
node dist/cli/index.js --help

# Or run from source:
npm run omninode -- --help
```

Start a project:

```bash
omninode init                 # writes omninode.yaml in the current directory

# Register a provider and verify it end to end
omninode provider add --name my-gateway --type openai-compatible \
  --base-url https://example.com/v1 --api-key-env-var MY_API_KEY
omninode provider test my-gateway

# Discover models into the registry
omninode models
omninode models my-gateway --capability chat

omninode agent list
omninode role list
```

Register and verify a CLI agent (anything executable works — `opencode`,
`kimi`, a custom script):

```bash
omninode agent add --name opencode --command opencode --input-mode arg
omninode agent test opencode     # sends a trivial task over the real adapter
```

Create, run and track tasks (the `Project → Task → Role → Agent` chain):

```bash
omninode task create "audit the auth module" --role security-reviewer --agent opencode
omninode task run task-xxxxxx
omninode task status task-xxxxxx
omninode task list
```

Orchestrate several AI systems with a pipeline (§14):

```yaml
project:
  pipelines:
    - id: repo-audit
      steps:
        - id: research
          kind: research
          agents: [kimi, gemini, qwen]
        - id: plan
          kind: plan
          model: my-gateway:chatgpt
        - id: execute
          kind: execute
          agent: opencode
```

```bash
omninode pipeline run repo-audit "Audit the authentication module"
omninode report combined          # the aggregated intelligence of that run
omninode report show combined-xxx # grouped findings with per-source attribution
omninode plan show plan-xxx       # the implementation plan the planner produced
```

The planner layer (§18) turns combined intelligence into an ordered,
actionable implementation plan. Configure it once:

```yaml
project:
  planner:
    kind: model              # or heuristic for offline planning
    model: my-gateway:chatgpt
```

```bash
omninode init
omninode status
omninode run repo-audit "Audit the authentication module"   # the whole workflow
omninode pipeline retry run-xxxx                             # recover a failed run
omninode task retry task-yyyy --run                          # recover a failed task
```

Persistent memory (§19–§20) — opt in with `memory: { provider: local }` or
`provider: remembera` in `omninode.yaml`:

```bash
omninode memory status                      # provider + entry counts
omninode memory query "authentication jwt"  # what the agents will see
omninode memory write "Decision: use rotating JWT secrets" --scope project --tags architecture
```

See [omninode.yaml.example](omninode.yaml.example) for a full configuration.

### Configuration

OmniNode reads `omninode.yaml` (or `.yml` / `.json`) from the working directory.
Two rules matter:

1. **Credentials never live in the file.** Reference environment variables with
   `api_key_env_var: MY_API_KEY`; `${VAR}` / `${VAR:-fallback}` references anywhere
   in the file are expanded at load time and unset variables abort loading.
2. **Unknown keys are rejected.** Typos fail loudly instead of being ignored.

## Development

```bash
npm run build        # bundle with tsup (library + CLI)
npm test             # run tests once
npm run test:watch   # watch mode
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier
```

## Roadmap

Phases 0–11 are laid out in [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md):

| Version | Milestone |
| --- | --- |
| v0.1.0 | Foundation |
| v0.2.0 | Provider System |
| v0.3.0 | OmniHilbras Integration (optional, like every provider) |
| v0.4.0 | Agent System |
| v0.5.0 | Roles & Tasks |
| v0.6.0 | Pipeline Engine |
| v0.7.0 | Multi-AI Reports |
| v0.8.0 | Remembera / Memory |
| v0.9.0 | Planner |
| v0.10.0 | End-to-End Workflow (current) |
| **v1.0.0** | **Production Release — Phases 10 + 11 (current, final)** |

Core architectural rule: OmniNode must run successfully with **zero Hilbras
dependencies**. OmniHilbras and Remembera make it more powerful, but neither is
required for the core engine.

## Documentation

- [Development plan](docs/DEVELOPMENT_PLAN.md) — the full 12-phase roadmap
- [Architecture](docs/ARCHITECTURE.md) — module map, workflow, local state
- [Security model](docs/SECURITY.md) — secrets, process execution, env isolation, audit log
- [API stability policy](docs/API_STABILITY.md) and [public API inventory](docs/API.md)
- [Agent Protocol v2 spec](docs/PROTOCOL.md) · [Providers](docs/PROVIDERS.md) · [Memory](docs/MEMORY.md) · [Reports](docs/REPORTS.md) · [Deprecations](docs/DEPRECATIONS.md) · [Changelog](CHANGELOG.md) · [v2 roadmap](docs/ROADMAP_V2.md)
- [Example project](examples/demo/) — a runnable end-to-end demo (`./demo.sh`)

Prefer a container? `docker build -t omninode .` then
`docker run --rm -v "$PWD:/work" -w /work omninode run my-pipeline "audit the repo"`.

## Install

```bash
npm install -g @hilbras/omninode
```

Or use it as a library: `npm install @hilbras/omninode`.

## Connecting OmniHilbras

OmniHilbras is one provider source among many — always optional. The core
architectural rule stands: OmniNode runs with **zero Hilbras dependencies**.

The dedicated adapter implements the plan's connect flow on top of the
gateway's OpenAI-compatible API surface and tags discovered models with
`gateway: omnihilbras` metadata:

```bash
omninode provider add --name omnihilbras --type omnihilbras \
  --base-url https://your-omnihbras-host/v1 \
  --api-key-env-var OMNIHILBRAS_API_KEY

omninode provider test omnihilbras --connect   # full connect flow + registration
omninode models omnihilbras                    # list the gateway's models
```

## License

[MIT](LICENSE)
