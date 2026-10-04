/**
 * Thin JSON HTTP layer over global fetch. HTTP error statuses are returned to
 * the caller, not thrown — provider methods interpret them; only transport
 * failures (network, timeout, unparseable body) throw.
 */
import { ProviderError } from "../errors/index.js";

export interface HttpRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function requestJson(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ProviderError("PROVIDER_UNAVAILABLE", `Request to ${url} failed: ${reason}.`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", `Response from ${url} was not valid JSON.`, {
      cause: error,
      details: { status: response.status },
    });
  }

  return { status: response.status, body: parsed };
}
