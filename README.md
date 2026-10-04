# OmniNode

[![CI](https://github.com/Hilbras/OmniNode/actions/workflows/ci.yml/badge.svg)](https://github.com/Hilbras/OmniNode/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![npm downloads](https://img.shields.io/npm/dm/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![Node.js support](https://img.shields.io/node/v/@hilbras/omninode)](https://www.npmjs.com/package/@hilbras/omninode)
[![License: MIT](https://img.shields.io/github/license/Hilbras/OmniNode)](LICENSE)
[![Roadmap phase](https://img.shields.io/badge/phase-0_%2F_11-Foundation-8A2BE2)](docs/DEVELOPMENT_PLAN.md)

**OmniNode** is a provider-agnostic multi-AI orchestration platform. It coordinates
CLI-based AI agents, AI providers, persistent memory, roles, reports and planning
into a unified execution system — so multiple AI systems can collaborate on complex
software engineering and knowledge-work tasks.

OmniNode is **not an AI provider** and is **not dependent on OmniHilbras** (or on
OpenAI, Gemini, DeepSeek, Qwen, or any other specific vendor). It orchestrates
existing intelligence; it does not try to become another model.

## Status

**v0.2.0 — Phase 1: Provider Infrastructure** (see [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)
for the full plan and roadmap).

What exists today:

- Core type contracts: provider, model, agent, role, task, report, pipeline,
  protocol, memory (`src/types/`)
- **Provider system** (`src/providers/`, `src/registry/`):
  - OpenAI-compatible adapter — works with OpenAI, OpenRouter, local runtimes
    (Ollama, LM Studio, vLLM) and custom gateways exposing `/models` and `/chat/completions`
  - Model discovery with normalization into the model registry (`provider:model` keys)
  - Health checks: connectivity, authentication and server-error classification
  - Authentication from environment variables only — keys never touch config files
  - Chat completions (`IChatProvider`) — the foundation for the planner phases
  - Provider factory mapping config to adapters (OmniHilbras gets a dedicated
    adapter in Phase 2)
- Typed error hierarchy (`src/errors/`)
- Leveled logger with pluggable sink (`src/logger/`)
- Configuration system: `omninode.yaml` with `${ENV_VAR}` expansion and strict
  validation (`src/config/`)
- CLI: `init`, `provider add/list/test`, `models`, `agent list`, `role list`,
  and honest stubs for the phase-dependent commands (`src/cli/`)
- Test infrastructure (Vitest) and CI (GitHub Actions)

## Requirements

- Node.js >= 20

## Quick start (from source)

```bash
npm install
npm run build
node dist/cli/index.js --help

# Or run from source:
npm run omninode -- --help
```

Start a project:

```bash
omninode init                 # writes omninode.yaml in the current directory

# Register a provider and verify it end to end
omninode provider add --name my-gateway --type openai-compatible \
  --base-url https://example.com/v1 --api-key-env-var MY_API_KEY
omninode provider test my-gateway

# Discover models into the registry
omninode models
omninode models my-gateway --capability chat

omninode agent list
omninode role list
```

See [omninode.yaml.example](omninode.yaml.example) for a full configuration.

### Configuration

OmniNode reads `omninode.yaml` (or `.yml` / `.json`) from the working directory.
Two rules matter:

1. **Credentials never live in the file.** Reference environment variables with
   `api_key_env_var: MY_API_KEY`; `${VAR}` / `${VAR:-fallback}` references anywhere
   in the file are expanded at load time and unset variables abort loading.
2. **Unknown keys are rejected.** Typos fail loudly instead of being ignored.

## Development

```bash
npm run build        # bundle with tsup (library + CLI)
npm test             # run tests once
npm run test:watch   # watch mode
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier
```

## Roadmap

Phases 0–11 are laid out in [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md):

| Version | Milestone |
| --- | --- |
| v0.1.0 | Foundation |
| **v0.2.0** | **Provider System (current)** |
| v0.3.0 | OmniHilbras Integration (optional, like every provider) |
| v0.4.0 | Agent System |
| v0.5.0 | Roles & Tasks |
| v0.6.0 | Pipeline Engine |
| v0.7.0 | Multi-AI Reports |
| v0.8.0 | Remembera (optional memory integration) |
| v0.9.0 | Planner |
| v0.10.0 | End-to-End Runtime |
| v1.0.0 | Production Release |

Core architectural rule: OmniNode must run successfully with **zero Hilbras
dependencies**. OmniHilbras and Remembera make it more powerful, but neither is
required for the core engine.

## Install

```bash
npm install -g @hilbras/omninode
```

Or use it as a library: `npm install @hilbras/omninode`.

## License

[MIT](LICENSE)
