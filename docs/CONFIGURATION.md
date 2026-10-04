# Configuration (v2)

OmniNode composes configuration from several sources with an explicit,
predictable precedence. Nothing is implicit: `omninode config validate` prints
which files, profile, environment variables and defaults were used.

## Precedence (highest first)

| # | Source | How to set it |
| --- | --- | --- |
| 1 | **CLI arguments** | `--config <file>`, `--profile <name>` |
| 2 | **Environment** | `OMNINODE_CONFIG`, `OMNINODE_USER_CONFIG`, `OMNINODE_PROFILE`, `OMNINODE_LOG_LEVEL`, `OMNINODE_LOG_FORMAT`, `OMNINODE_MEMORY_PROVIDER`, `OMNINODE_MEMORY_REQUIRED` |
| 3 | **Project configuration** | `./omninode.yaml` (also `.yml` / `.json`) |
| 4 | **User configuration** | `~/.omninode/config.yaml` (or `$OMNINODE_USER_CONFIG`) |
| 5 | **Profile overlay** | the `profiles:` block named by `--profile` / `OMNINODE_PROFILE` / `profile:` |
| 6 | **Defaults** | built-in (e.g. `logging.level: info`, `logging.format: text`) |

Arrays replace rather than merge; objects merge deeply.

```bash
omninode --config ./staging.yaml --profile production pipeline list
```

## Profiles

One file can describe several environments:

```yaml
profile: development          # active unless overridden

project:
  name: My Project

logging:
  level: info

profiles:
  development:
    logging:
      level: debug
    memory:
      provider: local
  production:
    logging:
      level: warn
  testing:
    logging:
      format: json
```

Selecting an unknown profile fails loudly with the list of known ones.
`omninode config profiles` shows the active and defined profiles.

## Secrets

Configuration may only *reference* credentials, never contain them:

```yaml
providers:
  - name: gw
    base_url: https://api.example.com/v1
    api_key_env_var: MY_API_KEY
```

Inline secrets (`api_key: sk-…`) are rejected at load time with redacted
excerpts, and `${VAR}` / `${VAR:-fallback}` references are expanded at load.

## Diagnostics

`omninode config validate` reports sources, defaults and *actionable* problems:

```
omninode.yaml is valid — project "My Project" with 1 provider(s), 2 agent(s), 1 pipeline(s).
  profile:  development
  defaults applied: logging.level, logging.format
  diagnostics:
    - Provider "deepseek": API key reference is missing — add api_key_env_var: <ENV_VAR> unless this endpoint is intentionally keyless.
    - Agent "opencode": may run outside the project root (allow_external_cwd).
```

Unknown keys are rejected, so typos fail loudly instead of being ignored.
