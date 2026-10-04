# Migration: v1 → v2

OmniNode 2.0 keeps every v1 configuration file working. This guide covers what
changed, what is deprecated, and how to move a project forward.

## Compatibility summary

| Area | Status |
| --- | --- |
| `omninode.yaml` (v1 shape) | **works unchanged** |
| CLI commands from v1 | **work** (new aliases and flags added) |
| `IAgent`, `IProvider`, `TaskStore`, `TaskEngine`, … | **stable**, no breaking changes |
| Stored data | read automatically, migrated by `omninode migrate` |
| `query` / `write` memory aliases | deprecated, still functional |
| Human-facing CLI output | unchanged where it matters; `--json` added |

## Storage migration

v1 wrote bare JSON arrays; v2 writes `{ "schemaVersion": 2, "items": [...] }`.

```bash
omninode migrate --check   # report what would change
omninode migrate           # rewrite in place (idempotent)
```

Automatic in practice: a v1 file is read correctly and rewritten at the
current schema on the next write. Files written by a **newer** OmniNode are
refused rather than misread.

## Configuration additions

Everything below is optional and defaults to previous behavior:

```yaml
profile: development     # named overlays in `profiles:`
profiles:
  development: { logging: { level: debug } }

project:
  memory:
    provider: local
    required: false      # true makes memory failures fatal
  planner:
    kind: model          # or: heuristic
    model: my-gateway:chatgpt
  pipelines:
    - id: audit
      steps:
        - id: research
          kind: research
          agents: [kimi, gemini]
          retries: 1
        - id: plan
          kind: plan
          model: my-gateway:chatgpt
          constraints: [no breaking API changes]
```

New agent options: `input_mode` (protocol mode is new), `env_policy`,
`env_allowlist`/`env_denylist`, `max_output_bytes`, `allow_external_cwd`.
New provider option: `timeout_ms`.

## Behavior changes worth knowing

1. **A timed-out agent leaves the task `unknown`, not `failed`.** The agent may
   have completed the work remotely; resolve with `task retry`.
2. **Reports are validated.** Malformed reports are rejected before
   aggregation (they appear in `omninode report list` diagnostics via the
   service) instead of flowing into a combined report.
3. **Duplicate configuration names are an error** — they used to silently
   shadow each other.
4. **Provider errors carry a normalized `kind`** in `error.details`
   (`RATE_LIMIT_ERROR`, `MODEL_NOT_FOUND`, …). `error.code` is unchanged.
5. **CLI exit codes are meaningful** (2 invalid input, 3 config, 4 provider,
   5 agent, 6 timeout, 7 cancelled, 8 not found, 9 not implemented). Scripts
   that only checked "non-zero" keep working.

## Deprecated APIs

| v1 | v2 | Removal |
| --- | --- | --- |
| `IMemoryProvider.query/write` | `retrieve/store` | v3 |
| `ChatFn` re-exported from `pipelines` | import from the types layer | v3 |

See [DEPRECATIONS.md](DEPRECATIONS.md).

## Protocol

Agents speaking the v1 ad-hoc `{meta, message}` shape still work — inbound
messages without a `protocol` field are treated as v1. Emit
`omninode-agent-protocol/2` envelopes for full features (correlation,
questions, strict validation). See [PROTOCOL.md](PROTOCOL.md).

## Upgrade steps

```bash
npm install -g @hilbras/omninode@latest
omninode config validate
omninode migrate --check && omninode migrate
omninode status
omninode task list --json | jq '.[].status' | sort | uniq -c
```
