/**
 * v3 audit M4 — agent protocol codec correctness.
 *
 * Four defects, all in `src/agent-protocol/codec.ts`:
 *   1. the 1 MiB budget was counted in UTF-16 code units, not bytes;
 *   2. `ProtocolDecoder.push()` was O(n²) on a newline-free stream;
 *   3. the decoder did not resynchronise after an OVERSIZED violation, so the
 *      tail of the oversized line produced a second, bogus violation;
 *   4. the legacy (v1) branch discarded the agent's own timestamp.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  ProtocolDecoder,
  decodeMessage,
  encodeMessage,
} from "../src/agent-protocol/index.js";
import type { ProtocolEnvelope } from "../src/agent-protocol/types.js";

const envelope = (overrides: Partial<ProtocolEnvelope> = {}): ProtocolEnvelope => ({
  protocol: "omninode-agent-protocol/2",
  messageId: "m-1",
  timestamp: "2024-01-01T00:00:00.000Z",
  type: "STATUS",
  payload: { s: 1 },
  ...overrides,
});

describe("protocol codec: the message budget is measured in bytes", () => {
  it("rejects a multi-byte payload that exceeds the budget in bytes", () => {
    const limit = 1024;
    // Each CJK character is 3 UTF-8 bytes, so 400 characters = 1200 bytes
    // but only 400 UTF-16 code units — under the limit when counted as
    // characters, over it when counted as bytes.
    const line = JSON.stringify({
      protocol: "omninode-agent-protocol/2",
      messageId: "m-1",
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "STATUS",
      payload: { text: "字".repeat(400) },
    });
    expect(line.length).toBeLessThan(limit);
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(limit);

    const result = decodeMessage(line, limit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OVERSIZED");
      // The message reports BYTES, not characters.
      expect(result.error.message).toContain(`${Buffer.byteLength(line, "utf8")} bytes`);
    }
  });

  it("accepts a payload that is within the budget in bytes", () => {
    const line = JSON.stringify({
      protocol: "omninode-agent-protocol/2",
      messageId: "m-1",
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "STATUS",
      payload: { text: "字".repeat(100) },
    });
    expect(decodeMessage(line, 4096).ok).toBe(true);
  });

  it("measures the outbound message budget in bytes too", () => {
    const big = envelope({ payload: { text: "字".repeat(400) } });
    const line = JSON.stringify(big);
    expect(line.length).toBeLessThan(1024);
    expect(() => encodeMessage(big, 1024)).toThrow(/bytes exceeds/);
  });
});

describe("protocol codec: the streaming decoder stays linear", () => {
  it("handles a long newline-free stream in bounded time", () => {
    const decoder = new ProtocolDecoder(MAX_MESSAGE_BYTES);
    const giant = "A".repeat(MAX_MESSAGE_BYTES * 3);
    const started = Date.now();
    const results = [];
    for (let i = 0; i < giant.length; i += 1_000) {
      results.push(...decoder.push(giant.slice(i, i + 1_000)));
    }
    const elapsed = Date.now() - started;

    // The quadratic implementation needed >5 s for this input.
    expect(elapsed).toBeLessThan(2_000);
    expect(results.some((r) => !r.ok && r.error.code === "OVERSIZED")).toBe(true);
  });

  it("emits exactly one OVERSIZED violation for a giant line", () => {
    const decoder = new ProtocolDecoder(1_000);
    const results = decoder.push("A".repeat(5_000));
    const oversized = results.filter((r) => !r.ok && r.error.code === "OVERSIZED");
    expect(oversized).toHaveLength(1);
  });
});

describe("protocol codec: the decoder resynchronises after an oversized line", () => {
  it("does not re-parse the tail of the oversized line", () => {
    const decoder = new ProtocolDecoder(1_000);
    const first = decoder.push("A".repeat(2_000));
    expect(first.some((r) => !r.ok && r.error.code === "OVERSIZED")).toBe(true);

    // The tail of the same oversized line must not produce a second,
    // bogus INVALID_JSON violation.
    const tail = decoder.push("TAIL\n");
    expect(tail).toEqual([]);
  });

  it("resumes decoding at the next line after an oversized one", () => {
    const decoder = new ProtocolDecoder(1_000);
    decoder.push("A".repeat(2_000));
    const good = JSON.stringify(envelope());
    const results = decoder.push(`TAIL\n${good}\n`);

    const decoded = results.filter((r) => r.ok);
    expect(decoded).toHaveLength(1);
    if (decoded[0]?.ok) {
      expect(decoded[0].envelope.messageId).toBe("m-1");
    }
  });
});

describe("protocol codec: the legacy branch keeps the agent's timestamp", () => {
  it("preserves a v1 message's own timestamp", () => {
    const line = JSON.stringify({
      type: "STATUS",
      payload: { s: 1 },
      messageId: "m1",
      timestamp: "2020-01-01T00:00:00.000Z",
    });
    const result = decodeMessage(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legacy).toBe(true);
      expect(result.envelope.timestamp).toBe("2020-01-01T00:00:00.000Z");
    }
  });

  it("rejects a non-string timestamp in the legacy branch, as v2 does", () => {
    const result = decodeMessage(JSON.stringify({ type: "STATUS", payload: {}, timestamp: 123 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MISSING_FIELD");
    }
  });
});
