/**
 * OmniNode Agent Protocol v2 — public entry point.
 *
 * External agents integrate through this module only; no OmniNode internals
 * are required (roadmap §7 exit criteria). Spec: docs/PROTOCOL.md.
 */
export {
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  MAX_MESSAGE_BYTES,
  isSupportedProtocol,
} from "./version.js";
export {
  envelope,
  newMessageId,
} from "./types.js";
export type {
  ProtocolEnvelope,
  ProtocolMessageType,
  ProtocolNodeToAgentType,
  ProtocolAgentToNodeType,
  ArtifactKind,
  ArtifactPayload,
  QuestionPayload,
  TaskPayload,
  ReportPayload,
  AskedQuestion,
} from "./types.js";
export {
  decodeMessage,
  encodeMessage,
  validateEnvelope,
  ProtocolDecoder,
} from "./codec.js";
export type { DecodeResult, ProtocolViolation, ProtocolViolationCode } from "./codec.js";
export {
  parseHello,
  buildHello,
  buildHelloAck,
} from "./handshake.js";
export type { AgentDescriptor, HelloResult } from "./handshake.js";
export {
  ProtocolSession,
  decodeStream,
  requireCompletion,
} from "./session.js";
export type { SessionIds, QuestionResponder } from "./session.js";