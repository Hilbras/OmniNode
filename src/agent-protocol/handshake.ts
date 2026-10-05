/**
 * OmniNode Agent Protocol v2 — handshake (roadmap §7.1).
 *
 * An agent announces itself with HELLO; OmniNode replies with HELLO_ACK.
 * Handshakes are optional for v1-style agents (no HELLO = legacy dialect).
 */
import { PROTOCOL_V2 } from "./version.js";
import { envelope, type ProtocolEnvelope } from "./types.js";

import type { AgentDescriptor } from "../types/agent-protocol.js";
export type { AgentDescriptor };

export type HelloResult =
  | { ok: true; descriptor: AgentDescriptor }
  | { ok: false; reason: string };

export function parseHello(envelopeValue: ProtocolEnvelope): HelloResult {
  if (envelopeValue.type !== "HELLO") {
    return { ok: false, reason: `expected HELLO, received ${envelopeValue.type}` };
  }
  const payload = envelopeValue.payload;
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "HELLO payload must be an object" };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.length === 0) {
    return { ok: false, reason: "HELLO payload is missing 'name'" };
  }
  return {
    ok: true,
    descriptor: {
      protocol: envelopeValue.protocol,
      name: p.name,
      ...(typeof p.version === "string" ? { version: p.version } : {}),
      capabilities: Array.isArray(p.capabilities) ? p.capabilities.filter((c): c is string => typeof c === "string") : [],
      supports: Array.isArray(p.supports) ? p.supports.filter((s): s is string => typeof s === "string") : [],
    },
  };
}

export function buildHello(descriptor: Omit<AgentDescriptor, "protocol">): ProtocolEnvelope<"HELLO"> {
  return envelope("HELLO", descriptor, { agentId: descriptor.name });
}

export function buildHelloAck(descriptor: AgentDescriptor): ProtocolEnvelope<"HELLO_ACK"> {
  return envelope("HELLO_ACK", {
    ok: true,
    protocol: PROTOCOL_V2,
    agent: descriptor.name,
    ...(descriptor.version !== undefined ? { agentVersion: descriptor.version } : {}),
    supportedProtocols: [PROTOCOL_V2],
  }, { agentId: descriptor.name });
}
