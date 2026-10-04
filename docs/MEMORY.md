# Memory (v2)

Memory makes OmniNode remember: what a project decided, what broke, what an
agent found before. Remembera is the preferred backend, but **memory is
optional** — the local provider works out of the box, and a memory failure
never breaks a task unless you explicitly ask it to.

## The contract (§12)

```ts
interface IMemoryProvider {
  readonly name: string;
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;  // relevance-ranked retrieval
  store(entry: MemoryEntry): Promise<void>;              // upsert by key
  search(text: string, options?): Promise<MemoryEntry[]>;
  metadata(): MemoryProviderMetadata;                    // capabilities + backend info
  query(...)  // v1 alias of retrieve
  write(...)  // v1 alias of store
}
```

Adapters ship capability metadata so callers can adapt (e.g. a backend without
category support). Both built-in adapters implement the full contract; the
shared contract suite in `tests/memory-v2.test.ts` runs against each of them.

## Scopes and categories

- **Scopes** (the formal contract): `project`, `task`, `role`, `knowledge`.
- **Categories** (structured, §12): `project`, `architecture`, `decisions`,
  `tasks`, `problems`, `solutions`, `conventions`, `agent_reports`.

OmniNode writes task outcomes under category `tasks` and promotes
high/critical findings to project scope under `problems` — so the next run
knows what is already known-broken.

## The loop (§20)

```
Task → context query → relevant memory → agent context → run → outcome → memory
```

Retrieval is **task-oriented and budgeted** — OmniNode never loads all memory
into a prompt. `MemoryService.contextFor()` returns the entries it selected,
prompt-ready text, and a `truncated` flag when the character budget (4k by
default) cut the context short.

## Failure handling

| Configuration | Behavior when the backend is unreachable |
| --- | --- |
| default | Log a warning, continue the task without memory |
| `memory.required: true` | Raise `MemoryError`; a task that needs context fails loudly |

```yaml
project:
  memory:
    provider: remembera
    base_url: https://your-remembera-host
    api_key_env_var: REMEMBERA_API_KEY
    required: false        # true when memory is a hard dependency
```

## Backends

- **local** (default): `.omninode/memory.json`, deterministic keyword/tag
  relevance scoring, category + scope filtering, zero dependencies.
- **remembera**: HTTP adapter (`POST /api/memory`, `POST /api/memory/query`,
  Bearer auth). Its API convention is documented in the adapter — a single file
  to adjust if the real API differs.

## CLI

```bash
omninode memory status                      # provider + entry counts
omninode memory query "authentication jwt"  # what agents will see
omninode memory write "Decision: rotating JWT secrets" --scope project
```

## Extending

Implement `IMemoryProvider` (`retrieve`/`store` are the only required
methods; `search`/`metadata` have sensible defaults via the shared helpers)
and register it in `createMemoryProvider`.