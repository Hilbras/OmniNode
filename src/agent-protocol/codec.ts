/**
 * OmniNode Agent Protocol v2 — codec and validation (roadmap §7.5).
 *
 * Decoding NEVER throws: every failure is returned as a typed
 * `ProtocolViolation` with a machine-readable code, so a misbehaving agent
 * can never crash OmniNode.
 */
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_V2,
  isSupportedProtocol,
} from "./version.js";
import type { ProtocolEnvelope, ProtocolMessageType } from "./types.js";

export type ProtocolViolationCode =
  | "INVALID_JSON"
  | "NOT_AN_OBJECT"
  | "UNKNOWN_TYPE"
  | "MISSING_FIELD"
  | "UNSUPPORTED_VERSION"
  | "OVERSIZED"
  | "INVALID_PAYLOAD";

export interface ProtocolViolation {
  code: ProtocolViolationCode;
  message: string;
  /** Raw line (truncated) for diagnostics. */
  sample?: string;
}

export type DecodeResult =
  | { ok: true; envelope: ProtocolEnvelope; legacy: boolean }
  | { ok: false; error: ProtocolViolation };

const KNOWN_TYPES = new Set<string>([
  // node → agent
  "TASK", "HELLO_ACK", "CONTEXT", "INSTRUCTION", "RESPONSE", "CANCEL",
  // agent → node
  "HELLO", "TASK_REQUEST", "TASK_ACCEPTED", "TASK_STARTED", "STATUS",
  "QUESTION", "REPORT", "ARTIFACT", "COMPLETION", "ERROR", "CANCELLED",
]);

const PAYLOAD_REQUIRED_TYPES = new Set<string>(["TASK", "REPORT", "COMPLETION", "ERROR", "QUESTION", "ARTIFACT", "HELLO"]);

/** Validates one decoded JSON value as a protocol envelope. */
export function validateEnvelope(value: unknown, line?: string): DecodeResult {
  const sample = line?.slice(0, 200);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: { code: "NOT_AN_OBJECT", message: "message must be a JSON object", ...(sample ? { sample } : {}) } };
  }
  const raw = value as Record<string, unknown>;

  // Version negotiation: absent protocol = v1 (OmniNode 1.x agents), else must be supported.
  const protocol = raw.protocol;
  if (protocol === undefined) {
    // legacy v1: requires a bare {type, payload} shape
    const type = raw.type;
    if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
      return { ok: false, error: { code: "UNKNOWN_TYPE", message: `unknown message type ${String(type)}`, ...(sample ? { sample } : {}) } };
    }
    return {
      ok: true,
      legacy: true,
      envelope: {
        protocol: "omninode-agent-protocol/1",
        messageId: typeof raw.messageId === "string" ? raw.messageId : "legacy",
        timestamp: new Date().toISOString(),
        type: type as ProtocolMessageType,
        payload: raw.payload,
      },
    };
  }
  if (typeof protocol !== "string" || !isSupportedProtocol(protocol)) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_VERSION", message: `unsupported protocol "${String(protocol)}"`, ...(sample ? { sample } : {}) },
    };
  }

  if (raw.type === undefined) {
    return { ok: false, error: { code: "MISSING_FIELD", message: "message is missing 'type'", ...(sample ? { sample } : {}) } };
  }
  if (typeof raw.type !== "string" || !KNOWN_TYPES.has(raw.type)) {
    return { ok: false, error: { code: "UNKNOWN_TYPE", message: `unknown message type ${String(raw.type)}`, ...(sample ? { sample } : {}) } };
  }
  if (raw.timestamp !== undefined && typeof raw.timestamp !== "string") {
    return { ok: false, error: { code: "MISSING_FIELD", message: "'timestamp' must be a string", ...(sample ? { sample } : {}) } };
  }
  if (PAYLOAD_REQUIRED_TYPES.has(raw.type) && (raw.payload === undefined || raw.payload === null)) {
    return { ok: false, error: { code: "INVALID_PAYLOAD", message: `${raw.type} requires a payload`, ...(sample ? { sample } : {}) } };
  }

  return {
    ok: true,
    legacy: protocol !== PROTOCOL_V2,
    envelope: {
      protocol,
      messageId: typeof raw.messageId === "string" ? raw.messageId : "unknown",
      ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
      ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
      ...(typeof raw.agentId === "string" ? { agentId: raw.agentId } : {}),
      ...(typeof raw.pipelineId === "string" ? { pipelineId: raw.pipelineId } : {}),
      ...(typeof raw.executionId === "string" ? { executionId: raw.executionId } : {}),
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
      type: raw.type as ProtocolMessageType,
      payload: raw.payload,
      ...(raw.metadata !== null && typeof raw.metadata === "object" ? { metadata: raw.metadata as Record<string, unknown> } : {}),
    },
  };
}

/** Decodes one protocol line (no trailing newline). */
export function decodeMessage(line: string, maxBytes = MAX_MESSAGE_BYTES): DecodeResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "INVALID_JSON", message: "empty line" } };
  }
  if (trimmed.length > maxBytes) {
    return {
      ok: false,
      error: { code: "OVERSIZED", message: `message of ${trimmed.length} bytes exceeds the ${maxBytes} byte limit`, sample: trimmed.slice(0, 200) },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: { code: "INVALID_JSON", message: error instanceof Error ? error.message : "invalid JSON", sample: trimmed.slice(0, 200) },
    };
  }
  return validateEnvelope(value, trimmed);
}

/** Serializes an envelope to a single JSON line. */
export function encodeMessage(envelope: ProtocolEnvelope, maxBytes = MAX_MESSAGE_BYTES): string {
  const line = JSON.stringify(envelope);
  if (line.length > maxBytes) {
    throw new Error(`outbound protocol message of ${line.length} bytes exceeds the ${maxBytes} byte limit`);
  }
  return line;
}

/**
 * Streaming line decoder for agent stdout. Feed chunks; receive decoded
 * envelopes and violations in order. Survives garbage: a bad line yields a
 * violation and the stream continues.
 */
export class ProtocolDecoder {
  private buffer = "";
  private readonly maxBytes: number;

  constructor(maxBytes = MAX_MESSAGE_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(chunk: string): DecodeResult[] {
    this.buffer += chunk;
    const results: DecodeResult[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) results.push(decodeMessage(line, this.maxBytes));
      index = this.buffer.indexOf("\n");
    }
    // Guard against an agent emitting an endless line with no newline.
    if (this.buffer.length > this.maxBytes) {
      results.push({
        ok: false,
        error: { code: "OVERSIZED", message: `line exceeded ${this.maxBytes} bytes without a newline`, sample: this.buffer.slice(0, 200) },
      });
      this.buffer = "";
    }
    return results;
  }

  /** Flush any trailing line when the process exits. */
  flush(): DecodeResult[] {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return [];
    }
    const result = decodeMessage(this.buffer, this.maxBytes);
    this.buffer = "";
    return [result];
  }
}