/**
 * v2 Phase 4 tests — Agent Adapter Hardening (roadmap §8): environment
 * policies, process-tree cleanup, output limits, working-directory validation
 * and the native adapter registry.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv, resolveEnvPolicy } from "../src/agents/env.js";
import { validateWorkingDirectory } from "../src/agents/cwd.js";
import { describeExit, sanitizeChunk, ProcessAgent } from "../src/agents/process/index.js";
import { AgentAdapterRegistry, createAgent } from "../src/agents/factory.js";
import type { AgentConfig, IAgent } from "../src/types/agent.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "omninode-adapter-"));
}

const nodeAgent = (script: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "hardened",
  integration: "process",
  command: "node",
  args: ["-e", script],
  timeoutMs: 5000,
  ...extra,
});

describe("environment policies (§8)", () => {
  const config = (over: Partial<AgentConfig>): AgentConfig => ({
    name: "a",
    integration: "process",
    command: "x",
    ...over,
  });

  it("inherit forwards the full environment by default", () => {
    const env = buildChildEnv(config({}));
    expect(env.PATH).toBe(process.env.PATH);
    expect(resolveEnvPolicy(config({}))).toBe("inherit");
  });

  it("allowlist forwards only the listed variables (plus PATH/HOME)", () => {
    process.env.OMNINODE_TEST_ALLOWED = "yes";
    process.env.OMNINODE_TEST_SECRET = "no";
    const env = buildChildEnv(
      config({ envPolicy: "allowlist", envAllowlist: ["OMNINODE_TEST_ALLOWED"] }),
    );
    expect(env.OMNINODE_TEST_ALLOWED).toBe("yes");
    expect(env.OMNINODE_TEST_SECRET).toBeUndefined();
    delete process.env.OMNINODE_TEST_ALLOWED;
    delete process.env.OMNINODE_TEST_SECRET;
  });

  it("denylist strips the listed variables", () => {
    process.env.OMNINODE_TEST_DENIED = "secret";
    const env = buildChildEnv(config({ envPolicy: "denylist", envDenylist: ["OMNINODE_TEST_DENIED"] }));
    expect(env.OMNINODE_TEST_DENIED).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    delete process.env.OMNINODE_TEST_DENIED;
  });

  it("explicit passes only PATH/HOME plus configured vars", () => {
    process.env.OMNINODE_TEST_EXPLICIT = "secret";
    const env = buildChildEnv(config({ envPolicy: "explicit", env: { ALLOWED: "1" } }));
    expect(env.ALLOWED).toBe("1");
    expect(env.OMNINODE_TEST_EXPLICIT).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["ALLOWED", "HOME", "PATH"]);
    delete process.env.OMNINODE_TEST_EXPLICIT;
  });

  it("v1 inherit_env:false still maps to the explicit policy", () => {
    expect(resolveEnvPolicy({ name: "a", integration: "process", inheritEnv: false })).toBe("explicit");
  });
});

describe("output protection (§8)", () => {
  it("kills an agent that floods stdout and reports the limit", async () => {
    const marker = path.join(tmp(), "flood.out");
    const agent = new ProcessAgent(
      nodeAgent(
        `setInterval(() => process.stdout.write("x".repeat(100000)), 5); setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 4000);`,
        { maxOutputBytes: 50_000, timeoutMs: 10_000 },
      ),
    );
    const started = Date.now();
    const result = await agent.run({ taskId: "flood", objective: "flood" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("output limit");
    expect(Date.now() - started).toBeLessThan(4000); // killed well before its own timer
    rmSync(path.dirname(marker), { recursive: true, force: true });
  }, 15_000);

  it("sanitizes NUL bytes from binary-ish output", () => {
    expect(sanitizeChunk(Buffer.from([0x61, 0x00, 0x62]))).toBe("ab");
  });

  it("interprets exit codes and signal terminations", () => {
    expect(describeExit(0, null)).toContain("code 0");
    expect(describeExit(null, "SIGTERM")).toContain("SIGTERM");
    expect(describeExit(null, "SIGKILL")).toContain("SIGKILL");
  });
});

describe("process-tree cleanup (§8)", () => {
  it("kills grandchildren when the agent is killed on timeout", async () => {
    const dir = tmp();
    const marker = path.join(dir, "grandchild.txt");
    // The grandchild is a script FILE (not nested -e quoting, which is
    // version-sensitive): it writes a marker 3s after spawn. The timeout
    // kills the whole process group, so the marker must never appear.
    const grandchildScript = path.join(dir, "grandchild.cjs");
    writeFileSync(
      grandchildScript,
      `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 3000);\n`,
    );
    const script = `
      const { spawn } = require("child_process");
      spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const agent = new ProcessAgent(nodeAgent(script, { timeoutMs: 400 }));
    await expect(agent.run({ taskId: "tree", objective: "spawn" })).rejects.toMatchObject({
      code: "AGENT_TIMEOUT",
    });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(() => readFileSync(marker)).toThrow(); // grandchild was reaped with the group
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("kills grandchildren when a running agent is cancelled", async () => {
    const dir = tmp();
    const marker = path.join(dir, "grandchild-cancel.txt");
    const grandchildScript = path.join(dir, "grandchild-cancel.cjs");
    writeFileSync(
      grandchildScript,
      `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 3000);\n`,
    );
    const script = `
      const { spawn } = require("child_process");
      spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const agent = new ProcessAgent(nodeAgent(script, { timeoutMs: 10_000 }));
    const settled = await new Promise<{ kind: string }>((resolve) => {
      agent
        .run({ taskId: "tree-cancel", objective: "spawn" })
        .then(
          () => resolve({ kind: "resolved" }),
          () => resolve({ kind: "rejected" }),
        );
      // Cancel once the agent and its grandchild are up.
      setTimeout(() => void agent.cancel("tree-cancel"), 400);
    });
    // The run settles instead of hanging when the tree is killed.
    expect(["resolved", "rejected"]).toContain(settled.kind);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(() => readFileSync(marker)).toThrow(); // grandchild was reaped with the group
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("working-directory validation (§8)", () => {
  it("rejects a missing directory and a file", () => {
    expect(() => validateWorkingDirectory("/definitely/not/here")).toThrow(/does not exist|not accessible/);
    const dir = tmp();
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(() => validateWorkingDirectory(file)).toThrow(/not a directory/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects directories outside the project root unless allowed", () => {
    const dir = tmp();
    expect(() => validateWorkingDirectory(dir, { projectRoot: process.cwd() })).toThrow(
      /outside the project root/,
    );
    expect(() =>
      validateWorkingDirectory(dir, { projectRoot: process.cwd(), allowExternal: true }),
    ).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes relative paths and accepts in-project dirs", () => {
    const result = validateWorkingDirectory(".", { projectRoot: process.cwd() });
    expect(result?.cwd).toBe(process.cwd());
    expect(result?.outsideProject).toBe(false);
  });

  it("fails the run before spawning when cwd is invalid", async () => {
    const agent = new ProcessAgent(nodeAgent("process.stdout.write('never')", { cwd: "/definitely/not/here" }));
    await expect(agent.run({ taskId: "cwd", objective: "x" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  }, 10_000);
});

describe("native adapter registry (§8)", () => {
  it("createAgent uses a registered native adapter instead of throwing", () => {
    const adapters = new AgentAdapterRegistry();
    const fake: IAgent = {
      info: { name: "native-agent", integration: "native", status: "ready" },
      async run() {
        return { taskId: "t", status: "completed", summary: "native run" };
      },
    };
    adapters.register({ integration: "native", create: () => fake });
    const agent = createAgent({ name: "native-agent", integration: "native" }, adapters);
    expect(agent.info.name).toBe("native-agent");
  });

  it("still reports NOT_IMPLEMENTED for unregistered native integrations", () => {
    expect(() => createAgent({ name: "n", integration: "native" }, new AgentAdapterRegistry())).toThrow(
      /No native adapter is registered/,
    );
  });
});