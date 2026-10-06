/**
 * Thin JSON HTTP layer over global fetch. HTTP error statuses are returned to
 * the caller, not thrown — provider methods interpret them; only transport
 * failures (network, timeout, unparseable body) throw.
 */
/** Raised for malformed provider responses so adapters can classify them. */
export class HttpResponseError extends Error {
  constructor(message: string, readonly status: number, cause?: unknown) {
    super(message, { cause });
    this.name = "HttpResponseError";
  }
}

export interface HttpRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  /** Wall-clock duration of the request (§23 Fix 04 — timeout detail model). */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function requestJson(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse & { durationMs: number }> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const startedAt = Date.now();

  // Transport failures propagate raw: adapters normalize them into provider
  // error kinds (roadmap §10).
  const response: Response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new HttpResponseError(`Response from ${url} was not valid JSON.`, response.status, error);
  }

  return { status: response.status, body: parsed, durationMs: Date.now() - startedAt };
}
