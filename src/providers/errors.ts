/**
 * Provider error normalization (roadmap §10).
 *
 * Every provider failure is mapped to one stable kind, so callers can react
 * (retry a rate limit, surface an auth problem, treat a missing model
 * differently) without string-matching provider-specific payloads.
 */
import { ProviderError } from "../errors/index.js";

export type ProviderErrorKind =
  | "AUTHENTICATION_ERROR"
  | "RATE_LIMIT_ERROR"
  | "INVALID_REQUEST"
  | "MODEL_NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "SERVER_ERROR"
  | "UNKNOWN_ERROR";

export interface ProviderErrorContext {
  provider: string;
  operation: string;
  status?: number;
  body?: unknown;
  retryAfterMs?: number;
  /** Whether the request was dispatched before the failure (§23 Fix 04). */
  dispatched?: boolean;
  durationMs?: number;
  cause?: unknown;
  /** Maps the normalized kind onto the legacy stable error code. */
  code?:
    | "PROVIDER_UNAVAILABLE"
    | "PROVIDER_AUTH_FAILED"
    | "MODEL_NOT_FOUND";
}

function kindToCode(kind: ProviderErrorKind): NonNullable<ProviderErrorContext["code"]> {
  switch (kind) {
    case "AUTHENTICATION_ERROR":
      return "PROVIDER_AUTH_FAILED";
    case "MODEL_NOT_FOUND":
      return "MODEL_NOT_FOUND";
    default:
      return "PROVIDER_UNAVAILABLE";
  }
}

/** Kinds worth retrying automatically (rate limits and transient server errors). */
export function isRetryable(kind: ProviderErrorKind): boolean {
  return kind === "RATE_LIMIT_ERROR" || kind === "SERVER_ERROR" || kind === "NETWORK_ERROR";
}

/** Maps an HTTP status (and optional body) to a normalized kind. */
export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "AUTHENTICATION_ERROR";
  if (status === 429) return "RATE_LIMIT_ERROR";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "SERVER_ERROR";
  if (status >= 400) return "INVALID_REQUEST";
  return "UNKNOWN_ERROR";
}

/** Extracts a human message from common provider error body shapes. */
export function extractMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const root = body as Record<string, unknown>;
  const error = (root.error ?? root) as Record<string, unknown>;
  const message = error.message ?? error.detail ?? root.message;
  return typeof message === "string" ? message : undefined;
}

/** Parses `Retry-After` (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** True for the abort/timeout errors raised by fetch's AbortSignal.timeout. */
export function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) ||
    (typeof (error as { code?: string })?.code === "string" &&
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

/** True for transport failures (DNS, refused, TLS, offline). */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (typeof (error as { cause?: unknown })?.cause === "object" && error instanceof Error && !(error as { code?: string }).code);
}

/**
 * Builds a normalized ProviderError from an HTTP failure.
 */
/** Actionable fallback text per kind (used when the provider sent no message). */
function fallbackMessage(kind: ProviderErrorKind, context: ProviderErrorContext, status: number): string {
  const { provider, operation } = context;
  switch (kind) {
    case "AUTHENTICATION_ERROR":
      return `Authentication with provider "${provider}" failed (HTTP ${status}). Check that the referenced API key is set and valid.`;
    case "RATE_LIMIT_ERROR":
      return `Provider "${provider}" rate-limited ${operation} (HTTP ${status}). Retry later.`;
    case "MODEL_NOT_FOUND":
      return `Provider "${provider}" does not expose the requested model (HTTP ${status}).`;
    case "TIMEOUT":
      return `Provider "${provider}" timed out during ${operation} (HTTP ${status}).`;
    case "SERVER_ERROR":
      return `Provider "${provider}" returned a server error during ${operation} (HTTP ${status}).`;
    case "INVALID_REQUEST":
      return `Provider "${provider}" rejected ${operation} as invalid (HTTP ${status}).`;
    default:
      return `Provider "${provider}" failed during ${operation} (HTTP ${status}).`;
  }
}

export function providerHttpError(context: ProviderErrorContext): ProviderError {
  const status = context.status ?? 0;
  const kind = kindFromStatus(status);
  const detail = extractMessage(context.body);
  const retryAfterMs = context.retryAfterMs ?? parseRetryAfter(undefined);
  return new ProviderError(
    context.code ?? kindToCode(kind),
    detail ?? fallbackMessage(kind, context, status),
    {
      cause: context.cause,
      details: {
        kind,
        provider: context.provider,
        operation: context.operation,
        status,
        retryable: isRetryable(kind),
        ...(context.durationMs !== undefined ? { durationMs: context.durationMs } : {}),
        ...(context.dispatched !== undefined ? { dispatched: context.dispatched } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(detail ? { providerMessage: detail } : {}),
      },
    },
  );
}

/** Wraps a thrown transport/abort error into a normalized ProviderError. */
export function providerTransportError(context: Omit<ProviderErrorContext, "status" | "body">): ProviderError {
  const cause = context.cause;
  const kind: ProviderErrorKind = isTimeoutError(cause)
    ? "TIMEOUT"
    : cause instanceof SyntaxError || (cause as { name?: string })?.name === "HttpResponseError"
      ? "UNKNOWN_ERROR"
      : "NETWORK_ERROR";
  const message = context.cause instanceof Error ? context.cause.message : String(context.cause);
  return new ProviderError("PROVIDER_UNAVAILABLE", `Provider request failed: ${message}`, {
    cause: context.cause,
    details: {
      kind,
      provider: context.provider,
      operation: context.operation,
      retryable: kind === "NETWORK_ERROR",
      // A timeout may have hit after dispatch — mark it so callers know the
      // outcome is unprovable (§23 Fix 04).
      ...(kind === "TIMEOUT" ? { dispatched: true } : {}),
      ...(context.durationMs !== undefined ? { durationMs: context.durationMs } : {}),
    },
  });
}