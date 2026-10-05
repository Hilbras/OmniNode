# Local development

Everything needed to run, test, and extend OmniNode on your machine.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **20+** | CI runs 20 and 22; developed on 24 |
| npm | 10+ (ships with Node 20) | any modern package manager works |

No database, broker or cloud service is needed. Integration tests spin up
local HTTP servers and child processes on demand.

```bash
git clone https://github.com/Hilbras/OmniNode.git
cd OmniNode
npm ci
npm run verify        # lint + typecheck + test + build — the full gate
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | bundle library + CLI with tsup into `dist/` |
| `npm run watch` | rebuild on change |
| `npm run clean` | remove `dist/` |
| `npm test` | run the suite once |
| `npm run test:watch` | watch mode |
| `npm run lint` | ESLint (zero warnings tolerated) |
| `npm run typecheck` | strict `tsc --noEmit` |
| `npm run format` | Prettier |
| `npm run verify` | the full gate, same as CI |
| `npm run cli -- --help` | run the CLI from source (tsx) |

## Running the CLI from source

```bash
npm run cli -- status
npm run cli -- init
npm run cli -- run demo-audit "Audit the auth module"
```

Everything lives under `.omninode/` in the working directory: tasks, runs,
reports, plans, memory and the audit log. Delete it to reset local state.

## Environment variables

| Variable | Effect |
| --- | --- |
| `OMNINODE_CONFIG` | explicit configuration file (highest precedence) |
| `OMNINODE_PROFILE` | active profile (`development`/`production`/`testing`) |
| `OMNINODE_USER_CONFIG` | user-level configuration (default `~/.omninode/config.yaml`) |
| `OMNINODE_LOG_LEVEL` / `OMNINODE_LOG_FORMAT` | log level, and `text`/`json` lines |
| `OMNINODE_MEMORY_PROVIDER` / `OMNINODE_MEMORY_REQUIRED` | memory provider selection and failure policy |
| Provider keys (`MY_API_KEY`, …) | referenced by `api_key_env_var` in config |

## Test setup

```bash
npm test                       # everything
npx vitest run tests/protocol.test.ts          # one file
npx vitest run -t "failure matrix"             # by name
```

The suite mixes fast unit tests with integration tests that spawn real
processes (`node -e …`) and real HTTP servers on ephemeral ports. Process-
spawning tests carry explicit timeouts; if one is slow on a loaded machine,
raise its timeout rather than weakening the assertion.

## A local provider (no API key, no network)

Ollama, LM Studio and vLLM all speak the OpenAI API shape, so they work as
`type: local`:

```bash
# Ollama
ollama serve
omninode provider add --name local --type local --base-url http://127.0.0.1:11434/v1
omninode models
```

## A local agent for experimenting

Any executable is an agent. A one-liner that echoes its prompt is enough to
drive the whole system without installing a CLI tool:

```bash
omninode agent add --name stub \
  --command node \
  --arg=-e \
  "--arg=let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{console.log('# Findings');console.log('- something to fix');})"
```

Then define a pipeline and run it — `examples/demo/demo.sh` does exactly this
end to end.

## Contribution workflow

```
git switch -c feat/my-change
# implement + add tests (including the failure modes you touch)
npm run verify
git commit -m "…" && git push -u origin feat/my-change
```

Releases are tag-driven (see [CONTRIBUTING.md](CONTRIBUTING.md)). Extension
guides live in [EXTENDING.md](EXTENDING.md).
