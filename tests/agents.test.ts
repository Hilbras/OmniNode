import { describe, expect, it } from "vitest";
import { composeTaskText, ProcessAgent } from "../src/agents/process/index.js";
import { createAgent } from "../src/agents/factory.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentError } from "../src/errors/index.js";
import type { AgentConfig } from "../src/types/agent.js";
import type { RoleDefinition } from "../src/types/role.js";

const okAgent: AgentConfig = {
  name: "ok",
  integration: "process",
  command: "node",
  args: ["-e", "process.stdout.write('OK')"],
};

const role: RoleDefinition = {
  id: "tester",
  name: "Tester",
  responsibilities: ["test things"],
  expectedOutputs: ["results"],
};

describe("composeTaskText", () => {
  it("composes objective, role, context and instruction sections", () => {
    const text = composeTaskText({
      taskId: "t",
      objective: "Do the thing",
      role,
      context: "some background",
      instruction: "be brief",
    });
    expect(text).toContain("# Objective\nDo the thing");
    expect(text).toContain("# Role\nTester (tester)");
    expect(text).toContain("- test things");
    expect(text).toContain("- results");
    expect(text).toContain("# Context\nsome background");
    expect(text).toContain("# Instruction\nbe brief");
  });

  it("omits missing sections", () => {
    const text = composeTaskText({ taskId: "t", objective: "only objective" });
    expect(text).toBe("# Objective\nonly objective");
  });
});

describe("ProcessAgent — stdin mode", () => {
  it("captures stdout and completes on exit 0", async () => {
    const agent = new ProcessAgent(okAgent);
    const result = await agent.run({ taskId: "t1", objective: "say ok" });
    expect(result.status).toBe("completed");
    expect(result.rawOutput).toBe("OK");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("delivers the composed prompt (objective, role) over stdin", async () => {
    const agent = new ProcessAgent({
      name: "echo",
      integration: "process",
      command: "node",
      args: ["-e", "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('GOT:'+b))"],
    });
    const result = await agent.run({ taskId: "t2", objective: "hello world", role });
    expect(result.rawOutput).toContain("GOT:");
    expect(result.rawOutput).toContain("# Objective\nhello world");
    expect(result.rawOutput).toContain("# Role\nTester (tester)");
    expect(result.rawOutput).toContain("- test things");
  });

  it("marks failures on non-zero exit and captures stderr logs", async () => {
    const agent = new ProcessAgent({
      name: "boom",
      integration: "process",
      command: "node",
      args: ["-e", "console.error('boom'); process.exit(3)"],
    });
    const result = await agent.run({ taskId: "t3", objective: "fail" });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("code 3");
    expect(result.logs?.join("\n")).toContain("boom");
  });

  it("throws AGENT_NOT_FOUND when the command does not exist", async () => {
    const agent = new ProcessAgent({
      name: "ghost",
      integration: "process",
      command: "omninode-definitely-not-installed",
    });
    await expect(agent.run({ taskId: "t4", objective: "x" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("PATH"),
    });
  });

  it("throws AGENT_TIMEOUT and kills a long-running process", async () => {
    const agent = new ProcessAgent({
      name: "slow",
      integration: "process",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 300,
    });
    await expect(agent.run({ taskId: "t5", objective: "x" })).rejects.toMatchObject({
      code: "AGENT_TIMEOUT",
      message: expect.stringContaining("300"),
    });
  });

  it("arg mode appends the composed prompt as the last argument", async () => {
    const agent = new ProcessAgent({
      name: "arg",
      integration: "process",
      command: "node",
      args: ["-e", "process.stdout.write('ARG:' + process.argv[1])"],
      inputMode: "arg",
    });
    const result = await agent.run({ taskId: "t6", objective: "PROMPT123" });
    expect(result.rawOutput).toBe("ARG:# Objective\nPROMPT123");
  });
});

describe("ProcessAgent — protocol mode (§21)", () => {
  it("parses REPORT and COMPLETION messages into structured output", async () => {
    const agent = new ProcessAgent({
      name: "proto",
      integration: "process",
      command: "node",
      args: [
        "-e",
        readerScript([
          { type: "REPORT", payload: { summary: "analyzed the task", findings: [{ id: "f1", title: "t", detail: "d" }] } },
          { type: "COMPLETION", payload: { summary: "done" } },
        ]),
      ],
      inputMode: "protocol",
    });
    const result = await agent.run({ taskId: "task-9", objective: "audit something" });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
    expect(result.reports).toHaveLength(1);
    expect(result.reports?.[0]).toMatchObject({
      taskId: "task-9",
      agent: "proto",
      summary: "analyzed the task",
    });
    expect(result.reports?.[0]?.findings[0]).toMatchObject({ id: "f1", title: "t" });
  });

  it("treats an ERROR message as a failed task", async () => {
    const agent = new ProcessAgent({
      name: "proto",
      integration: "process",
      command: "node",
      args: [
        "-e",
        readerScript([{ type: "ERROR", payload: { code: "NOPE", message: "cannot do that" } }]),
      ],
      inputMode: "protocol",
    });
    const result = await agent.run({ taskId: "t", objective: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("[NOPE]");
    expect(result.error).toContain("cannot do that");
  });

  it("fails cleanly (never throws) when a healthy exit produced no protocol messages", async () => {
    const agent = new ProcessAgent({
      name: "chatter",
      integration: "process",
      command: "node",
      args: ["-e", "process.stdout.write('plain text chatter')"],
      inputMode: "protocol",
    });
    const result = await agent.run({ taskId: "t", objective: "x" });
    // v2: agent misbehavior is data, not an exception (§7.5).
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no valid protocol messages");
    expect(result.protocol?.violations.length).toBeGreaterThan(0);
  });

  it("delivers protocol v2 envelopes (TASK + role CONTEXT) on stdin", async () => {
    const agent = new ProcessAgent({
      name: "echoer",
      integration: "process",
      command: "node",
      args: [
        "-e",
        `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{const lines=b.trim().split('\\n').map(JSON.parse);process.stdout.write(JSON.stringify({protocol:'omninode-agent-protocol/2',type:'COMPLETION',messageId:'m1',taskId:'t7',payload:{summary:'types='+lines.map(l=>l.type).join(',')}}))})`,
      ],
      inputMode: "protocol",
    });
    const result = await agent.run({ taskId: "t7", objective: "obj", role });
    expect(result.summary).toBe("types=TASK,CONTEXT");
    expect(result.protocol?.legacy).toBe(false);
  });
});

/** Builds a node -e script that reads stdin and prints the given messages as JSON lines. */
function readerScript(messages: unknown[]): string {
  const lines = messages.map((m) => `process.stdout.write(JSON.stringify(${JSON.stringify(m)}) + "\\n");`);
  return `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{${lines.join("")}})`;
}

describe("agent factory + registry", () => {
  it("builds ProcessAgent for process integration", () => {
    expect(createAgent(okAgent)).toBeInstanceOf(ProcessAgent);
  });

  it("defers native integration", () => {
    expect(() =>
      createAgent({ name: "n", integration: "native", command: "x" }),
    ).toThrow(
      expect.objectContaining({ code: "NOT_IMPLEMENTED", message: expect.stringContaining("stdin/stdout") }),
    );
  });

  it("rejects process agents without a command", () => {
    expect(() => new ProcessAgent({ name: "n", integration: "process" })).toThrow(AgentError);
  });

  it("registry registers, gets and lists agents sorted by name", () => {
    const registry = new AgentRegistry();
    registry.register(new ProcessAgent({ ...okAgent, name: "b" }));
    registry.register(new ProcessAgent({ ...okAgent, name: "a" }));
    expect(registry.get("a")?.info.name).toBe("a");
    expect(registry.get("zzz")).toBeUndefined();
    expect(registry.list().map((a) => a.info.name)).toEqual(["a", "b"]);
  });
});
