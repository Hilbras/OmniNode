# Persistence (v2)

OmniNode stores everything locally, in plain JSON, under the project's
`.omninode/` directory. The storage contracts are interfaces, so a different
backend (SQLite, Postgres, a remote API) can replace the defaults without
touching orchestration logic.

## The storage interfaces

| Canonical name | Interface | Default implementation | File |
| --- | --- | --- | --- |
| `TaskStore` | `TaskStore` | `FileTaskStore` | `tasks.json` |
| `PipelineStore` | `PipelineRunStore` | `FilePipelineRunStore` | `pipelines.json` |
| `ReportStore` | `ReportStore` | `FileReportStore` | `reports.json` |
| `PlanStore` | `PlanStore` | `FilePlanStore` | `plans.json` |
| `MemoryStore` | `IMemoryProvider` (local backend) | `LocalMemoryProvider` | `memory.json` |
| `AuditStore` | `AuditSink` | `FileAuditLog` | `audit.jsonl` |

Canonical aliases live in `src/persistence/store-types.ts`; the v1 interface
names remain the exported API.

## Durability

Every write is **temp file → fsync → atomic rename → directory fsync**, so a
crash mid-write can never leave a half-written store. Read-modify-write cycles
are serialized per store, so parallel fan-out tasks cannot lose updates.

## Corruption handling

- Unparseable files are **quarantined**, not deleted: the file is renamed to
  `<name>.corrupt-<timestamp>` and the store continues empty. The damaged
  data stays available for inspection.
- Files written by a **newer** OmniNode (higher `schemaVersion`) are refused
  rather than misread — they are left untouched.
- `onCorrupt` hooks receive every event, and `omninode status` still works.

## Schema versioning & migration

Documents are envelopes:

```json
{ "schemaVersion": 2, "items": [ … ] }
```

OmniNode 1.x wrote bare arrays; those are read as **v1-legacy** and rewritten
at the current schema on the next write. To upgrade explicitly:

```bash
omninode migrate --check   # report what would change
omninode migrate           # rewrite v1 documents in place (idempotent)
```

`migrateProjectStores()` does the same programmatically and reports per-file
state: `missing`, `empty`, `v1-legacy`, `current`, `future`, `corrupt`. Future
and corrupt files are reported and never rewritten.

## Custom backends

Implement the store interface (and `mutate`-style atomicity yourself) and
pass it to `TaskEngine` / `PipelineEngine` / `ReportService` options. The
engines never touch the filesystem directly — that separation is what makes
alternative backends possible.

## Files you can safely delete

`.omninode/` is entirely derived state. Removing it resets the project's task
history, reports, plans and memory; configuration (`omninode.yaml`) is
unaffected.