/**
 * OmniHilbras provider adapter (§6, Phase 2).
 *
 * OmniHilbras is one provider source among many — always optional (§2: the
 * core runs with zero Hilbras dependencies). The gateway exposes an
 * OpenAI-compatible API surface, so this adapter rides the OpenAI-compatible
 * transport and implements the plan's connect flow on top of it:
 *
 *   Connect → Authenticate → Fetch Models → Validate Models → Register
 */
import { resolveApiKey } from "../auth.js";
import { OpenAICompatibleProvider } from "../openai-compatible/index.js";
import type { ModelRegistry } from "../../registry/index.js";
import type { ModelInfo } from "../../types/model.js";
import type { ProviderStatus } from "../../types/provider.js";

export interface OmniHilbrasConnectionResult {
  status: ProviderStatus;
  /** Validated, deduplicated models — registered when a registry was given. */
  models: ModelInfo[];
  /** Model ids that appeared more than once in the gateway's list. */
  duplicates: string[];
  /** Number of models written into the registry (0 when no registry given). */
  registered: number;
}

export class OmniHilbrasProvider extends OpenAICompatibleProvider {
  /**
   * Run the full connect flow. Throws on authentication or transport failure
   * (use healthCheck() for a non-throwing probe).
   */
  async connect(registry?: ModelRegistry): Promise<OmniHilbrasConnectionResult> {
    // Authenticate — throws PROVIDER_AUTH_FAILED when the referenced env var is unset.
    const apiKey = resolveApiKey(this.config);

    // Fetch models — throws on transport errors and non-2xx responses.
    const discovered = await this.listModels();

    // Validate — deduplicate ids, annotate gateway metadata, force availability.
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    const duplicates: string[] = [];
    for (const model of discovered) {
      if (seen.has(model.id)) {
        duplicates.push(model.id);
        continue;
      }
      seen.add(model.id);
      models.push({
        ...model,
        provider: this.config.name,
        status: "available",
        metadata: { ...model.metadata, gateway: "omnihilbras" },
      });
    }

    // Register.
    if (registry) {
      for (const model of models) registry.register(model);
    }

    const message =
      `Authenticated${apiKey ? " with API key" : " (no API key configured)"}; ` +
      `validated ${models.length} unique model(s)` +
      (duplicates.length > 0 ? `, skipped ${duplicates.length} duplicate(s)` : "") +
      ".";

    const status: ProviderStatus = {
      name: this.config.name,
      type: this.config.type,
      baseUrl: this.config.baseUrl,
      health: "healthy",
      connected: true,
      modelCount: models.length,
      lastCheckedAt: new Date().toISOString(),
      message,
    };

    return { status, models, duplicates, registered: registry ? models.length : 0 };
  }
}
