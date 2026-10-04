# CLI (v2)

The OmniNode CLI is the developer-facing surface: human-readable by default,
machine-readable on demand, with stable exit codes.

## Command groups

```text
omninode
├── init                     create omninode.yaml
├── config                   show | path | validate  (never prints secrets)
├── provider                 add | remove | list | test | inspect
├── model(s)                 discover and list models (provider:model keys)
├── agent                    add | list | inspect | test | run
├── role                     list
├── task                     create | run | status | list | inspect | cancel | retry
├── pipeline                 create | validate | run | retry | list | runs | status | inspect | cancel
├── report                   list | combined | show
├── plan                     list | show
├── memory                   status | query | write
├── audit                    tail the audit log
├── migrate                  upgrade persisted store files (schema v2)
├── security                 audit (advisory posture review)
└── status                   project state overview
```

## Output modes

- **Human-readable** (default) — formatted text for terminals.
- **`--json`** — one JSON document, for scripts and CI. Available on the list
  and inspect commands (`task list`, `pipeline list`, `provider list`,
  `agent list`, `role list`, `plan list`, `report list`, `report combined`,
  `model`, `memory query`, and every `inspect`).
- **JSONL logs** — set `logging.format: json` in the configuration to emit one
  JSON object per log line.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general failure (including a task/pipeline that finished `failed`) |
| 2 | invalid input (bad flags, invalid plans/tasks/pipelines) |
| 3 | configuration error |
| 4 | provider failure |
| 5 | agent failure |
| 6 | timeout |
| 7 | cancelled |
| 8 | not found |
| 9 | not implemented yet |

```bash
omninode run flow "…" || case $? in
  2) echo "bad input" ;;
  6) echo "timed out" ;;
esac
```

## Common recipes

```bash
# Configure and verify
omninode init
omninode provider add --name gw --base-url https://api.example.com/v1 --api-key-env-var MY_KEY
omninode agent add --name opencode --command opencode --input-mode arg
omninode config validate

# Discover models and plan a workflow
omninode models
omninode pipeline create audit --from ./pipeline.yaml
omninode run audit "Audit the authentication module"

# Inspect afterwards (machine or human)
omninode pipeline inspect run-…  --json | jq .
omninode task inspect task-…
omninode audit -n 50

# Recover
omninode task retry task-… --run
omninode pipeline retry run-…
```

## Secrets

CLI output never contains credential *values* — only the environment-variable
names a provider references. `config show` is safe to paste into an issue.
