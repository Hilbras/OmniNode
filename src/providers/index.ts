export { resolveApiKey, authHeaders } from "./auth.js";
export { requestJson } from "./http.js";
export type { HttpRequestOptions, HttpResponse } from "./http.js";
export { createProvider, OPENAI_COMPATIBLE_TYPES } from "./factory.js";
export type { CreateProviderOptions } from "./factory.js";
export {
  providerHttpError,
  providerTransportError,
  kindFromStatus,
  isRetryable,
  isTimeoutError,
  isNetworkError,
  extractMessage,
  parseRetryAfter,
} from "./errors.js";
export type { ProviderErrorKind } from "./errors.js";
export { OpenAICompatibleProvider } from "./openai-compatible/index.js";
export { OmniHilbrasProvider } from "./omnihilbras/index.js";
export type { OmniHilbrasConnectionResult } from "./omnihilbras/index.js";
