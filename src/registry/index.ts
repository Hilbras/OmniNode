/**
 * Normalized model registry (§8): aggregates models discovered from all
 * configured providers under "provider:model" keys.
 */
import type { ModelCapabilities, ModelInfo } from "../types/model.js";
import type { IProvider } from "../types/provider.js";

export interface ModelFilter {
  provider?: string;
  capability?: keyof ModelCapabilities;
}

export interface DiscoveryResult {
  provider: string;
  models: ModelInfo[];
  error?: Error;
}

export function registryKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();

  register(model: ModelInfo): void {
    this.models.set(registryKey(model.provider, model.id), model);
  }

  get(provider: string, id: string): ModelInfo | undefined {
    return this.models.get(registryKey(provider, id));
  }

  list(filter: ModelFilter = {}): ModelInfo[] {
    return [...this.models.values()]
      .filter((model) => (filter.provider ? model.provider === filter.provider : true))
      .filter((model) =>
        filter.capability ? model.capabilities?.[filter.capability] === true : true,
      )
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  }

  /** Availability validation (§27 Phase 1): present in the registry and not retired. */
  isAvailable(provider: string, id: string): boolean {
    const model = this.get(provider, id);
    return model !== undefined && (model.status ?? "available") === "available";
  }

  /** Discover models from one provider and register them. */
  async discoverFrom(provider: IProvider): Promise<ModelInfo[]> {
    const discovered = await provider.listModels();
    for (const model of discovered) this.register(model);
    return discovered;
  }

  /** Discover from many providers; a failing provider does not abort the rest. */
  async discoverAll(providers: IProvider[]): Promise<DiscoveryResult[]> {
    return Promise.all(
      providers.map(async (provider) => {
        try {
          return {
            provider: provider.config.name,
            models: await this.discoverFrom(provider),
          };
        } catch (error) {
          return {
            provider: provider.config.name,
            models: [],
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }),
    );
  }
}
