# Troubleshooting

Common symptoms, causes and fixes. Start with `omninode status` and
`omninode config validate` — they report the active sources, defaults and
diagnostics.

## Configuration

**`CONFIG_NOT_FOUND`**
No `omninode.yaml` in the working directory or user config
(`~/.omninode/config.yaml`). Run `omninode init`, or point at a file with
`--config path/to/file.yaml`.

**`CONFIG_INVALID: … contains N inline secret(s)`**
A literal credential was found in configuration. Replace it with a reference:
`api_key_env_var: MY_API_KEY`. The value is never echoed.

**`Profile "staging" is not defined`**
`--profile`/`OMNINODE_PROFILE` names a profile with no `profiles:` entry. Run
`omninode config profiles` to see what exists.

**A change to my config is ignored**
Check the precedence: `--config` > `OMNINODE_*` > project file > user file >
profile overlay. `omninode config validate` prints which source won.

## Providers

**`PROVIDER_AUTH_FAILED` / `AUTHENTICATION_ERROR`**
The referenced key variable is unset or wrong. Verify the variable is exported
in OmniNode's environment, then `omninode provider test <name>`.

**`RATE_LIMIT_ERROR` (429)**
Retryable. Wait, or lower concurrency (fewer research agents per run).

**`MODEL_NOT_FOUND` (404)**
The gateway does not expose that model id. `omninode models` lists what it
actually offers; use `provider:model-id` exactly as listed.

**`NETWORK_ERROR`**
The endpoint is unreachable — wrong base URL, proxy, or container networking.
A keyless local runtime should use `type: local` with an `http://` URL.

## Agents

**Task is `unknown`**
The agent was killed on timeout *after* dispatch; it may have finished the work.
Inspect artifacts, then `omninode task retry <id> --run` if you want a fresh
execution. This is intentional — a timeout is not proof of failure.

**`AGENT_NOT_FOUND` for a configured agent**
The executable is missing or not on PATH. `omninode agent test <name>` runs it
directly and prints the real error.

**Agent output looks wrong / protocol errors**
`omninode task inspect <id>` shows `result.protocol` — the agent descriptor,
questions asked and every protocol violation.

**Agent cannot see an environment variable**
It inherits OmniNode's environment by default. For isolation set
`env_policy: explicit` (and pass what the agent needs under `env:`). See
[SECURITY.md](SECURITY.md).

## Pipelines

**A run shows `partial`**
Some step was incomplete or unprovable (a research agent timed out, for
example) — the rest still ran. `omninode pipeline inspect <run-id>` shows which
step and why.

**A run shows `failed` and later steps were skipped**
A hard failure with `condition: on-success`. Use `condition: on-failure` or
`always` for cleanup/diagnostic steps.

**A run is stuck / was interrupted**
A run left `running` without a finish time was interrupted (crash, kill).
`omninode pipeline retry <run-id>` re-runs it; tasks are reusable evidence —
the retry creates a new run rather than rewriting history.

**A plan step fell back to the heuristic planner**
The model output was not valid plan JSON. `omninode plan show <id>` shows the
stored plan and `generatedBy`.

## Data & state

**A store file looks wrong**
`omninode status` — corrupt files are quarantined as `<name>.corrupt-<ts>`
and the store continues empty. `omninode migrate --check` reports schema
versions before `omninode migrate` rewrites v1 data.

**Older OmniNode data is not visible**
Schema-versioned documents: files written by a newer OmniNode are refused
(not misread). Downgrade with an older release or remove the store — it is
derived state.

**Everything looks slow**
Store writes are atomic by default; `fsync` durability is opt-in. Large
research fan-outs spawn one process per agent — reduce `agents:` before
reaching for durability settings.
