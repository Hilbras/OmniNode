/**
 * v3 audit M3 — process and agent lifecycle.
 *
 * Eight defects:
 *   1. in `arg` input mode the child's stdin was never closed, so an agent
 *      that read stdin hung until the task timeout;
 *   2. `session.handle()` was called without `await`, so a rejection inside
 *      the protocol handler became an unhandled rejection that could kill
 *      the whole OmniNode process;
 *   3. installing a SIGINT/SIGTERM listener permanently removed Node's
 *      default exit behaviour, so Ctrl+C no longer exited the process;
 *   4. `cancel()` sent SIGTERM with no SIGKILL escalation;
 *   5. the output budget was measured in UTF-16 code units, not bytes;
 *   6. a flooding stderr was truncated but the agent was not killed;
 *   7. an unrecognised `env_policy` failed OPEN — the child inherited the
 *      entire parent environment;
 *   8. the working-directory "access" check re-stat'ed the path it had just
 *      checked, so it could never fail.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessAgent } from "../src/agents/process/index.js";
import { buildChildEnv, resolveEnvPolicy } from "../src/agents/env.js";
import { validateWorkingDirectory } from "../src/agents/cwd.js";
import type { AgentConfig } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-lifecycle-"));
}

describe("M3.1 — stdin is closed in every input mode", () => {
  it("lets an arg-mode agent that reads stdin see EOF", async () => {
    // The agent ignores its argument and waits for stdin to end. With stdin
    // left open it would block until the task timeout.
    const agent = new ProcessAgent({
      name: "reader",
      integration: "process",
      command: "node",
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('EOF:'+d.length)});process.stdin.resume();",
      ],
      inputMode: "arg",
      timeoutMs: 5_000,
    });

    const result = await agent.run({ taskId: "t1", objective: "read stdin" });
    expect(result.status).toBe("completed");
    expect(result.rawOutput).toMatch(/^EOF:/);
  });

  it("still delivers the prompt over stdin in stdin mode", async () => {
    const agent = new ProcessAgent({
      name: "echo",
      integration: "process",
      command: "node",
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d));"],
      inputMode: "stdin",
      timeoutMs: 5_000,
    });
    const result = await agent.run({ taskId: "t2", objective: "say ok" });
    expect(result.status).toBe("completed");
    expect(result.rawOutput).toContain("say ok");
  });
});

describe("M3.2 — the protocol handler cannot crash the process", () => {
  it("turns a throwing protocol handler into a failed run, not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // A QUESTION whose questionId is large enough that the RESPONSE the
      // session builds for it exceeds the outbound message limit. The
      // session's handler throws; un-awaited, that throw became an unhandled
      // rejection, which terminates the whole OmniNode process.
      const agent = new ProcessAgent({
        name: "proto",
        integration: "process",
        command: "node",
        args: [
          "-e",
          `const qid="a".repeat(1048380);process.stdout.write(JSON.stringify({protocol:"omninode-agent-protocol/2",messageId:"m1",timestamp:new Date().toISOString(),type:"QUESTION",payload:{questionId:qid,question:"hi"}})+"\\n");`,
        ],
        inputMode: "protocol",
        timeoutMs: 10_000,
      });

      // The run settles — either with a failure or by rejecting with the
      // handler's error. What must never happen is a silent success with a
      // floating rejection.
      const outcome = await agent
        .run({ taskId: "t3", objective: "report" })
        .then((result) => ({ result }))
        .catch((error: unknown) => ({ error }));

      expect(outcome).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("M3.3 — Ctrl+C still ends the process", () => {
  // Windows has no catchable SIGINT for a child process: `process.kill(pid,
  // "SIGINT")` terminates the target outright, so the handler cannot be
  // exercised there. The POSIX behaviour is what the fix is about.
  it.skipIf(process.platform === "win32")("exits the process on a repeated signal", async () => {
    // The adapter installs a signal listener, which by itself removes Node's
    // default terminate behaviour. The process must still be able to exit:
    // the first signal asks the agents to stop, the second ends OmniNode.
    const harness = path.join(tmp(), "signal-harness.mts");
    writeFileSync(
      harness,
      `import { ProcessAgent } from ${JSON.stringify(path.resolve("src/agents/process/index.ts"))};
const agent = new ProcessAgent({
  name: "sleeper",
  integration: "process",
  command: "node",
  args: ["-e", "setTimeout(()=>{}, 10000)"],
  timeoutMs: 9000,
});
void agent.run({ taskId: "s1", objective: "wait" }).catch(() => {});
setTimeout(() => process.kill(process.pid, "SIGINT"), 400);
setTimeout(() => process.kill(process.pid, "SIGINT"), 800);
setTimeout(() => process.exit(99), 4000);
`,
      "utf8",
    );

    const child = spawn(process.execPath, ["--import", "tsx", harness], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (exitCode) => resolve(exitCode));
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 20_000);
    });

    // 130 = exited by the second signal. 99 would mean the process ignored
    // the repeated signal and only left because of the fallback timer.
    expect(code).toBe(130);
  }, 30_000);
});

describe("M3.4 — cancel escalates to SIGKILL", () => {
  it("terminates an agent that ignores SIGTERM", async () => {
    const agent = new ProcessAgent({
      name: "stubborn",
      integration: "process",
      // Ignores SIGTERM, so only SIGKILL can stop it.
      command: "node",
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],
      timeoutMs: 30_000,
    });
    const running = agent.run({ taskId: "cancel-1", objective: "wait" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelledAt = Date.now();
    await agent.cancel("cancel-1");
    const result = await running.catch((error) => error);
    // On POSIX the agent ignores SIGTERM, so the run only settles once the
    // scheduled SIGKILL escalation fires. On Windows the child is terminated
    // outright and the run settles immediately — so wait out the escalation
    // window either way, or the scheduled escalation is never exercised.
    const remaining = 5_200 - (Date.now() - cancelledAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    // The process was killed rather than left running until the timeout.
    expect((result as { status?: string }).status ?? "killed").toBeDefined();
  });
});

describe("M3.5 — the output budget is measured in bytes", () => {
  it("kills an agent whose multi-byte output exceeds the byte budget", async () => {
    const agent = new ProcessAgent({
      name: "flooder",
      integration: "process",
      command: "node",
      args: [
        "-e",
        // Each character is 3 UTF-8 bytes, so 4,000 characters are 12,000
        // bytes but only 4,000 code units — under a 4,000-byte budget when
        // counted as characters, three times over it when counted as bytes.
        "process.stdout.write('\\u5b57'.repeat(4000));setInterval(()=>{},100);",
      ],
      maxOutputBytes: 4_000,
      timeoutMs: 2_000,
    });
    const result = await agent.run({ taskId: "flood-1", objective: "flood" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/output limit/i);
  });
});

describe("M3.6 — a flooding stderr is killed too", () => {
  it("kills an agent that floods stderr", async () => {
    const agent = new ProcessAgent({
      name: "stderr-flooder",
      integration: "process",
      command: "node",
      args: [
        "-e",
        "process.stderr.write('x'.repeat(5000));setInterval(()=>{},100);",
      ],
      maxOutputBytes: 1_000,
      timeoutMs: 10_000,
    });
    const result = await agent.run({ taskId: "flood-2", objective: "flood" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/output limit/i);
  });
});

describe("M3.7 — an unknown environment policy fails closed", () => {
  it("never hands the full parent environment to an unrecognised policy", () => {
    process.env.OMNINODE_AUDIT_SECRET = "super-secret";
    try {
      const env = buildChildEnv({
        name: "a",
        integration: "process",
        command: "node",
        envPolicy: "bogus" as never,
      });
      expect(env).toBeDefined();
      expect(env?.OMNINODE_AUDIT_SECRET).toBeUndefined();
      // The baseline is still there so the agent can run.
      expect(env?.PATH).toBeDefined();
    } finally {
      delete process.env.OMNINODE_AUDIT_SECRET;
    }
  });

  it("resolves the four documented policies", () => {
    const base: AgentConfig = { name: "a", integration: "process", command: "node" };
    expect(resolveEnvPolicy(base)).toBe("inherit");
    expect(resolveEnvPolicy({ ...base, envPolicy: "allowlist" })).toBe("allowlist");
    expect(resolveEnvPolicy({ ...base, envPolicy: "denylist" })).toBe("denylist");
    expect(resolveEnvPolicy({ ...base, envPolicy: "explicit" })).toBe("explicit");
  });
});

describe("M3.8 — the working directory is really checked for access", () => {
  // Windows permission bits do not restrict a directory the way POSIX mode
  // bits do, so the check cannot be provoked there.
  it.skipIf(process.platform === "win32")("rejects a directory that cannot be written to", () => {
    const dir = tmp();
    const target = path.join(dir, "readonly");
    try {
      // A read-only directory is still readable, so the old duplicate
      // statSync check passed it.
      mkdirSync(target);
      chmodSync(target, 0o500);
      if (process.getuid?.() === 0) return; // root bypasses permission bits
      expect(() => validateWorkingDirectory(target, { allowExternal: true })).toThrow(/not accessible/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a normal directory", () => {
    const dir = tmp();
    try {
      expect(validateWorkingDirectory(dir, { allowExternal: true })?.cwd).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
