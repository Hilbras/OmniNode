/** Memory provider factory: memory is optional; local is the default. */
import { ConfigError } from "../errors/index.js";
import type { AppConfig } from "../config/index.js";
import type { IMemoryProvider } from "../types/memory.js";
import { LocalMemoryProvider } from "./local.js";
import { RememberaMemoryProvider } from "./remembera.js";

export type MemoryProviderConfig = NonNullable<AppConfig["project"]["memory"]>;

export function createMemoryProvider(config?: MemoryProviderConfig): IMemoryProvider {
  if (!config || config.provider === "local") {
    return new LocalMemoryProvider();
  }
  if (config.provider === "remembera") {
    if (!config.baseUrl) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Memory provider "remembera" needs a base_url in omninode.yaml.`,
      );
    }
    return new RememberaMemoryProvider({
      baseUrl: config.baseUrl,
      apiKeyEnvVar: config.apiKeyEnvVar,
    });
  }
  throw new ConfigError(
    "CONFIG_INVALID",
    `Unknown memory provider "${config.provider}". Available: local, remembera.`,
  );
}
