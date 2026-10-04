/**
 * Provider factory: builds adapter instances from configuration (§5, §7).
 * Custom and local gateways ride the OpenAI-compatible adapter unless a
 * dedicated one exists.
 */
import { OmniNodeError } from "../errors/index.js";
import type { IChatProvider, ProviderConfig, ProviderType } from "../types/provider.js";
import { OmniHilbrasProvider } from "./omnihilbras/index.js";
import { OpenAICompatibleProvider } from "./openai-compatible/index.js";

/** Provider types served by the OpenAI-compatible adapter. */
export const OPENAI_COMPATIBLE_TYPES: readonly ProviderType[] = [
  "openai-compatible",
  "openrouter",
  "local",
  "custom",
];

export function createProvider(config: ProviderConfig): IChatProvider {
  if (config.type === "omnihilbras") {
    return new OmniHilbrasProvider(config);
  }
  if (OPENAI_COMPATIBLE_TYPES.includes(config.type)) {
    return new OpenAICompatibleProvider(config);
  }
  throw new OmniNodeError("NOT_IMPLEMENTED", `Provider type "${config.type}" has no adapter yet.`);
}
