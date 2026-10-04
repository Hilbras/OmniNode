# OmniNode Security Model

OmniNode runs AI agents that can execute commands, read and write files, and
call paid APIs. This document describes what OmniNode itself enforces, what it
does not, and how to configure it defensively.

## Secrets

- **Credentials never live in project files.** Providers and the memory adapter
  reference secrets by environment-variable *name* (`api_key_env_var`) and the
  value is resolved at run time.
- **Inline secrets are rejected before parsing** (§17): `omninode.yaml` is
  scanned for literal `api_key` / `token` / `password` / `secret` /
  `credential` values. Findings are reported with the line number and a
  **redacted** excerpt — the value is never echoed — and the config is refused
  with the fix (`api_key_env_var: MY_API_KEY`). References
  (`${VAR}`, `$VAR`, `<from-store>`, empty) pass.
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
process — including any API keys present in it. Four explicit policies let you
choose exactly what an agent sees:

```yaml
project:
  agents:
    - name: inherits-all
      command: trusted-agent
      env_policy: inherit          # default (v1 behavior)

    - name: minimal
      command: untrusted-agent
      env_policy: explicit         # only PATH, HOME and `env:` entries

    - name: only-allowed
      command: some-agent
      env_policy: allowlist
      env_allowlist: [HOME, LANG, CI]
      env_denylist: []             # (unused for allowlist)

    - name: everything-but-secrets
      command: some-agent
      env_policy: denylist
      env_denylist: [OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY]
```

`inherit_env: false` remains supported and maps to `explicit`.

## Process containment

- Agents run in their own process group on POSIX; timeout, cancellation and
  OmniNode's own SIGINT/SIGTERM terminate the whole group, so agents cannot
  leave orphaned children behind.
- Working directories are validated (existence, access, normalization) and
  confined to the project root unless `allow_external_cwd: true`.
- Runaway output is capped (5 MiB per stream by default) and the agent is
  killed when it exceeds the budget.

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

## Output limits

| Limit | Default | Where |
| --- | --- | --- |
| Agent stdout / stderr per stream | 5 MiB | agent config (`max_output_bytes`) |
| Protocol message | 1 MiB | `MAX_MESSAGE_BYTES` |
| Single report | 256 KiB | `MAX_REPORT_BYTES` |
| Injected memory context | 4 000 chars | `MAX_CONTEXT_CHARS` |

## Agent trust model

> **Agents execute with the permissions of the operating-system user running
> OmniNode.**

An agent is a child process: it can read the files, use the network and invoke
tools that user can. OmniNode scopes *what it sends* (environment, context,
output limits); it does not restrict *what the process can do*.

**OmniNode is not a sandbox.** For untrusted agents, run them in a container or
under a dedicated OS user. Future isolation mechanisms are out of scope for
this release and are not claimed anywhere in this document.

## Checking a project's posture

```bash
omninode security audit
```

Reports (advisory, changes nothing): agents inheriting the full environment,
agents allowed outside the project root, explicit per-agent env injection,
providers/memory without credential references — plus the trust model above.

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