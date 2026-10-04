# API Stability Policy (v2)

This policy defines what OmniNode guarantees to library consumers of
`@hilbras/omninode`, what is experimental, and how changes are made.

## Stability tiers

| Tier | Meaning | Examples |
| --- | --- | --- |
| **Stable** | Semver-protected. Only removed in a major release, with deprecation first. | `IProvider`, `IChatProvider`, `IAgent`, `IPlanner`, `IMemoryProvider`, core types (`Task`, `PipelineDefinition`, `Report`, `Plan`), config schema, CLI commands, store interfaces |
| **Experimental** | May change in any release. Exported for early adopters; marked below. | JSON-lines agent protocol, `omninode status --json` shape, JSON store file layout, `FileAuditLog` event vocabulary |
| **Internal** | Not exported from the package root; no compatibility guarantee. | `src/pipelines/engine` internals, helper functions, error-code strings (codes are stable, human messages are not) |

Anything reachable from the package root (`import { … } from "@hilbras/omninode"`)
is at least **experimental**. See [API.md](API.md) for the full inventory and
tier per export.

## Semver rules

- **Patch / minor**: additive changes only — new exports, new optional config
  keys, new CLI commands. No signature changes, no removals.
- **Major**: breaking changes, preceded by a deprecation release that at
  minimum emits runtime warnings when the deprecated surface is used.
- **Config files** are schema-validated: unknown keys are rejected so typos
  fail loudly (see `src/config/schema.ts`).

## Deprecation process

1. Mark the API `@deprecated` in its JSDoc with the replacement and the
   release it will be removed in.
2. Log a warning at the first call site (runtime notice for CLI users).
3. Keep the export working until the next major release.
4. Record it in [DEPRECATIONS.md](DEPRECATIONS.md) and the changelog.

## Extension contracts

The following are the **only** sanctioned extension points. A new provider,
agent adapter, storage backend, memory backend or planner must be added by
implementing one of these interfaces — never by modifying core:

| Interface | Contract | Roadmap name |
| --- | --- | --- |
| `IProvider` / `IChatProvider` | model discovery, health, chat | `IProvider` |
| `IAgent` | run a task, cancel | `IAgent` |
| `IPlanner` | produce a `Plan` | `IPlanner` |
| `IMemoryProvider` | query/write memory | `IMemoryProvider` |
| `TaskStore` | task persistence | `IStorage` family |
| `PipelineRunStore`, `ReportStore`, `PlanStore` | run/report/plan persistence | `IStorage` family |
| `AuditSink` | append-only audit events | observability |

Names in the second column are the v2 roadmap's target names; the v1 names
remain the public API until the deprecation cycle completes.

## Rules for core changes

- Dependency direction is one-way: `types` ← engines ← adapters ← CLI.
  Adapters (providers, agents, planners, memory) must not import engine
  modules (e.g. the planner adapter must not import from `src/pipelines` —
  shared types live in `src/types`).
- Persistence is reached only through store interfaces; engines never touch
  `fs` directly.
- Every subsystem ships tests and documents its error behavior through the
  typed error hierarchy (`src/errors`).