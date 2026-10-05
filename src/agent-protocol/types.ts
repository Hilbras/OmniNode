/**
 * OmniNode Agent Protocol v2 — message model (roadmap §7.2–§7.4, §7.7).
 *
 * Every message is a JSON line carrying a `ProtocolEnvelope`. All ids are
 * optional for inbound tolerance but OmniNode always emits them, so every
 * message is traceable to agent / task / pipeline / execution / request.
 */
import type { Report } from "../types/report.js";
import { PROTOCOL_V2 } from "./version.js";

/** Messages OmniNode sends to an agent. */
export type ProtocolNodeToAgentType =
  | "TASK"
  | "HELLO_ACK"
  | "CONTEXT"
  | "INSTRUCTION"
  | "RESPONSE"
  | "CANCEL";

/** Messages an agent sends to OmniNode. */
export type ProtocolAgentToNodeType =
  | "HELLO"
  | "TASK_REQUEST"
  | "TASK_ACCEPTED"
  | "TASK_STARTED"
  | "STATUS"
  | "QUESTION"
  | "REPORT"
  | "ARTIFACT"
  | "COMPLETION"
  | "ERROR"
  | "CANCELLED";

export type ProtocolMessageType = ProtocolNodeToAgentType | ProtocolAgentToNodeType;

export interface ProtocolEnvelope<T extends ProtocolMessageType = ProtocolMessageType> {
  /** `omninode-agent-protocol/2`. Inbound messages without it are treated as v1. */
  protocol: string;
  /** Unique id of this message. */
  messageId: string;
  /** Id of the request/thread this message belongs to. */
  requestId?: string;
  taskId?: string;
  agentId?: string;
  pipelineId?: string;
  /** Execution identity (roadmap §6.5) — ties the message to one attempt. */
  executionId?: string;
  timestamp: string;
  type: T;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

/** Standard artifact kinds (roadmap §7.7). */
export type ArtifactKind =
  | "file"
  | "patch"
  | "report"
  | "log"
  | "screenshot"
  | "document"
  | "data";

export interface ArtifactPayload {
  kind: ArtifactKind;
  /** Path, URL or logical name. */
  ref: string;
  description?: string;
  mediaType?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
}

export interface QuestionPayload {
  /** Question id to answer. */
  questionId: string;
  question: string;
  /** What kind of answer is expected (free text, file path, options…). */
  expected?: "text" | "path" | "choice";
  options?: string[];
}

export interface TaskPayload {
  taskId: string;
  objective: string;
}

export interface ReportPayload {
  report: Report | Report[];
}

/** A question an agent asked during a run, with the answer OmniNode gave (if any). */
import type { AskedQuestion } from "../types/agent-protocol.js";
export type { AskedQuestion };

export function newMessageId(prefix = "msg"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** Builds a v2 envelope with ids and timestamp filled in. */
export function envelope<T extends ProtocolMessageType>(
  type: T,
  payload: unknown,
  ids: {
    requestId?: string;
    taskId?: string;
    agentId?: string;
    pipelineId?: string;
    executionId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): ProtocolEnvelope<T> {
  return {
    protocol: PROTOCOL_V2,
    messageId: newMessageId(),
    ...(ids.requestId !== undefined ? { requestId: ids.requestId } : {}),
    ...(ids.taskId !== undefined ? { taskId: ids.taskId } : {}),
    ...(ids.agentId !== undefined ? { agentId: ids.agentId } : {}),
    ...(ids.pipelineId !== undefined ? { pipelineId: ids.pipelineId } : {}),
    ...(ids.executionId !== undefined ? { executionId: ids.executionId } : {}),
    timestamp: new Date().toISOString(),
    type,
    payload,
    ...(ids.metadata !== undefined ? { metadata: ids.metadata } : {}),
  };
}