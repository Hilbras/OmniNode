import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/index.js";


let workDir: string;
let previousCwd: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "omninode-repcli-"));
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

async function setupProjectWithPipeline(): Promise<void> {
  await createProgram().parseAsync(["node", "omninode", "init"]);
  await createProgram().parseAsync([
    "node", "omninode", "agent", "add", "--name", "worker",
    "--command", "node", "--arg=-e", "--arg=process.stdout.write('WORKER-OK')",
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
      steps:
        - id: research
          kind: research
          agents: [worker, helper]`,
    ),
    "utf8",
  );
}

describe("CLI report commands", () => {
  it("reports are empty before anything runs", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);
    expect(outputOf(log)).toContain("No reports stored yet");
  });

  it("a pipeline run collects, stores and combines reports end to end", async () => {
    await setupProjectWithPipeline();

    const log = capture();
    await createProgram().parseAsync(["node", "omninode", "pipeline", "run", "audit", "audit the code"]);
    const runOutput = outputOf(log);
    expect(runOutput).toContain("Pipeline completed");
    expect(runOutput).toContain("combined report: combined-");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "report", "list"]);
    const listOutput = outputOf(log);
    expect(listOutput).toContain("worker");
    expect(listOutput).toContain("helper");
    expect(listOutput).toContain("WORKER-OK");
    expect(listOutput).toContain("HELPER-OK");

    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "report", "combined"]);
    const combinedOutput = outputOf(log);
    expect(combinedOutput).toContain("combined-");
    expect(combinedOutput).toContain("0 finding(s) from 2 source(s)"); // echo output has no findings

    const combinedId = /combined-[a-z0-9-]+/.exec(combinedOutput)?.[0];
    expect(combinedId).toBeDefined();
    log.mockClear();
    await createProgram().parseAsync(["node", "omninode", "report", "show", combinedId!]);
    const showOutput = outputOf(log);
    expect(showOutput).toContain("Combined report");
    expect(showOutput).toContain("sources:   helper, worker");
    expect(showOutput).toContain("0 unique finding group(s)");
  }, 20_000);

  it("report show fails clearly for unknown ids", async () => {
    await createProgram().parseAsync(["node", "omninode", "init"]);
    capture();
    await expect(
      createProgram().parseAsync(["node", "omninode", "report", "show", "rep-ghost"]),
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });
});
