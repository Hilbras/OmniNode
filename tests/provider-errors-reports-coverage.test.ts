/**
 * Coverage tests for provider error normalization and the report
 * schema/service.
 *
 * These reach the paths the feature suites do not: the provider error
 * kinds that are only reachable through `providerHttpError` (rate limit,
 * model-not-found, timeout, server error, invalid request, unknown), the
 * transport-error classifications, `Retry-After` parsing of HTTP dates,
 * the report normalizers, and the report-service branches for empty task
 * output, oversized reports and reports without an id.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractMessage,
  isNetworkError,
  isRetryable,
  isTimeoutError,
  kindFromStatus,
  parseRetryAfter,
  providerHttpError,
  providerTransportError,
} from "../src/providers/errors.js";
import { normalizeEvidence, normalizeFinding, validateReport } from "../src/reports/schema.js";
import { MAX_REPORT_BYTES, ReportService } from "../src/reports/service.js";
import { FileReportStore, type ReportStore } from "../src/reports/store.js";
import { Logger, type LogSink } from "../src/logger/index.js";
import type { Report } from "../src/types/report.js";
import type { Task } from "../src/types/task.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function report(over: Partial<Report> = {}): Report {
  return {
    id: "rep-a",
    taskId: "t1",
    agent: "kimi",
    summary: "research done",
    findings: [],
    recommendations: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function task(id: string, result?: Task["result"], agent?: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    objective: "audit the service",
    ...(agent !== undefined ? { agent } : {}),
    status: "completed",
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    ...(result !== undefined ? { result } : {}),
  };
}

/** A logger that keeps every emitted line so warnings can be asserted. */
function capturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink: LogSink = {
    write(level, line) {
      lines.push(`${level}: ${line}`);
    },
  };
  return { log: new Logger({ level: "debug", sink }), lines };
}

/* ------------------------------------------------------------------ */
/* provider error normalization                                        */
/* ------------------------------------------------------------------ */

describe("provider error kind mapping (§10)", () => {
  it("maps every HTTP status to a stable kind", () => {
    expect(kindFromStatus(401)).toBe("AUTHENTICATION_ERROR");
    expect(kindFromStatus(403)).toBe("AUTHENTICATION_ERROR");
    expect(kindFromStatus(429)).toBe("RATE_LIMIT_ERROR");
    expect(kindFromStatus(404)).toBe("MODEL_NOT_FOUND");
    expect(kindFromStatus(408)).toBe("TIMEOUT");
    expect(kindFromStatus(504)).toBe("TIMEOUT");
    expect(kindFromStatus(500)).toBe("SERVER_ERROR");
    expect(kindFromStatus(503)).toBe("SERVER_ERROR");
    expect(kindFromStatus(400)).toBe("INVALID_REQUEST");
    expect(kindFromStatus(422)).toBe("INVALID_REQUEST");
    expect(kindFromStatus(302)).toBe("UNKNOWN_ERROR");
    expect(kindFromStatus(200)).toBe("UNKNOWN_ERROR");
  });

  it("marks only transient kinds as retryable", () => {
    expect(isRetryable("RATE_LIMIT_ERROR")).toBe(true);
    expect(isRetryable("SERVER_ERROR")).toBe(true);
    expect(isRetryable("NETWORK_ERROR")).toBe(true);
    expect(isRetryable("AUTHENTICATION_ERROR")).toBe(false);
    expect(isRetryable("INVALID_REQUEST")).toBe(false);
    expect(isRetryable("MODEL_NOT_FOUND")).toBe(false);
    expect(isRetryable("TIMEOUT")).toBe(false);
    expect(isRetryable("UNKNOWN_ERROR")).toBe(false);
  });
});

describe("provider error message extraction (§10)", () => {
  it("reads a message from the common provider body shapes", () => {
    expect(extractMessage({ error: { message: "nested" } })).toBe("nested");
    expect(extractMessage({ detail: "flat detail" })).toBe("flat detail");
    expect(extractMessage({ message: "top level" })).toBe("top level");
    expect(extractMessage({ error: { detail: "nested detail" } })).toBe("nested detail");
  });

  it("returns undefined for bodies that carry no string message", () => {
    expect(extractMessage(null)).toBeUndefined();
    expect(extractMessage(undefined)).toBeUndefined();
    expect(extractMessage("a plain string")).toBeUndefined();
    expect(extractMessage(42)).toBeUndefined();
    expect(extractMessage({})).toBeUndefined();
    expect(extractMessage({ error: { message: 123 } })).toBeUndefined();
    expect(extractMessage({ message: { nested: true } })).toBeUndefined();
  });
});

describe("Retry-After parsing (§10)", () => {
  it("parses a delay in seconds into milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1_500);
  });

  it("clamps a negative delay to zero", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("returns undefined for a missing or empty header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });

  it("parses an HTTP-date into milliseconds relative to now", () => {
    const now = Date.parse("2024-01-01T00:00:00.000Z");
    const later = new Date(now + 45_000).toUTCString();
    expect(parseRetryAfter(later, now)).toBe(45_000);
  });

  it("clamps a past HTTP-date to zero and rejects an unparsable one", () => {
    const now = Date.parse("2024-01-01T00:00:00.000Z");
    const past = new Date(now - 45_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });
});

describe("transport failure classification (§10)", () => {
  it("recognizes abort and timeout errors", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isTimeoutError(timeout)).toBe(true);

    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTimeoutError(abort)).toBe(true);

    const coded = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    expect(isTimeoutError(coded)).toBe(true);
  });

  it("does not treat ordinary errors as timeouts", () => {
    expect(isTimeoutError(new Error("boom"))).toBe(false);
    expect(isTimeoutError(new TypeError("fetch failed"))).toBe(false);
    expect(isTimeoutError("not an error")).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  it("recognizes transport failures", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    // An error carrying an object `cause` and no code is a transport failure.
    expect(isNetworkError(new Error("wrapped", { cause: { errno: -111 } }))).toBe(true);
  });

  it("does not treat application errors as transport failures", () => {
    expect(isNetworkError(new Error("boom"))).toBe(false);
    expect(isNetworkError({ code: "ENOENT" })).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
  });
});

describe("providerHttpError (§10)", () => {
  it("falls back to actionable text per kind", () => {
    const cases: Array<[number, RegExp]> = [
      [401, /Authentication with provider "gw" failed \(HTTP 401\)/],
      [429, /Provider "gw" rate-limited chat \(HTTP 429\)\. Retry later\./],
      [404, /Provider "gw" does not expose the requested model \(HTTP 404\)/],
      [408, /Provider "gw" timed out during chat \(HTTP 408\)/],
      [500, /Provider "gw" returned a server error during chat \(HTTP 500\)/],
      [400, /Provider "gw" rejected chat as invalid \(HTTP 400\)/],
      [302, /Provider "gw" failed during chat \(HTTP 302\)/],
    ];
    for (const [status, pattern] of cases) {
      const error = providerHttpError({ provider: "gw", operation: "chat", status });
      expect(error.message).toMatch(pattern);
    }
  });

  it("maps each kind onto the stable legacy error code", () => {
    expect(providerHttpError({ provider: "gw", operation: "chat", status: 401 }).code).toBe(
      "PROVIDER_AUTH_FAILED",
    );
    expect(providerHttpError({ provider: "gw", operation: "chat", status: 404 }).code).toBe(
      "MODEL_NOT_FOUND",
    );
    expect(providerHttpError({ provider: "gw", operation: "chat", status: 429 }).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(providerHttpError({ provider: "gw", operation: "chat", status: 500 }).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("prefers an explicit code over the derived one", () => {
    const error = providerHttpError({
      provider: "gw",
      operation: "chat",
      status: 401,
      code: "MODEL_NOT_FOUND",
    });
    expect(error.code).toBe("MODEL_NOT_FOUND");
  });

  it("defaults a missing status to 0 and reports UNKNOWN_ERROR", () => {
    const error = providerHttpError({ provider: "gw", operation: "chat" });
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.details).toMatchObject({ kind: "UNKNOWN_ERROR", status: 0 });
    expect(error.message).toBe('Provider "gw" failed during chat (HTTP 0).');
  });

  it("keeps the provider message and records it in the details", () => {
    const error = providerHttpError({
      provider: "gw",
      operation: "chat",
      status: 429,
      body: { error: { message: "slow down" } },
    });
    expect(error.message).toBe("slow down");
    expect(error.details).toMatchObject({
      kind: "RATE_LIMIT_ERROR",
      provider: "gw",
      operation: "chat",
      status: 429,
      retryable: true,
      providerMessage: "slow down",
    });
  });

  it("carries the optional dispatch, duration and retry-after facts", () => {
    const error = providerHttpError({
      provider: "gw",
      operation: "chat",
      status: 503,
      dispatched: true,
      durationMs: 1234,
      retryAfterMs: 5000,
    });
    expect(error.details).toMatchObject({
      kind: "SERVER_ERROR",
      retryable: true,
      dispatched: true,
      durationMs: 1234,
      retryAfterMs: 5000,
    });
  });

  it("omits the optional facts when they are not supplied", () => {
    const error = providerHttpError({ provider: "gw", operation: "chat", status: 400 });
    expect(error.details).not.toHaveProperty("dispatched");
    expect(error.details).not.toHaveProperty("durationMs");
    expect(error.details).not.toHaveProperty("retryAfterMs");
    expect(error.details).not.toHaveProperty("providerMessage");
  });

  it("preserves the cause", () => {
    const cause = new Error("socket hang up");
    const error = providerHttpError({
      provider: "gw",
      operation: "chat",
      status: 500,
      cause,
    });
    expect(error.cause).toBe(cause);
  });
});

describe("providerTransportError (§10)", () => {
  it("classifies a timeout as TIMEOUT and flags it as dispatched", () => {
    const cause = new Error("The operation was aborted");
    cause.name = "TimeoutError";
    const error = providerTransportError({ provider: "gw", operation: "chat", cause });
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.message).toBe("Provider request failed: The operation was aborted");
    expect(error.details).toMatchObject({
      kind: "TIMEOUT",
      provider: "gw",
      operation: "chat",
      retryable: false,
      dispatched: true,
    });
  });

  it("classifies a transport failure as NETWORK_ERROR", () => {
    const error = providerTransportError({
      provider: "gw",
      operation: "chat",
      cause: new TypeError("fetch failed"),
    });
    expect(error.details).toMatchObject({ kind: "NETWORK_ERROR", retryable: true });
    expect(error.details).not.toHaveProperty("dispatched");
  });

  it("classifies a parse failure and an http-response error as UNKNOWN_ERROR", () => {
    const parseError = providerTransportError({
      provider: "gw",
      operation: "chat",
      cause: new SyntaxError("Unexpected token < in JSON"),
    });
    expect(parseError.details).toMatchObject({ kind: "UNKNOWN_ERROR", retryable: false });

    const httpError = Object.assign(new Error("bad status"), { name: "HttpResponseError" });
    const normalized = providerTransportError({
      provider: "gw",
      operation: "chat",
      cause: httpError,
    });
    expect(normalized.details).toMatchObject({ kind: "UNKNOWN_ERROR", retryable: false });
  });

  it("stringifies a non-Error cause", () => {
    const error = providerTransportError({
      provider: "gw",
      operation: "chat",
      cause: "socket closed",
    });
    expect(error.message).toBe("Provider request failed: socket closed");
    expect(error.details).toMatchObject({ kind: "NETWORK_ERROR" });
  });

  it("carries the duration when it is known", () => {
    const error = providerTransportError({
      provider: "gw",
      operation: "chat",
      cause: new TypeError("fetch failed"),
      durationMs: 900,
    });
    expect(error.details).toMatchObject({ durationMs: 900 });
  });
});

/* ------------------------------------------------------------------ */
/* report schema                                                       */
/* ------------------------------------------------------------------ */

describe("report schema validation (§13)", () => {
  it("rejects a report whose root is not an object", () => {
    const result = validateReport("not a report");
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe("report failed schema validation (1 issue(s))");
    expect(result.issues[0]?.path).toBe("(root)");
  });

  it("keeps an explicit finding source instead of overwriting it", () => {
    const result = validateReport(
      report({
        id: "r-explicit",
        findings: [
          {
            id: "f1",
            title: "Leak",
            detail: "stack trace in response",
            source: { agent: "gemini", reportId: "other-report" },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.source).toEqual({ agent: "gemini", reportId: "other-report" });
  });

  it("prefers an explicit finding description over the detail", () => {
    const result = validateReport(
      report({
        findings: [
          {
            id: "f1",
            title: "Leak",
            detail: "short detail",
            description: "the long description",
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.description).toBe("the long description");
  });

  it("defaults a missing detail to an empty string", () => {
    const result = validateReport(
      report({
        findings: [{ id: "f1", title: "Leak" } as unknown as Report["findings"][number]],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.detail).toBe("");
    expect(result.report.findings[0]?.description).toBe("");
  });

  it("carries the pipeline run into the finding provenance", () => {
    const result = validateReport(
      report({
        id: "r-run-2",
        pipelineRunId: "run-8",
        findings: [{ id: "f1", title: "Leak", detail: "d" }],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.source).toEqual({
      agent: "kimi",
      reportId: "r-run-2",
      pipelineRunId: "run-8",
    });
  });

  it("turns a legacy string evidence entry into typed observation evidence", () => {
    const result = validateReport(
      report({
        findings: [
          {
            id: "f1",
            title: "Leak",
            detail: "stack trace in response",
            evidence: ["logs/app.log:12"],
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.report.findings[0]?.evidence).toEqual([
      { kind: "observation", excerpt: "logs/app.log:12" },
    ]);
  });
});

describe("report normalizers (§13)", () => {
  it("normalizeFinding mirrors detail into description and normalizes evidence", () => {
    const normalized = normalizeFinding({
      id: "f1",
      title: "Leak",
      detail: "stack trace in response",
      evidence: ["logs/app.log:12", { kind: "file", ref: "src/api.ts" }],
    });
    expect(normalized.description).toBe("stack trace in response");
    expect(normalized.evidence).toEqual([
      { kind: "observation", excerpt: "logs/app.log:12" },
      { kind: "file", ref: "src/api.ts" },
    ]);
  });

  it("normalizeFinding keeps an explicit description", () => {
    const normalized = normalizeFinding({
      id: "f1",
      title: "Leak",
      detail: "short detail",
      description: "the long description",
    });
    expect(normalized.description).toBe("the long description");
    expect(normalized.evidence).toBeUndefined();
  });

  it("normalizeEvidence converts strings, passes objects through and tolerates undefined", () => {
    expect(normalizeEvidence(["a", { kind: "file", ref: "x" }])).toEqual([
      { kind: "observation", excerpt: "a" },
      { kind: "file", ref: "x" },
    ]);
    expect(normalizeEvidence(undefined)).toBeUndefined();
    expect(normalizeEvidence([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* report service                                                      */
/* ------------------------------------------------------------------ */

describe("ReportService collection (§13, §17)", () => {
  it("skips a task whose result carries no output at all", async () => {
    const { log, lines } = capturingLogger();
    const service = new ReportService(new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc-"))), log);

    const collected = await service.collectFromTasks([
      task("t-empty", { summary: "   " }),
      task("t-none", { rawOutput: "", summary: "" }),
    ]);

    expect(collected).toEqual([]);
    expect(service.lastDiagnostics).toEqual({ collected: 0, accepted: 0, rejected: [] });
    expect(lines).toEqual([]);
  });

  it("skips a task that never produced a result", async () => {
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc0-"))),
    );

    const collected = await service.collectFromTasks([task("t-no-result")]);

    expect(collected).toEqual([]);
    expect(service.lastDiagnostics).toEqual({ collected: 0, accepted: 0, rejected: [] });
  });

  it("falls back to the task summary when there is no raw output", async () => {
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc2-"))),
    );
    const collected = await service.collectFromTasks([
      task("t-summary", { summary: "# Findings\n- Major: broken auth flow" }, "echo"),
    ]);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.id).toBe("t-summary-report");
    expect(collected[0]?.findings[0]?.title).toBe("Major: broken auth flow");
  });

  it("labels an extracted report with 'unknown' when the task has no agent", async () => {
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc3-"))),
    );
    const collected = await service.collectFromTasks([
      task("t-no-agent", { rawOutput: "# Findings\n- Major: broken auth flow" }),
    ]);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.agent).toBe("unknown");
  });

  it("rejects an oversized report and reports its size", async () => {
    const { log, lines } = capturingLogger();
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc4-"))),
      log,
    );
    const oversized = report({
      id: "rep-huge",
      summary: "x".repeat(MAX_REPORT_BYTES + 1024),
    });

    const collected = await service.collectFromTasks([task("t-huge", { reports: [oversized] })]);

    expect(collected).toEqual([]);
    expect(service.lastDiagnostics.collected).toBe(1);
    expect(service.lastDiagnostics.accepted).toBe(0);
    expect(service.lastDiagnostics.rejected).toHaveLength(1);
    expect(service.lastDiagnostics.rejected[0]?.key).toBe("rep-huge");
    expect(service.lastDiagnostics.rejected[0]?.reason).toMatch(
      new RegExp(`report exceeds the ${MAX_REPORT_BYTES} byte limit \\(\\d+ bytes\\)`),
    );
    expect(lines.some((line) => line.includes("Rejected oversized report"))).toBe(true);
  });

  it("keys an oversized report without an id as '(unknown)'", async () => {
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc5-"))),
    );
    const oversized = report({ summary: "x".repeat(MAX_REPORT_BYTES + 1024) });
    delete (oversized as { id?: string }).id;

    const collected = await service.collectFromTasks([task("t-huge2", { reports: [oversized] })]);

    expect(collected).toEqual([]);
    expect(service.lastDiagnostics.rejected[0]?.key).toBe("(unknown)");
  });

  it("keys a malformed report without an id as '(unknown)' and lists its issues", async () => {
    const service = new ReportService(
      new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc6-"))),
    );
    const malformed = report({ id: "" });
    delete (malformed as { id?: string }).id;

    const collected = await service.collectFromTasks([task("t-bad", { reports: [malformed] })]);

    expect(collected).toEqual([]);
    expect(service.lastDiagnostics.rejected[0]?.key).toBe("(unknown)");
    expect(service.lastDiagnostics.rejected[0]?.reason).toContain("failed schema validation");
    expect(service.lastDiagnostics.rejected[0]?.issues.length).toBeGreaterThan(0);
  });
});

describe("ReportService persistence and combination (§16–§17)", () => {
  it("does not touch the store when there is nothing to save", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-svc7-"));
    const store = new FileReportStore(dir);
    const service = new ReportService(store);
    await service.saveReports([]);
    expect(await store.listReports()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores reports and logs the count", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-svc8-"));
    const { log, lines } = capturingLogger();
    const store = new FileReportStore(dir);
    const service = new ReportService(store, log);

    await service.saveReports([report({ id: "rep-a" }), report({ id: "rep-b" })]);

    expect((await store.listReports()).map((r) => r.id)).toEqual(["rep-a", "rep-b"]);
    expect(lines.some((line) => line.includes("Stored 2 report(s)."))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the store it was constructed with", () => {
    const store = new FileReportStore(mkdtempSync(path.join(tmpdir(), "omninode-svc9-")));
    const service = new ReportService(store);
    expect(service.storeRef).toBe(store);
  });

  it("combines reports with the supplied objective, run and task ids", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-svc10-"));
    const { log, lines } = capturingLogger();
    const store = new FileReportStore(dir);
    const service = new ReportService(store, log);

    const combined = await service.generateCombined([report({ id: "rep-a" })], {
      objective: "audit auth",
      pipelineRunId: "run-1",
      taskIds: ["t1"],
    });

    expect(combined).toBeDefined();
    expect(combined?.objective).toBe("audit auth");
    expect(combined?.pipelineRunId).toBe("run-1");
    expect(combined?.taskIds).toEqual(["t1"]);
    expect((await store.getCombined(combined!.id))?.id).toBe(combined!.id);
    expect(lines.some((line) => line.includes(`Generated combined report ${combined!.id}`))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("combines reports without any metadata", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-svc11-"));
    const store = new FileReportStore(dir);
    const service = new ReportService(store);

    const combined = await service.generateCombined([report({ id: "rep-a" })]);

    expect(combined).toBeDefined();
    expect(combined?.objective).toBeUndefined();
    expect(combined?.pipelineRunId).toBeUndefined();
    expect(combined?.taskIds).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when there is nothing to combine", async () => {
    const store: ReportStore = new FileReportStore(
      mkdtempSync(path.join(tmpdir(), "omninode-svc12-")),
    );
    const service = new ReportService(store);
    expect(await service.generateCombined([])).toBeUndefined();
  });
});
