/**
 * OmniNode Agent Protocol v2 — session (roadmap §7.6).
 *
 * A session drives a protocol-mode agent: it emits v2 envelopes with
 * correlation ids, tolerates legacy (unversioned) replies, answers agent
 * questions through a responder callback, and collects reports, artifacts
 * and the completion — never throwing on malformed input.
 */
import { decodeMessage, encodeMessage, ProtocolDecoder, type DecodeResult, type ProtocolViolation } from "./codec.js";
import { PROTOCOL_V2 } from "./version.js";
import { envelope, type AskedQuestion, type ProtocolEnvelope } from "./types.js";
import { parseHello, buildHelloAck, type AgentDescriptor } from "./handshake.js";
import { ProtocolError } from "../errors/index.js";

export interface SessionIds {
  requestId: string;
  taskId: string;
  agentId: string;
  pipelineId?: string;
  executionId?: string;
}

export interface QuestionResponder {
  (question: { questionId: string; question: string; expected?: string }): Promise<string> | string;
}

export class ProtocolSession {
  readonly decoder: ProtocolDecoder;
  private readonly ids: SessionIds;
  private readonly responder: QuestionResponder | undefined;
  readonly violations: ProtocolViolation[] = [];
  readonly questions: AskedQuestion[] = [];
  readonly artifacts: ProtocolEnvelope["payload"][] = [];
  reports: ProtocolEnvelope["payload"][] = [];
  descriptor?: AgentDescriptor;
  completionSummary?: string;
  errorMessage?: string;

  constructor(ids: SessionIds, options: { responder?: QuestionResponder; maxBytes?: number } = {}) {
    this.ids = ids;
    this.responder = options.responder;
    this.decoder = new ProtocolDecoder(options.maxBytes);
  }

  /** The v2 messages OmniNode sends to open a task (written to the agent's stdin). */
  taskMessages(objective: string, role?: unknown, context?: string, instruction?: string): string[] {
    const ids = this.ids;
    const messages: ProtocolEnvelope[] = [envelope("TASK", { taskId: ids.taskId, objective }, ids)];
    if (role !== undefined) messages.push(envelope("CONTEXT", { role }, ids));
    if (context !== undefined && context.length > 0) messages.push(envelope("CONTEXT", { body: context }, ids));
    if (instruction !== undefined && instruction.length > 0) messages.push(envelope("INSTRUCTION", { text: instruction }, ids));
    return messages.map((m) => encodeMessage(m));
  }

  helloAck(descriptor: AgentDescriptor): string {
    return encodeMessage(buildHelloAck(descriptor));
  }

  /** Consumes decoded stdout, answering questions as they arrive. */
  async handle(decoded: DecodeResult): Promise<void> {
    if (!decoded.ok) {
      // Agent misbehavior is recorded, never fatal (§7.5).
      this.violations.push(decoded.error);
      return;
    }
    const message = decoded.envelope;
    if (message.protocol === PROTOCOL_V2) this.sawV2 = true;
    if (message.type === "HELLO") {
      const hello = parseHello(message);
      if (hello.ok) this.descriptor = hello.descriptor;
      else this.violations.push({ code: "INVALID_PAYLOAD", message: `bad HELLO: ${hello.reason}` });
      return;
    }
    if (message.type === "QUESTION") {
      await this.answerQuestion(message);
      return;
    }
    if (message.type === "REPORT") {
      this.reports.push(message.payload);
      return;
    }
    if (message.type === "ARTIFACT") {
      this.artifacts.push(message.payload);
      return;
    }
    if (message.type === "COMPLETION") {
      const payload = message.payload as { summary?: unknown } | undefined;
      this.completionSummary = typeof payload?.summary === "string" ? payload.summary : "";
      return;
    }
    if (message.type === "ERROR") {
      const payload = message.payload as { message?: unknown; code?: unknown } | undefined;
      const detail = typeof payload?.message === "string" ? payload.message : "agent reported an error";
      const code = typeof payload?.code === "string" ? ` [${payload.code}]` : "";
      this.errorMessage = `Agent error${code}: ${detail}`;
      return;
    }
    if (message.type === "TASK_ACCEPTED" || message.type === "TASK_STARTED" || message.type === "STATUS") {
      // Lifecycle acknowledgements: observed, no action needed by the core.
      return;
    }
    this.violations.push({
      code: "UNKNOWN_TYPE",
      message: `unexpected message type ${message.type} from agent`,
    });
  }

  private async answerQuestion(message: ProtocolEnvelope): Promise<void> {
    const payload = (message.payload ?? {}) as { questionId?: unknown; question?: unknown; expected?: unknown };
    const questionId = typeof payload.questionId === "string" ? payload.questionId : message.messageId;
    const question = typeof payload.question === "string" ? payload.question : "";
    const expected = typeof payload.expected === "string" ? payload.expected : "text";

    let answer: string | undefined;
    if (this.responder) {
      try {
        answer = await this.responder({ questionId, question, expected });
      } catch (error) {
        this.violations.push({
          code: "INVALID_PAYLOAD",
          message: `question responder failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    this.questions.push({ questionId, question, ...(answer !== undefined ? { answer } : {}) });
    // Answer on stdout via the write callback supplied by the caller.
    this.pendingAnswers.push(
      encodeMessage(
        envelope("RESPONSE", { questionId, ...(answer !== undefined ? { body: answer } : {}) }, {
          ...this.ids,
          requestId: message.requestId ?? this.ids.requestId,
        }),
      ),
    );
  }

  readonly pendingAnswers: string[] = [];
  /** True once any inbound message carried the v2 protocol field. */
  sawV2 = false;
}

export async function decodeStream(session: ProtocolSession, chunk: string): Promise<string[]> {
  const decoded = session.decoder.push(chunk);
  for (const result of decoded) {
    await session.handle(result);
  }
  return session.pendingAnswers.splice(0);
}

export function requireCompletion(session: ProtocolSession): void {
  if (session.errorMessage !== undefined) {
    throw new ProtocolError(session.errorMessage);
  }
}

export { decodeMessage };