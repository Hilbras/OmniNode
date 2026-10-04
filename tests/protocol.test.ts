/**
 * Agent Protocol v2 tests (roadmap §7): versioning, envelope validation, the
 * malformed-message matrix, streaming decode, handshake, correlation,
 * question round-trips, and a real process speaking v2 end to end.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V2,
  ProtocolDecoder,
  ProtocolSession,
  buildHello,
  buildHelloAck,
  decodeMessage,
  envelope,
  isSupportedProtocol,
  parseHello,
} from "../src/agent-protocol/index.js";
import { ProcessAgent } from "../src/agents/process/index.js";

describe("protocol versioning (§7.1)", () => {
  it("declares and recognizes the v2 dialect", () => {
    expect(PROTOCOL_V2).toBe("omninode-agent-protocol/2");
    expect(isSupportedProtocol("omninode-agent-protocol/2")).toBe(true);
    expect(isSupportedProtocol("omninode-agent-protocol/1")).toBe(true);
    expect(isSupportedProtocol("some-other-protocol/9")).toBe(false);
  });

  it("emits envelopes carrying full correlation ids", () => {
    const message = envelope("TASK", { taskId: "t1", objective: "do it" }, {
      requestId: "r1", taskId: "t1", agentId: "a1", pipelineId: "p1", executionId: "e1",
    });
    expect(message.protocol).toBe(PROTOCOL_V2);
    expect(message).toMatchObject({
      requestId: "r1", taskId: "t1", agentId: "a1", pipelineId: "p1", executionId: "e1",
      type: "TASK",
    });
    expect(message.messageId).toMatch(/^msg-/);
  });
});

describe("malformed message matrix (§7.5)", () => {
  const cases: Array<[string, string, string]> = [
    ["invalid JSON", "{not json", "INVALID_JSON"],
    ["non-object JSON", "[1,2,3]", "NOT_AN_OBJECT"],
    ["unknown type", JSON.stringify({ protocol: PROTOCOL_V2, type: "LAUNCH_MISSILES" }), "UNKNOWN_TYPE"],
    ["missing type", JSON.stringify({ protocol: PROTOCOL_V2, payload: {} }), "MISSING_FIELD"],
    ["missing required payload", JSON.stringify({ protocol: PROTOCOL_V2, type: "REPORT" }), "INVALID_PAYLOAD"],
    ["unsupported version", JSON.stringify({ protocol: "omninode-agent-protocol/99", type: "STATUS" }), "UNSUPPORTED_VERSION"],
    ["oversized message", JSON.stringify({ protocol: PROTOCOL_V2, type: "STATUS", payload: { blob: "x".repeat(2000) } }), "OVERSIZED"],
  ];

  it.each(cases)("rejects %s with a typed violation", (_name, line, code) => {
    const result = decodeMessage(line, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("accepts legacy v1 (unversioned) messages", () => {
    const result = decodeMessage(JSON.stringify({ type: "COMPLETION", payload: { summary: "legacy done" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legacy).toBe(true);
      expect(result.envelope.type).toBe("COMPLETION");
    }
  });

  it("garbage never throws — decoding is total", () => {
    for (const junk of ["", "   ", "\x00\x01", "}{", "null", "42"]) {
      expect(() => decodeMessage(junk)).not.toThrow();
    }
  });
});

describe("streaming decoder", () => {
  it("decodes chunked lines and survives a garbage line in the middle", () => {
    const decoder = new ProtocolDecoder();
    const good = JSON.stringify({ protocol: PROTOCOL_V2, type: "STATUS", payload: { state: "running" } });
    const results = decoder.push(`{"bad\n${good}\n`);
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(true);
  });

  it("flushes a trailing line without a newline", () => {
    const decoder = new ProtocolDecoder();
    decoder.push(JSON.stringify({ protocol: PROTOCOL_V2, type: "STATUS", payload: {} }));
    const flushed = decoder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.ok).toBe(true);
  });
});

describe("handshake (§7.1)", () => {
  it("round-trips HELLO → HELLO_ACK and validates descriptors", () => {
    const hello = buildHello({
      name: "my-agent",
      version: "1.4.2",
      capabilities: ["code", "review"],
      supports: ["REPORT", "QUESTION", "COMPLETION"],
    });
    const parsed = parseHello(hello);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.descriptor).toMatchObject({
      protocol: PROTOCOL_V2,
      name: "my-agent",
      version: "1.4.2",
      capabilities: ["code", "review"],
    });

    const ack = buildHelloAck(parsed.descriptor);
    expect(ack.type).toBe("HELLO_ACK");
    expect((ack.payload as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a malformed HELLO", () => {
    const bad = envelope("HELLO", { name: "" });
    const parsed = parseHello(bad);
    expect(parsed.ok).toBe(false);
    expect(parseHello(envelope("TASK", {})).ok).toBe(false);
  });
});

describe("session: question round-trip (§7.6)", () => {
  it("answers agent questions through the responder and records them", async () => {
    const session = new ProtocolSession(
      { requestId: "r1", taskId: "t1", agentId: "a1" },
      { responder: async ({ question }) => `answer to: ${question}` },
    );
    await session.handle(
      decodeMessage(JSON.stringify({
        protocol: PROTOCOL_V2, type: "QUESTION", messageId: "m1",
        payload: { questionId: "q1", question: "which branch?" },
      })),
    );
    expect(session.questions).toEqual([
      { questionId: "q1", question: "which branch?", answer: "answer to: which branch?" },
    ]);
    expect(session.pendingAnswers.join()).toContain("RESPONSE");
  });

  it("records questions unanswered when no responder is configured", async () => {
    const session = new ProtocolSession({ requestId: "r1", taskId: "t1", agentId: "a1" });
    await session.handle(
      decodeMessage(JSON.stringify({
        protocol: PROTOCOL_V2, type: "QUESTION", payload: { questionId: "q2", question: "?" },
      })),
    );
    expect(session.questions[0]?.answer).toBeUndefined();
  });
});

describe("process adapter speaks protocol v2 end to end", () => {
  const speakingAgent: AgentProcessConfig = {
    name: "v2-agent",
    integration: "process",
    inputMode: "protocol",
    command: "node",
    args: [
      "-e",
      `let buf = '';
       process.stdin.on('data', (d) => (buf += d));
       process.stdin.on('end', () => {
         const out = (o) => console.log(JSON.stringify(o));
         out({ protocol: '${PROTOCOL_V2}', type: 'HELLO', messageId: 'm-hello', taskId: 't', payload: { name: 'v2-agent', version: '9.9.9', capabilities: ['code'], supports: ['REPORT', 'COMPLETION'] } });
         out({ protocol: '${PROTOCOL_V2}', type: 'REPORT', messageId: 'm-report', taskId: 't', payload: { id: 'rep-1', summary: 'found the bug', findings: [], recommendations: [], createdAt: new Date().toISOString() } });
         out({ protocol: '${PROTOCOL_V2}', type: 'COMPLETION', messageId: 'm-done', taskId: 't', payload: { summary: 'audit finished' } });
       });`,
    ],
  };

  it("collects HELLO descriptor, reports and completion", async () => {
    const agent = new ProcessAgent(speakingAgent);
    const result = await agent.run({ taskId: "t1", objective: "audit", pipelineId: "run-1", executionId: "exec-1" });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("audit finished");
    expect(result.reports?.[0]).toMatchObject({ id: "rep-1", summary: "found the bug" });
    expect(result.protocol?.descriptor).toMatchObject({ name: "v2-agent", version: "9.9.9" });
    expect(result.protocol?.violations).toEqual([]);
  }, 15_000);

  it("an agent that speaks garbage fails cleanly instead of crashing OmniNode", async () => {
    const agent = new ProcessAgent({
      name: "noisy",
      integration: "process",
      inputMode: "protocol",
      command: "node",
      args: ["-e", "console.log('hello there'); console.log(JSON.stringify({ type: '???' }));"],
    });
    const result = await agent.run({ taskId: "t1", objective: "x" });
    expect(result.status).toBe("failed");
    expect(result.protocol?.violations.length).toBeGreaterThan(0);
  }, 15_000);
});

type AgentProcessConfig = ConstructorParameters<typeof ProcessAgent>[0];