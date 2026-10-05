# Remembera API contract

The formal contract the OmniNode Remembera adapter implements. OmniNode never
assumes internals of the Remembera server beyond this document — if the real
API differs, the single adjustment point is
[`src/memory/remembera.ts`](https://github.com/Hilbras/OmniNode/tree/main/src/memory/remembera.ts).

**Contract version:** `remembera-api/v1`
**Transport:** HTTPS + JSON
**Auth:** `Authorization: Bearer <token>` — the token is an environment
variable referenced by `api_key_env_var` in `omninode.yaml`.

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/memory` | POST | Store / upsert one memory entry |
| `/api/memory/query` | POST | Relevance-ranked retrieval |

## Memory entry

```jsonc
{
  "key": "finding:rep-1:f1",     // required, unique upsert key
  "scope": "project",            // project | task | role | knowledge
  "category": "problems",        // optional: project | architecture | decisions |
                                 // tasks | problems | solutions | conventions | agent_reports
  "content": "…",                // required
  "tags": ["known-problem"],     // optional
  "createdAt": "…",              // optional (set by the backend)
  "updatedAt": "…",              // optional (set by the backend)
  "metadata": {}                 // optional
}
```

## Store request/response

```jsonc
// POST /api/memory
{ "key": "…", "scope": "project", "content": "…", "tags": ["…"] }

// 200/201 — stored. Any other status is a MemoryError with the HTTP status
// preserved in the message.
```

## Query request/response

```jsonc
// POST /api/memory/query
{
  "text": "authentication jwt",  // optional free-text query
  "scope": "project",            // optional
  "category": "problems",        // optional
  "tags": ["known-problem"],     // optional (all must match)
  "limit": 10                    // optional
}

// 200
{ "entries": [ { "key": "…", "scope": "project", "content": "…", "tags": [] } ] }
```

Entries missing `key` or `content` are skipped by the adapter; entries without
`scope` default to `knowledge`.

## Error handling

| Condition | Adapter behavior |
| --- | --- |
| HTTP 200/201 on store | success |
| HTTP 200 with `entries[]` on query | success; invalid entries skipped |
| Any other 2xx–5xx status | `MemoryError` with the status in the message |
| Timeout / connection failure | `MemoryError` (cause preserved) |
| Auth failure | `PROVIDER_AUTH_FAILED` — raised before any request is sent |

## Failure policy

Configured by `memory.required` in `omninode.yaml`:

| `required` | Backend unreachable / failing |
| --- | --- |
| `false` (default) | warning logged, execution continues without memory |
| `true` | `MemoryError` propagates — a task that needs context fails loudly |

## Versioning

The adapter implements `remembera-api/v1`. If the server response shape
changes, this file and the adapter are the only two places to update. Unknown
extra fields in responses are ignored; missing optional fields are defaulted.
