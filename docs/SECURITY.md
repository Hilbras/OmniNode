# OmniNode Security Model

OmniNode runs AI agents that can execute commands, read and write files, and
call paid APIs. This document describes what OmniNode itself enforces, what it
does not, and how to configure it defensively.

## Secrets

- **Credentials never live in project files.** Providers and the memory adapter
  reference secrets by environment-variable *name* (`api_key_env_var`,
  `api_key_env_var` for memory) and the value is resolved at run time.
  `${VAR}` / `${VAR:-default}` references in `omninode.yaml` are expanded at
  load time; an unset variable without a default aborts loading rather than
  silently misconfiguring authentication.
- `omninode.yaml` is gitignored by the template; `.omninode/` (tasks, reports,
  plans, memory, audit log) is gitignored by the repository.
- Command output (`omninode provider list`, `agent list`, …) prints
  configuration, never secret values.

## Command execution

- Agents are launched with `spawn` (no shell), so arguments and prompts
  containing shell metacharacters are **not** interpreted as commands.
- Task prompts are written to the agent's stdin (or passed as a single argv
  entry in `arg` mode) — never concatenated into a shell string.
- Timeouts are enforced per task (`timeout_ms`, default 10 minutes); the
  process is SIGTERM'd and then SIGKILL'd, and orphaned children are the
  agent's own responsibility.

## Environment isolation

By default a spawned agent **inherits the full environment** of the OmniNode
process — including any API keys present in it. To avoid leaking OmniNode's own
credentials into third-party agents, set `inherit_env: false` on the agent:

```yaml
project:
  agents:
    - name: untrusted-agent
      command: some-agent
      inherit_env: false     # child receives only PATH, HOME and `env:` entries
```

## Audit logging

Task and pipeline lifecycle events (creation, transitions, retries, run
start/finish, generated plans) are appended to `.omninode/audit.jsonl`. Read
them with `omninode audit`. The log is append-only from OmniNode's side and
contains no secret values.

## Network and data

- Outbound network access happens only where configured: provider endpoints
  and the memory adapter. There are no telemetry or phone-home calls.
- Agent processes are child processes with the same OS user as OmniNode;
  there is no container or VM sandbox. Run untrusted agents inside a
  container or under a dedicated OS user if that matters to you.

## Known limitations (v1.0)

- Task/agent execution inherits OmniNode's OS permissions — OmniNode does not
  sandbox agent file access.
- Reports and memory entries are stored as plain JSON/JSONL on disk; protect
  `.omninode/` with filesystem permissions if it contains sensitive material.
- The Remembera adapter's API convention is assumed, not verified against a
  published spec — see `src/memory/remembera.ts`.

## Reporting vulnerabilities

Please report security issues privately via GitHub Security Advisories on
[Hilbras/OmniNode](https://github.com/Hilbras/OmniNode/security/advisories/new).