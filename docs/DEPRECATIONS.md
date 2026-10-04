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

## Planned renames (v2 roadmap Phase 1 / Phase 23)

These v1 names are kept stable for now; the roadmap's target names will be
introduced as aliases first and only replace them in a major release:

| v1 name | v2 target name |
| --- | --- |
| `IAgent` | `IAgentAdapter` (separate adapter concept in Phase 4) |
| `TaskStore` / `PipelineRunStore` / `ReportStore` / `PlanStore` | unified `IStorage` family (Phase 12) |
| `PipelineEngine` (internal class) | `IPipelineExecutor` interface (Phase 5) |
| concrete `Task` / `PipelineRun` / `Report` types | `ITask` / `IPipeline` / `IReport` (engine-facing interfaces; the data types stay) |

## Removed APIs

Nothing has been removed from the public API in the v2 cycle so far — v1.0.0
APIs remain exported, verified by the API inventory test.