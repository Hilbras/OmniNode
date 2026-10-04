/**
 * Provider factory: builds adapter instances from configuration (§5, §7).
 * Custom and local gateways ride the OpenAI-compatible adapter unless a
 * dedicated one exists.
 */
import { OmniNodeError } from "../errors/index.js";
import type { IChatProvider, ProviderConfig, ProviderType } from "../types/provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible/index.js";

/** Provider types served by the OpenAI-compatible adapter. */
export const OPENAI_COMPATIBLE_TYPES: readonly ProviderType[] = [
  "openai-compatible",
  "openrouter",
  "local",
  "custom",
];

export function createProvider(config: ProviderConfig): IChatProvider {
  if (OPENAI_COMPATIBLE_TYPES.includes(config.type)) {
    return new OpenAICompatibleProvider(config);
  }
  if (config.type === "omnihilbras") {
    throw new OmniNodeError(
      "NOT_IMPLEMENTED",
      `Provider type "omnihilbras" is planned for Phase 2 (OmniHilbras Integration). ` +
        `If your OmniHilbras endpoint is OpenAI-compatible, use type "openai-compatible" for now.`,
    );
  }
  throw new OmniNodeError("NOT_IMPLEMENTED", `Provider type "${config.type}" has no adapter yet.`);
}
