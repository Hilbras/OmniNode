# Deprecations

Deprecated APIs and their migration path. An API stays exported and working
until the next major release after it is listed here (see
[API_STABILITY.md](API_STABILITY.md) for the full policy).

## Active deprecations

| API | Deprecated in | Replacement | Removal |
| --- | --- | --- | --- |
| `ChatFn` re-exported from `src/pipelines` | 2.0.0-alpha.1 | import `ChatFn` from `src/types/chat` (it is still exported from the package root either way) | v3.0.0 |

The re-export exists so v1 code keeps compiling; new code should treat
`ChatFn` as a plain function type in the chat contracts.

## Behaviour changes

| Behaviour | Changed in | Before | After |
| --- | --- | --- | --- |
| `omninode task run` exit code for a task that ends in status `unknown` | v2.0.4 | `0` (success) | `6` (timeout) |

`unknown` is the normal outcome of an agent timeout: the agent was dispatched
and its completion could not be proven. Reporting success made a CI pipeline
treat a timed-out task as a pass. Scripts that relied on the old `0` must now
distinguish the timeout exit code — see [CLI.md](CLI.md) for the exit-code
table.

## Planned renames (designed in v2 roadmap Phase 1 / Phase 23)

These v1 names are kept stable; the roadmap's target names will be
introduced as aliases first and only replace them in a major release
(the v2 phases shipped without breaking them):

| v1 name | v2 target name |
| --- | --- |
| `IAgent` | `IAgentAdapter` (separate adapter concept in Phase 4) |
| `TaskStore` / `PipelineRunStore` / `ReportStore` / `PlanStore` | unified `IStorage` family (Phase 12) |
| `PipelineEngine` (internal class) | `IPipelineExecutor` interface (Phase 5) |
| concrete `Task` / `PipelineRun` / `Report` types | `ITask` / `IPipeline` / `IReport` (engine-facing interfaces; the data types stay) |

## Removed APIs

Nothing has been removed from the public API in the v2 cycle so far — v1.0.0
APIs remain exported, verified by the API inventory test.