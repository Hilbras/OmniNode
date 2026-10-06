/**
 * v3 quick win D — protocol fuzz harness.
 *
 * The agent-protocol codec is an untrusted-input boundary: a misbehaving or
 * hostile agent's stdout must never crash the orchestrator. The invariant is
 * "decoding never throws" — every malformed input is returned as a typed
 * `ProtocolViolation`. This suite hammers `decodeMessage` /
 * `ProtocolDecoder` with adversarial and seeded-random inputs to keep that
 * invariant proven.
 */
import { describe, expect, it } from "vitest";
import {
  ProtocolDecoder,
  decodeMessage,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from "../src/agent-protocol/index.js";
import type { ProtocolEnvelope, DecodeResult } from "../src/agent-protocol/index.js";

/** The codec only ever emits these violation codes on the failure path. */
const VIOLATION_CODES = new Set([
  "INVALID_JSON",
  "NOT_AN_OBJECT",
  "UNKNOWN_TYPE",
  "MISSING_FIELD",
  "UNSUPPORTED_VERSION",
  "OVERSIZED",
  "INVALID_PAYLOAD",
]);

function assertWellFormed(result: DecodeResult, context: string): void {
  if (result.ok) {
    expect(result.envelope.type).toBeTruthy();
    expect(result.legacy).toBe(false);
  } else {
    expect(VIOLATION_CODES.has(result.error.code), `${context}: unknown violation code ${result.error.code}`).toBe(true);
    expect(typeof result.error.message).toBe("string");
  }
}

/** Deterministic PRNG so a failure is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rng: () => number, length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

const CONTROLLED: ProtocolEnvelope = {
  protocol: "omninode-agent-protocol/2",
  messageId: "m-1",
  type: "STATUS",
  payload: { state: "running" },
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("protocol fuzz: decodeMessage never throws", () => {
  it("survives a battery of adversarial fixed inputs", () => {
    const inputs: Array<[string, unknown]> = [
      ["empty", ""],
      ["whitespace-only", "   \t\n"],
      ["unterminated json", '{"type":"STATUS","payload":{'],
      ["invalid json", "not json at all"],
      ["bare string json", '"hello"'],
      ["number json", "123"],
      ["boolean json", "true"],
      ["null json", "null"],
      ["array json", '[1,2,3]'],
      ["unknown type", '{"protocol":"omninode-agent-protocol/2","type":"BOGUS"}'],
      ["unsupported version", '{"protocol":"omninode-agent-protocol/99","type":"STATUS"}'],
      ["non-object", "42"],
      ["missing payload on required type", '{"protocol":"omninode-agent-protocol/2","type":"COMPLETION"}'],
      ["timestamp wrong type", '{"protocol":"omninode-agent-protocol/2","type":"STATUS","timestamp":123}'],
      ["metadata wrong type", '{"protocol":"omninode-agent-protocol/2","type":"STATUS","metadata":"nope"}'],
      ["oversized", "x".repeat(MAX_MESSAGE_BYTES + 1)],
      ["oversized json object", JSON.stringify({ type: "STATUS", pad: "x".repeat(MAX_MESSAGE_BYTES) })],
      ["unicode + control chars", '{"protocol":"omninode-agent-protocol/2","type":"STATUS","\u0000\u0001\ud800"}'],
      ["deeply nested object", JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } })],
    ];
    for (const [name, value] of inputs) {
      // Must not throw; must be a well-formed result.
      const result = decodeMessage(String(value));
      assertWellFormed(result, name);
    }
    // The fully-formed envelope still decodes.
    expect(decodeMessage(JSON.stringify(CONTROLLED))).toEqual({
      ok: true,
      legacy: false,
      envelope: expect.objectContaining({ type: "STATUS" }),
    });
  });

  it("survives a seeded-random battery of ~500 garbage lines", () => {
    const rng = mulberry32(0x5eed);
    const alphabet = String.raw`{}[]"'\\,/:\u0000 \n\ttruefalnull0123456789.{"protocol":"type":"payload"`;
    for (let i = 0; i < 500; i += 1) {
      const line = randomString(rng, 1 + Math.floor(rng() * 400), alphabet);
      const result = decodeMessage(line);
      assertWellFormed(result, `random line #${i}`);
    }
  });

  it("truncated / rotated round-trips decode to a valid envelope, not a crash", () => {
    const full = JSON.stringify(CONTROLLED);
    for (let cut = 0; cut <= full.length; cut += 7) {
      const result = decodeMessage(full.slice(0, cut));
      assertWellFormed(result, `truncated round-trip ${cut}/${full.length}`);
    }
  });
});

describe("protocol fuzz: ProtocolDecoder stream never throws", () => {
  it("survives random chunked streams of garbage interleaved with real lines", () => {
    const rng = mulberry32(0xf00d);
    const alphabet = String.raw`{}[]"\n ,:\u0000truefalnull0123456789.`;
    const decoder = new ProtocolDecoder();
    const realLine = JSON.stringify(CONTROLLED);

    for (let round = 0; round < 400; round += 1) {
      // Random chunk: sometimes garbage, sometimes a slice of a real line,
      // sometimes a lone newline — all fed through push().
      const kind = rng();
      let chunk: string;
      if (kind < 0.4) chunk = randomString(rng, 1 + Math.floor(rng() * 200), alphabet);
      else if (kind < 0.7) chunk = realLine.slice(0, Math.floor(rng() * (realLine.length + 5)));
      else if (kind < 0.85) chunk = "\n";
      else chunk = "x".repeat(50);

      const results = decoder.push(chunk);
      for (const result of results) assertWellFormed(result, `stream push round ${round}`);
    }
    for (const result of decoder.flush()) assertWellFormed(result, "stream flush");
    // A well-formed line still arrives intact through the chaos.
    expect(decodeMessage(realLine).ok).toBe(true);
  });

  it("bounds an endless no-newline stream instead of growing memory / hanging", () => {
    const decoder = new ProtocolDecoder(MAX_MESSAGE_BYTES);
    // Feed one giant chunk with no newline, in pieces: the decoder must
    // emit a single OVERSIZED violation and reset, not buffer forever.
    const giant = "A".repeat(MAX_MESSAGE_BYTES * 3);
    const all: DecodeResult[] = [];
    for (let i = 0; i < giant.length; i += 1_000) {
      all.push(...decoder.push(giant.slice(i, i + 1_000)));
    }
    expect(all.some((r) => !r.ok && r.error.code === "OVERSIZED")).toBe(true);
    for (const r of all) assertWellFormed(r, "giant stream");
    // Internal buffer is bounded (no unbounded accumulation).
    expect(decoder.flush().filter((r) => r.ok && r.envelope.type === "STATUS").length).toBe(0);
  });

  it("encode/decode round-trips a valid envelope without corruption", () => {
    const line = encodeMessage(CONTROLLED);
    const result = decodeMessage(line);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toMatchObject({ type: "STATUS", messageId: "m-1" });
  });
});
