# Testing (v2)

OmniNode's test suite is organized around **failure resilience**, not just
feature coverage: for every capability there is a named failure mode, and the
expected behavior of that failure is asserted.

## The failure matrix (roadmap §21)

| Failure | Expected behavior | Covered by |
| --- | --- | --- |
| Provider rate limit (429) | `RATE_LIMIT_ERROR`, `retryable: true`, provider message preserved | `failure-matrix.test.ts` |
| Provider server error (500) | `SERVER_ERROR`, `retryable: true` | `failure-matrix.test.ts` |
| Invalid API key (401) | `PROVIDER_AUTH_FAILED`, `AUTHENTICATION_ERROR`, not retryable | `failure-matrix.test.ts` |
| Missing API key reference | fails **before** any network call | `failure-matrix.test.ts` |
| Model unavailable (404) | `MODEL_NOT_FOUND` | `failure-matrix.test.ts` |
| Network loss | `NETWORK_ERROR`, `retryable: true` | `failure-matrix.test.ts` |
| Malformed gateway response | `UNKNOWN_ERROR`, no crash | `failure-matrix.test.ts` |
| OmniHilbras unavailable | degrades like any provider (still optional) | `failure-matrix.test.ts` |
| Agent crash | task `failed`, error preserved | `failure-matrix.test.ts` |
| Agent timeout | task `unknown` — **not** failed (side effects possible) | `failure-matrix.test.ts`, `execution-states.test.ts` |
| Missing executable | task `failed` with the command name in the message | `failure-matrix.test.ts` |
| Malformed JSONL | task `failed`, violations recorded, no crash | `failure-matrix.test.ts`, `protocol.test.ts` |
| Huge stdout / huge report | agent killed at the output limit; report rejected | `failure-matrix.test.ts`, `hardening.test.ts` |
| Duplicate execution | re-running a finished task is rejected (`TASK_INVALID`) | `failure-matrix.test.ts` |
| Partial pipeline failure | run `partial`, downstream still executed | `failure-matrix.test.ts`, `pipeline-lifecycle.test.ts` |
| Pipeline cancellation | pending steps cancelled, run `cancelled` | `pipeline-lifecycle.test.ts` |
| Corrupted persistence | file quarantined, store keeps working | `failure-matrix.test.ts`, `persistence-v2.test.ts` |
| Future schema version | refused, never misread | `persistence-v2.test.ts` |
| Duplicate configuration names | rejected, never silently shadowed | `failure-matrix.test.ts` |
| Remembera unavailable | tolerated by default, fatal when `required` | `failure-matrix.test.ts`, `memory-v2.test.ts` |
| Malformed report | rejected before aggregation | `failure-matrix.test.ts`, `report-v2.test.ts` |
| Invalid plan output | structured `PLAN_INVALID` or heuristic fallback | `planner-v2.test.ts` |

## Regression tests

Every production bug fixed in the v2 cycle has a regression test that names
the failure it protects against, e.g.:

- context truncation exceeding its budget (memory context)
- planner JSON contract using snake_case keys
- provider timeout not reaching the chat path
- environment profile precedence
- `--config` not reaching command handlers
- duplicate `ChatFn`/barrel export drift caught by the API-surface guard
- npm publish of a stale `dist/` (release-process guard in CI)

## Running the suite

```bash
npm test              # single run
npm run test:watch    # watch mode
npm run typecheck     # strict types
npm run lint          # eslint, no warnings tolerated
```

Integration-style tests spawn real processes and HTTP servers; they assert
behavior, not implementation, and each carries an explicit timeout.
