import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";

let workDir: string;
let previousCwd: string;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: "PLAN-TEXT from gateway" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
      return;
    }
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-pipecli-"));
  previousCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function capture(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function outputOf(log: ReturnType<typeof capture>): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

async function setupProject(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init"]);
  await createProgram().parseAsync([
    "node", "omninode", "provider", "add",
    "--name", "localgw", "--type", "openai-compatible",
    "--base-url", `http://127.0.0.1:${port}/v1`,
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "worker",
    "--command", "node", "--arg=-e", "--arg=process.stdout.write('RESEARCH-OK')",
  ]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "helper",
    "--command", "node", "--arg=-e", "--arg=process.stdout.write('HELPER-OK')",
  ]);
  const configPath = path.join(workDir, "omninode.yaml");
  const raw = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    raw.replace(
      "roles: []",
      `roles: []

  pipelines:
    - id: audit
      name: Audit Pipeline
      steps:
        - id: research
          kind: research
          agents: [worker, helper]
        - id: plan
          kind: plan
          model: localgw:gpt-test
        - id: execute
          kind: execute
          agent: worker`,
    ),
    "utf8",
  );
}

describe("CLI pipeline commands", () => {
  it("list, run and inspect a full pipeline against a local gateway", async () => {
    await setupProject();

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "list"]);
    expect(outputOf(log)).toContain("audit  Audit Pipeline  3 step(s)");

    log.mockClear();
    await createProgram().parseAsync([
      "node", "omninode", "pipeline", "run", "audit", "audit the repository",
    ]);
    const runOutput = outputOf(log);
    expect(runOutput).toContain("[research] completed");
    expect(runOutput).toContain("[plan] completed");
    expect(runOutput).toContain("[execute] completed");
    expect(runOutput).toContain("Pipeline completed. Run id: ");
    const runId = /run-[a-z0-9-]+/.exec(runOutput)?.[0];
    expect(runId).toBeDefined();

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "runs", "audit"]);
    expect(outputOf(log)).toContain(runId!);

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "status", runId!]);
    const statusOutput = outputOf(log);
    expect(statusOutput).toContain("pipeline:   audit");
    expect(statusOutput).toContain("status:     completed");
    expect(statusOutput).toContain("[research] completed");
  }, 20_000);

  it("pipeline run fails clearly for unknown pipelines", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "pipeline", "run", "ghost"]),
    ).rejects.toMatchObject({ code: "PIPELINE_NOT_FOUND" });
  });
});
