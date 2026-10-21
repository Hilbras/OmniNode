/**
 * Agent Protocol v2 — handshake and session branch coverage (roadmap §7.1, §7.6).
 *
 * The protocol is a contract with third-party agents, so every branch matters:
 * a malformed HELLO, a question nobody can answer, an agent that reports an
 * error, an unknown message type, or a legacy (v1) agent that never sends a
 * protocol field. This file pins the observable behaviour of each of those
 * paths — the recorded violation, the collected payload, the queued answer.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V2,
  ProtocolSession,
  buildHello,
  buildHelloAck,
  decodeMessage,
  decodeStream,
  envelope,
  parseHello,
  requireCompletion,
} from "../src/agent-protocol/index.js";
import type { DecodeResult, ProtocolEnvelope } from "../src/agent-protocol/index.js";
import { ProtocolError } from "../src/errors/index.js";

const SESSION_IDS = { requestId: "r-1", taskId: "t-1", agentId: "a-1" };

/** Encodes a v2 agent message as one protocol line. */
function line(type: string, payload: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: PROTOCOL_V2,
    type,
    messageId: "m-1",
    timestamp: "2024-01-01T00:00:00.000Z",
    payload,
    ...overrides,
  });
}

/** Decodes a v2 agent message into the result shape `handle()` consumes. */
function decoded(type: string, payload: unknown, overrides: Record<string, unknown> = {}): DecodeResult {
  return decodeMessage(line(type, payload, overrides));
}

/**
 * Builds a decode result for a hand-crafted envelope, bypassing the codec's
 * validation — the only way to reach branches the codec would reject
 * (an unknown type, a missing payload).
 */
function raw(overrides: Record<string, unknown>): DecodeResult {
  return {
    ok: true,
    legacy: false,
    envelope: {
      protocol: PROTOCOL_V2,
      messageId: "m-raw",
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "STATUS",
      payload: undefined,
      ...overrides,
    } as unknown as ProtocolEnvelope,
  };
}

describe("handshake: parseHello rejects what it cannot trust", () => {
  it("rejects a message that is not a HELLO", () => {
    const result = parseHello(envelope("REPORT", { summary: "x" }));
    expect(result).toEqual({ ok: false, reason: "expected HELLO, received REPORT" });
  });

  it("rejects a HELLO whose payload is null", () => {
    expect(parseHello(envelope("HELLO", null))).toEqual({
      ok: false,
      reason: "HELLO payload must be an object",
    });
  });

  it("rejects a HELLO whose payload is a primitive", () => {
    expect(parseHello(envelope("HELLO", "agent-x"))).toEqual({
      ok: false,
      reason: "HELLO payload must be an object",
    });
  });

  it("rejects a HELLO payload without a usable name", () => {
    const expected = { ok: false, reason: "HELLO payload is missing 'name'" };
    expect(parseHello(envelope("HELLO", {}))).toEqual(expected);
    expect(parseHello(envelope("HELLO", { name: "" }))).toEqual(expected);
    expect(parseHello(envelope("HELLO", { name: 42 }))).toEqual(expected);
  });
});

describe("handshake: parseHello normalises a valid descriptor", () => {
  it("keeps the version and filters non-string capability and support entries", () => {
    const result = parseHello(
      envelope("HELLO", {
        name: "agent-x",
        version: "1.2.3",
        capabilities: ["code", 42, null, "review"],
        supports: ["REPORT", 7, "COMPLETION"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a valid HELLO");
    expect(result.descriptor).toEqual({
      protocol: PROTOCOL_V2,
      name: "agent-x",
      version: "1.2.3",
      capabilities: ["code", "review"],
      supports: ["REPORT", "COMPLETION"],
    });
  });

  it("omits the version and defaults the capability lists when they are absent", () => {
    const result = parseHello(envelope("HELLO", { name: "minimal" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a valid HELLO");
    expect(result.descriptor).toEqual({
      protocol: PROTOCOL_V2,
      name: "minimal",
      capabilities: [],
      supports: [],
    });
    expect("version" in result.descriptor).toBe(false);
  });

  it("defaults the capability lists when they are not arrays", () => {
    const result = parseHello(
      envelope("HELLO", { name: "malformed", version: 7, capabilities: "code", supports: { a: 1 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a valid HELLO");
    expect(result.descriptor.version).toBeUndefined();
    expect(result.descriptor.capabilities).toEqual([]);
    expect(result.descriptor.supports).toEqual([]);
  });
});

describe("handshake: building the HELLO and HELLO_ACK envelopes", () => {
  it("builds a HELLO carrying the descriptor and the agent id", () => {
    const hello = buildHello({
      name: "agent-x",
      version: "1.0.0",
      capabilities: ["code"],
      supports: ["REPORT"],
    });
    expect(hello.type).toBe("HELLO");
    expect(hello.protocol).toBe(PROTOCOL_V2);
    expect(hello.agentId).toBe("agent-x");
    expect(hello.messageId).toMatch(/^msg-/);
    expect(hello.payload).toEqual({
      name: "agent-x",
      version: "1.0.0",
      capabilities: ["code"],
      supports: ["REPORT"],
    });
  });

  it("round-trips a built HELLO through parseHello", () => {
    const parsed = parseHello(buildHello({ name: "rt", version: "2", capabilities: [], supports: [] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected a valid HELLO");
    expect(parsed.descriptor).toMatchObject({ name: "rt", version: "2" });
  });

  it("acknowledges a HELLO with the agent version when the agent reported one", () => {
    const ack = buildHelloAck({
      protocol: PROTOCOL_V2,
      name: "agent-x",
      version: "3.1.4",
      capabilities: [],
      supports: [],
    });
    expect(ack.type).toBe("HELLO_ACK");
    expect(ack.protocol).toBe(PROTOCOL_V2);
    expect(ack.agentId).toBe("agent-x");
    expect(ack.payload).toEqual({
      ok: true,
      protocol: PROTOCOL_V2,
      agent: "agent-x",
      agentVersion: "3.1.4",
      supportedProtocols: [PROTOCOL_V2],
    });
  });

  it("acknowledges a HELLO without a version when the agent reported none", () => {
    const ack = buildHelloAck({
      protocol: PROTOCOL_V2,
      name: "agent-y",
      capabilities: [],
      supports: [],
    });
    expect(ack.payload).toEqual({
      ok: true,
      protocol: PROTOCOL_V2,
      agent: "agent-y",
      supportedProtocols: [PROTOCOL_V2],
    });
  });
});

describe("session: taskMessages builds the opening envelopes", () => {
  it("emits a single TASK envelope when nothing else is supplied", () => {
    const session = new ProtocolSession(SESSION_IDS);
    const lines = session.taskMessages("do the thing");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      protocol: PROTOCOL_V2,
      type: "TASK",
      requestId: "r-1",
      taskId: "t-1",
      agentId: "a-1",
      payload: { taskId: "t-1", objective: "do the thing" },
    });
  });

  it("emits a role CONTEXT envelope when a role is supplied", () => {
    const session = new ProtocolSession(SESSION_IDS);
    const lines = session.taskMessages("objective", "reviewer");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["TASK", "CONTEXT"]);
    expect(JSON.parse(lines[1] ?? "{}").payload).toEqual({ role: "reviewer" });
  });

  it("emits role, body and instruction envelopes when everything is supplied", () => {
    const session = new ProtocolSession({ ...SESSION_IDS, pipelineId: "p-1", executionId: "e-1" });
    const lines = session.taskMessages("objective", { id: "reviewer" }, "background", "be brief");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      "TASK",
      "CONTEXT",
      "CONTEXT",
      "INSTRUCTION",
    ]);
    expect(JSON.parse(lines[1] ?? "{}").payload).toEqual({ role: { id: "reviewer" } });
    expect(JSON.parse(lines[2] ?? "{}").payload).toEqual({ body: "background" });
    expect(JSON.parse(lines[3] ?? "{}").payload).toEqual({ text: "be brief" });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ pipelineId: "p-1", executionId: "e-1" });
  });

  it("omits the context and instruction envelopes when they are empty strings", () => {
    const session = new ProtocolSession(SESSION_IDS);
    const lines = session.taskMessages("objective", undefined, "", "");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["TASK"]);
  });
});

describe("session: helloAck", () => {
  it("encodes a HELLO_ACK line for the given descriptor", () => {
    const session = new ProtocolSession(SESSION_IDS);
    const ack = JSON.parse(
      session.helloAck({
        protocol: PROTOCOL_V2,
        name: "agent-x",
        version: "9.9.9",
        capabilities: ["code"],
        supports: [],
      }),
    );
    expect(ack.type).toBe("HELLO_ACK");
    expect(ack.agentId).toBe("agent-x");
    expect(ack.payload).toMatchObject({ ok: true, agent: "agent-x", agentVersion: "9.9.9" });
  });
});

describe("session: handle() records violations instead of throwing", () => {
  it("records a decode violation and stays usable afterwards", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decodeMessage("{not json"));
    expect(session.violations).toHaveLength(1);
    expect(session.violations[0]?.code).toBe("INVALID_JSON");
    expect(session.violations[0]?.message).toBeTruthy();

    await session.handle(decoded("STATUS", { state: "running" }));
    expect(session.violations).toHaveLength(1);
    expect(session.completionSummary).toBeUndefined();
  });
});

describe("session: handle() processes the HELLO handshake", () => {
  it("stores the descriptor from a valid HELLO", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(
      decoded("HELLO", {
        name: "agent-x",
        version: "1.0.0",
        capabilities: ["code"],
        supports: ["REPORT"],
      }),
    );
    expect(session.descriptor).toEqual({
      protocol: PROTOCOL_V2,
      name: "agent-x",
      version: "1.0.0",
      capabilities: ["code"],
      supports: ["REPORT"],
    });
    expect(session.violations).toEqual([]);
  });

  it("records a violation for a malformed HELLO and leaves the descriptor unset", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("HELLO", { name: "" }));
    expect(session.descriptor).toBeUndefined();
    expect(session.violations).toEqual([
      { code: "INVALID_PAYLOAD", message: "bad HELLO: HELLO payload is missing 'name'" },
    ]);
  });
});

describe("session: handle() answers agent questions", () => {
  it("answers through the responder and records the answer", async () => {
    const session = new ProtocolSession(SESSION_IDS, {
      responder: ({ questionId, question, expected }) => `${questionId}|${question}|${expected}`,
    });
    await session.handle(
      decoded("QUESTION", { questionId: "q-1", question: "which branch?", expected: "choice" }),
    );
    expect(session.questions).toEqual([
      { questionId: "q-1", question: "which branch?", answer: "q-1|which branch?|choice" },
    ]);
    expect(session.pendingAnswers).toHaveLength(1);
    const response = JSON.parse(session.pendingAnswers[0] ?? "{}");
    expect(response.type).toBe("RESPONSE");
    expect(response.payload).toEqual({ questionId: "q-1", body: "q-1|which branch?|choice" });
  });

  it("records the question without an answer when no responder is configured", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("QUESTION", { questionId: "q-2", question: "?" }));
    expect(session.questions).toEqual([{ questionId: "q-2", question: "?" }]);
    expect(session.questions[0]?.answer).toBeUndefined();
    const response = JSON.parse(session.pendingAnswers[0] ?? "{}");
    expect(response.payload).toEqual({ questionId: "q-2" });
  });

  it("records a violation when the responder throws, and still queues a response", async () => {
    const session = new ProtocolSession(SESSION_IDS, {
      responder: () => {
        throw new Error("no idea");
      },
    });
    await session.handle(decoded("QUESTION", { questionId: "q-3", question: "?" }));
    expect(session.violations).toEqual([
      { code: "INVALID_PAYLOAD", message: "question responder failed: no idea" },
    ]);
    expect(session.questions).toEqual([{ questionId: "q-3", question: "?" }]);
    expect(session.pendingAnswers).toHaveLength(1);
    expect(JSON.parse(session.pendingAnswers[0] ?? "{}").payload).toEqual({ questionId: "q-3" });
  });

  it("stringifies a non-Error thrown by the responder", async () => {
    const session = new ProtocolSession(SESSION_IDS, {
      responder: () => {
        throw "plain string failure";
      },
    });
    await session.handle(decoded("QUESTION", { questionId: "q-4", question: "?" }));
    expect(session.violations).toEqual([
      { code: "INVALID_PAYLOAD", message: "question responder failed: plain string failure" },
    ]);
  });

  it("treats an empty responder result as an unanswered question", async () => {
    const session = new ProtocolSession(SESSION_IDS, {
      responder: () => undefined as unknown as string,
    });
    await session.handle(decoded("QUESTION", { questionId: "q-5", question: "?" }));
    expect(session.questions).toEqual([{ questionId: "q-5", question: "?" }]);
    expect(session.questions[0]?.answer).toBeUndefined();
    expect(JSON.parse(session.pendingAnswers[0] ?? "{}").payload).toEqual({ questionId: "q-5" });
  });

  it("falls back to the message id when the question carries no id", async () => {
    const session = new ProtocolSession(SESSION_IDS, { responder: () => "ok" });
    await session.handle(decoded("QUESTION", { question: "why?" }, { messageId: "m-q6" }));
    expect(session.questions).toEqual([{ questionId: "m-q6", question: "why?", answer: "ok" }]);
  });

  it("defaults the expected answer kind to text and echoes the agent's request id", async () => {
    let seen: { questionId: string; question: string; expected?: string } | undefined;
    const session = new ProtocolSession(SESSION_IDS, {
      responder: (question) => {
        seen = question;
        return "answer";
      },
    });
    await session.handle(
      decoded(
        "QUESTION",
        { questionId: "q-7", question: "?" },
        { messageId: "m-q7", requestId: "req-from-agent" },
      ),
    );
    expect(seen).toEqual({ questionId: "q-7", question: "?", expected: "text" });
    const response = JSON.parse(session.pendingAnswers[0] ?? "{}");
    expect(response.requestId).toBe("req-from-agent");
  });

  it("uses the session request id when the agent's question carries none", async () => {
    const session = new ProtocolSession(SESSION_IDS, { responder: () => "answer" });
    await session.handle(decoded("QUESTION", { questionId: "q-8", question: "?" }));
    const response = JSON.parse(session.pendingAnswers[0] ?? "{}");
    expect(response.requestId).toBe("r-1");
    expect(response.taskId).toBe("t-1");
    expect(response.agentId).toBe("a-1");
  });
});

describe("session: handle() collects agent output", () => {
  it("collects REPORT payloads", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    const report = {
      id: "rep-1",
      summary: "found it",
      findings: [],
      recommendations: [],
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await session.handle(decoded("REPORT", report));
    expect(session.reports).toEqual([report]);
  });

  it("collects ARTIFACT payloads", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    const artifact = { kind: "file", ref: "out/report.md" };
    await session.handle(decoded("ARTIFACT", artifact));
    expect(session.artifacts).toEqual([artifact]);
  });

  it("stores the completion summary", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("COMPLETION", { summary: "all done" }));
    expect(session.completionSummary).toBe("all done");
  });

  it("stores an empty completion summary when the agent sends none", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("COMPLETION", { detail: "no summary" }));
    expect(session.completionSummary).toBe("");
  });

  it("stores an empty completion summary when the completion carries no payload", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(raw({ type: "COMPLETION" }));
    expect(session.completionSummary).toBe("");
  });

  it("stores the agent error message and code", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("ERROR", { code: "NOPE", message: "cannot do that" }));
    expect(session.errorMessage).toBe("Agent error [NOPE]: cannot do that");
  });

  it("falls back to a generic message when the agent error carries no text", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("ERROR", { code: "NOPE" }));
    expect(session.errorMessage).toBe("Agent error [NOPE]: agent reported an error");
  });

  it("omits the code when the agent error carries none", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decoded("ERROR", { message: "kaboom" }));
    expect(session.errorMessage).toBe("Agent error: kaboom");
  });

  it("falls back to a generic message when the error carries no payload at all", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(raw({ type: "ERROR" }));
    expect(session.errorMessage).toBe("Agent error: agent reported an error");
  });

  it("ignores lifecycle acknowledgements", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    for (const type of ["TASK_ACCEPTED", "TASK_STARTED", "STATUS"]) {
      await session.handle(decoded(type, { state: "running" }));
    }
    expect(session.violations).toEqual([]);
    expect(session.reports).toEqual([]);
    expect(session.artifacts).toEqual([]);
    expect(session.questions).toEqual([]);
  });

  it("records an UNKNOWN_TYPE violation for a message type the core does not know", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(raw({ type: "LAUNCH_MISSILES" }));
    expect(session.violations).toEqual([
      { code: "UNKNOWN_TYPE", message: "unexpected message type LAUNCH_MISSILES from agent" },
    ]);
  });
});

describe("session: the legacy v1 dialect", () => {
  it("accepts a legacy (unversioned) COMPLETION without flagging v2", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    expect(session.sawV2).toBe(false);
    await session.handle(decodeMessage(JSON.stringify({ type: "COMPLETION", payload: { summary: "legacy done" } })));
    expect(session.sawV2).toBe(false);
    expect(session.completionSummary).toBe("legacy done");
  });

  it("flags sawV2 once a v2 message arrives", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    expect(session.sawV2).toBe(false);
    await session.handle(decoded("STATUS", { state: "running" }));
    expect(session.sawV2).toBe(true);
  });

  it("answers a legacy question that carries no payload", async () => {
    const session = new ProtocolSession(SESSION_IDS, { responder: () => "legacy answer" });
    await session.handle(decodeMessage(JSON.stringify({ type: "QUESTION", payload: null })));
    expect(session.questions).toEqual([
      { questionId: "legacy", question: "", answer: "legacy answer" },
    ]);
    const response = JSON.parse(session.pendingAnswers[0] ?? "{}");
    expect(response.requestId).toBe("r-1");
  });

  it("records a legacy error message through the same path", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    await session.handle(decodeMessage(JSON.stringify({ type: "ERROR", payload: { message: "legacy boom" } })));
    expect(session.errorMessage).toBe("Agent error: legacy boom");
  });
});

describe("session: decodeStream", () => {
  it("decodes a chunk and returns the answers it queued", async () => {
    const session = new ProtocolSession(SESSION_IDS, { responder: () => "42" });
    const answers = await decodeStream(
      session,
      `${line("QUESTION", { questionId: "q", question: "life?" })}\n`,
    );
    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0] ?? "{}").payload).toEqual({ questionId: "q", body: "42" });
    expect(session.pendingAnswers).toEqual([]);
  });

  it("drains only the answers produced by the chunk it was given", async () => {
    const session = new ProtocolSession(SESSION_IDS, { responder: () => "answer" });
    const first = await decodeStream(
      session,
      `${line("QUESTION", { questionId: "q1", question: "?" })}\n`,
    );
    expect(first).toHaveLength(1);
    const second = await decodeStream(
      session,
      `${line("QUESTION", { questionId: "q2", question: "?" })}\n`,
    );
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0] ?? "{}").payload).toEqual({ questionId: "q2", body: "answer" });
  });

  it("records a violation for a garbage line and continues the stream", async () => {
    const session = new ProtocolSession(SESSION_IDS);
    const answers = await decodeStream(
      session,
      `not json\n${line("STATUS", { state: "running" })}\n`,
    );
    expect(answers).toEqual([]);
    expect(session.violations).toHaveLength(1);
    expect(session.violations[0]?.code).toBe("INVALID_JSON");
  });

  it("honours the session's maxBytes budget", async () => {
    const session = new ProtocolSession(SESSION_IDS, { maxBytes: 200 });
    await decodeStream(session, `${line("STATUS", { blob: "x".repeat(500) })}\n`);
    expect(session.violations.some((v) => v.code === "OVERSIZED")).toBe(true);
  });
});

describe("session: requireCompletion", () => {
  it("throws a ProtocolError when the agent reported an error", () => {
    const session = new ProtocolSession(SESSION_IDS);
    session.errorMessage = "Agent error [X]: boom";
    expect(() => requireCompletion(session)).toThrow(ProtocolError);
    expect(() => requireCompletion(session)).toThrow("Agent error [X]: boom");
    try {
      requireCompletion(session);
      expect.unreachable("requireCompletion should have thrown");
    } catch (error) {
      expect((error as ProtocolError).code).toBe("PROTOCOL_VIOLATION");
    }
  });

  it("does nothing when the session completed cleanly", () => {
    const session = new ProtocolSession(SESSION_IDS);
    expect(() => requireCompletion(session)).not.toThrow();
  });
});
