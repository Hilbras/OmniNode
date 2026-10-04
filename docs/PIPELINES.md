# Pipelines

A pipeline turns one objective into many coordinated AI operations: independent
research, aggregation, planning, execution — with persistence and recovery at
every step.

## Defining a pipeline

```yaml
project:
  pipelines:
    - id: repo-audit
      name: Multi-AI audit
      objective: default objective when none is passed
      role: security-reviewer
      steps:
        - id: research
          kind: research            # fan out to several agents in parallel
          agents: [kimi, gemini, qwen]
          retries: 1

        - id: plan
          kind: plan                 # model-backed planner (or the configured one)
          constraints:
            - no breaking API changes

        - id: execute
          kind: execute              # hand the plan to an execution agent
          agent: opencode
          depends_on: [plan]         # optional; implicit sequential otherwise
          condition: on-success
```

```bash
omninode pipeline create repo-audit --from ./pipeline.yaml
omninode pipeline validate repo-audit
omninode run repo-audit "Audit the authentication module"
omninode pipeline inspect run-…  --json
omninode pipeline retry run-…
omninode pipeline cancel run-…
```

## Step kinds

| Kind | What it does |
| --- | --- |
| `research` | creates one task per agent, **in parallel**, each analyzing the objective independently |
| `collect` | pass-through marker; upstream outputs are already accumulated |
| `analyze` | single agent with the combined context (or pass-through without an agent) |
| `plan` | produces a typed implementation plan (model or heuristic) and stores it |
| `execute` / `custom` | hands the plan to an execution agent |

## Execution semantics

- **Sequential by default**: each step depends on the previous one. Explicit
  `depends_on` unlocks **parallel branches** — ready steps run concurrently.
- **Conditions**: `on-success` (default; skipped when a dependency failed),
  `on-failure`, `always`.
- **Retries**: `retries: n` re-runs a failed step with fresh tasks.
- **Validation before anything runs**: duplicate ids, unknown/cyclic
  dependencies, unregistered agents, and malformed plan-model references are
  all rejected up front.

## Results

| Outcome | Meaning |
| --- | --- |
| `completed` | every step completed |
| `partial` | some step was incomplete or unprovable (e.g. partial research fan-out) — downstream still ran |
| `failed` | a hard failure; on-success downstream steps were skipped |
| `cancelled` | cancellation was requested: pending steps cancelled, running tasks terminated |

Reports from research/analyze steps are collected, validated, stored and
aggregated into a **combined report** ([REPORTS.md](REPORTS.md)); the plan
steps produce an implementation plan ([…](../docs/API.md)) handed to the
executor. Each run records per-step status, task ids, execution ids, the
`planId`, the `combinedReportId` and a final `resultSummary`.
