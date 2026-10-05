# v2.0.0 Final Hardening Audit

The full system audit required by the v2 roadmap (§28) before declaring v2.0.0
stable. Executed at the end of Phase 24; every claim below is backed by a test
in the suite (480 tests) or a mechanical guard, not by intention.

## Architecture audit — PASS

| Check | Result | Enforcement |
| --- | --- | --- |
| Module boundaries | types ← persistence/adapters ← engines ← CLI | `tests/architecture.test.ts` (dependency-direction scan over every import) |
| Adapter isolation | adapters never import engines or the CLI | same guard |
| Filesystem access | only in store implementations, audit, config, cwd validation, CLI | same guard (`node:fs` scan) |
| Public APIs | curated barrel; documented exports exist; withheld internals stay withheld | `tests/api-surface.test.ts`, `tests/public-api.test.ts` |
| OmniHilbras isolation | referenced only by the provider layer, config schema and public barrel | `tests/omnihilbras-v2.test.ts` guard |

## Security audit — PASS

| Check | Result |
| --- | --- |
| Secrets in configuration | rejected before parsing (`scanForInlineSecrets`), redacted excerpts, actionable fix |
| Secrets to agents | four explicit environment policies (`inherit`/`allowlist`/`denylist`/`explicit`) |
| Process execution | `spawn` only — a static guard fails the build on `exec`/`execSync`/`shell: true` |
| Working-directory confinement | validated (existence, access, project boundary) before spawn |
| Output limits | 5 MiB/stream (agents), 1 MiB (protocol), 256 KiB (reports), 4k/20k chars (contexts) |
| Dependencies | `npm audit --omit=dev`: **0 vulnerabilities**; one low dev-only advisory (esbuild dev server on Windows — not applicable to our Linux CI/runtime) |
| Trust model | documented plainly in [SECURITY.md](SECURITY.md): agents run with the OS user's permissions; OmniNode is not a sandbox |

## Reliability audit — PASS

| Check | Result |
| --- | --- |
| State machine | strict transition table; invalid transitions rejected (`execution-states.test.ts`) |
| Unknown states | a dispatched timeout is `unknown`, never `failed`; resolved only by explicit retry |
| Retry safety | bounded attempts, linear backoff, retryable-error allow-list, execution history |
| Cancellation | first-class run cancellation; running tasks terminated with their process trees |
| Persistence failures | corruption quarantined, future schemas refused, writes serialized and atomic |
| Partial failures | `partial` run status; downstream still runs on real output |
| Memory failures | tolerated by default; fatal only when `memory.required: true` |

## Protocol audit — PASS

| Check | Result |
| --- | --- |
| Version compatibility | v2 declared; v1 (unversioned) accepted; unsupported versions rejected |
| Message validation | total decoder — malformed input becomes typed violations, never a crash |
| Correlation | every envelope carries message/request/task/agent/pipeline/execution ids |
| Malformed input matrix | covered in `protocol.test.ts` and the failure matrix |

## Performance audit — PASS

| Check | Result |
| --- | --- |
| Bounded accumulation | combined reports capped (200 groups), context budgeted (4k/20k chars) |
| Bounded output | 5 MiB/stream agent output, 1 MiB protocol messages |
| Bounded disk | audit log rotates at 5 MiB |
| Handle release | child pipes destroyed on settle; 25 sequential runs show no handle growth |
| Scheduling | waves throttled to `maxParallelSteps` (default 8) |
| Concurrency safety | 40-way concurrent store writes verified lossless |

## Accepted limitations (honest scope)

- OmniNode does **not** sandbox agents; they run with the OS user's permissions.
- The Remembera adapter's HTTP convention is assumed, not verified against a
  published spec (single-file adjustment point).
- One low dev-only npm advisory (esbuild dev server, Windows) remains — not
  reachable from the shipped runtime.
- Source maps ship in the npm package deliberately (CLI debugging value).

## Release gates

`npm run gates` — version consistency, package contents, secret scanning — all
pass, and run in CI on every push and in the release workflow before publish.
