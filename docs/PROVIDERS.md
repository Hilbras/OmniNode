# Providers (v2)

A provider is any AI model gateway OmniNode can talk to. Adding one means
implementing `IProvider` (plus `IChatProvider` for chat) — **no core changes**.

## The contract

```ts
interface IProvider {
  readonly config: ProviderConfig;        // providerId, name, type, baseUrl, auth ref, capabilities…
  readonly providerId: string;            // stable id (defaults to name)
  readonly authentication: ProviderAuthentication; // { method, envVar, configured } — never a secret
  connect(): Promise<ModelInfo[]>;        // authenticate + discover
  listModels(): Promise<ModelInfo[]>;
  getModel(modelId: string): Promise<ModelInfo | undefined>;
  healthCheck(): Promise<ProviderStatus>; // healthy | degraded | unreachable
}

interface IChatProvider extends IProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
```

## Configuration

```yaml
project:
  providers:
    - name: my-gateway                  # name used in the registry and CLI
      provider_id: acme-prod            # optional stable id
      type: openai-compatible           # openai-compatible | openrouter | local | custom | omnihilbras
      base_url: https://api.example.com/v1
      api_key_env_var: MY_API_KEY       # reference only — secrets are never stored in config
      capabilities: [chat, models, tools]
```

Built-in adapters: **OpenAI-compatible** (OpenAI, OpenRouter, Ollama, LM Studio,
vLLM, custom gateways) and **OmniHilbras** (`type: omnihilbras`, which adds the
connect-and-register flow). Local runtimes use `type: local` with a
`http://localhost:…` base URL.

## Model metadata

Discovered models are normalized so the rest of OmniNode never parses provider
payloads:

| Field | Notes |
| --- | --- |
| `id`, `name`, `provider` | identity |
| `contextWindow` | from `context_length` / `context_window` when reported |
| `inputTypes` / `outputTypes` | `text`, `image`, `audio`, `video`, `embedding` |
| `supportsTools` / `supportsStructuredOutput` / `supportsStreaming` | derived from `supported_parameters` when present |
| `status` | `available` by default |

Gateways that report nothing beyond an id are fine — fields stay `undefined`
and capability filters simply won't match them.

## Error normalization

Every provider failure is mapped to a stable `kind` in `error.details.kind`,
so callers react to categories instead of provider-specific payloads:

| kind | Typical HTTP | Retryable |
| --- | --- | --- |
| `AUTHENTICATION_ERROR` | 401, 403 | no |
| `RATE_LIMIT_ERROR` | 429 | yes |
| `INVALID_REQUEST` | 4xx | no |
| `MODEL_NOT_FOUND` | 404 | no |
| `TIMEOUT` | 408, 504, abort | no |
| `NETWORK_ERROR` | transport failure | yes |
| `SERVER_ERROR` | 5xx | yes |
| `UNKNOWN_ERROR` | anything else | no |

The legacy stable codes (`PROVIDER_AUTH_FAILED`, `MODEL_NOT_FOUND`,
`PROVIDER_UNAVAILABLE`) remain on `error.code` for compatibility; `retryable`
and `retryAfterMs` (from `Retry-After`) are surfaced in `error.details`.

## Adding a provider

```ts
import { OpenAICompatibleProvider } from "@hilbras/omninode";
// For anything OpenAI-shaped: extend the adapter or register it via createProvider.
```

1. Implement `IProvider`/`IChatProvider`.
2. Register the type in `createProvider` (`src/providers/factory.ts`).
3. Add tests for discovery, error mapping and health classification.

## Streaming

Where a gateway supports SSE streaming, adapters expose:

```ts
const response = await provider.stream?.(request, (chunk) => process.stdout.write(chunk.delta));
// chunk: { delta, finishReason?, raw? } — response.content is the assembled text
```

## OmniHilbras

`type: omnihilbras` selects the dedicated adapter, which adds:

- **Gateway metadata**: the discovery response's `gateway` object (version,
  tier, region…) is captured via `gatewayMetadata()` and attached to every
  discovered model.
- **`connectAndRegister(registry)`**: the full plan §6 flow — authenticate →
  fetch models → validate/deduplicate → register — on top of the base
  `connect()`.

OmniHilbras is **optional**. The core depends only on `IProvider`; a guard test
fails the build if OmniHilbras leaks outside the provider layer, and the full
workflow runs with no OmniHilbras configured.

## Timeouts

Provider request timeouts come from `timeout_ms` (default 30s in the shared
client) and apply to discovery, chat and streaming; agents and pipelines have their own,
separate budgets (see the Phase 2 timeout model in ARCHITECTURE.md). A provider
timeout is reported as kind `TIMEOUT`, never as a generic failure.