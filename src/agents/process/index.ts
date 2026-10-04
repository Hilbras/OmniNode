/**
 * Process adapter (§9): runs CLI agents as child processes and communicates
 * over stdin/stdout, managing the process lifecycle, working directory,
 * environment, exit codes, logs and timeouts.
 *
 * Three input modes (§9, §21):
 *  - "stdin":    the composed task text is written to the agent's stdin.
 *  - "arg":      the composed task text is appended as the last command argument.
 *  - "protocol": NodeToAgentMessage envelopes as JSON lines on stdin; the
 *                agent answers with AgentToNodeMessage JSON lines (REPORT,
 *                COMPLETION, ERROR, ...) whose structured payloads are parsed
 *                into reports.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { AgentError, ProtocolError } from "../../errors/index.js";
import { logger, type Logger } from "../../logger/index.js";
import type {
  AgentConfig,
  AgentInfo,
  AgentTaskInput,
  AgentTaskOutput,
  IAgent,
} from "../../types/agent.js";
import type { EnvelopeMeta, NodeToAgentMessage } from "../../types/protocol.js";
import type { Report } from "../../types/report.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

/**
 * Builds the child environment. By default the agent inherits the full
 * environment; with `inheritEnv: false` it receives only PATH plus the
 * explicitly configured variables — useful to avoid leaking OmniNode's
 * own secrets (e.g. provider API keys) into third-party agents.
 */
export function buildChildEnv(config: AgentConfig): NodeJS.ProcessEnv {
  const configured = config.env ?? {};
  if (config.inheritEnv !== false) {
    return { ...process.env, ...configured };
  }
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...configured,
  };
}

export function composeTaskText(input: AgentTaskInput): string {
  const sections: string[] = [`# Objective\n${input.objective}`];
  if (input.role) {
    const lines = ["# Role", `${input.role.name} (${input.role.id})`];
    if (input.role.responsibilities.length > 0) {
      lines.push("", "Responsibilities:", ...input.role.responsibilities.map((r) => `- ${r}`));
    }
    if (input.role.expectedOutputs.length > 0) {
      lines.push("", "Expected outputs:", ...input.role.expectedOutputs.map((o) => `- ${o}`));
    }
    sections.push(lines.join("\n"));
  }
  if (input.context) sections.push(`# Context\n${input.context}`);
  if (input.instruction) sections.push(`# Instruction\n${input.instruction}`);
  return sections.join("\n\n");
}

function buildProtocolMessages(input: AgentTaskInput, agentName: string): string[] {
  const meta: EnvelopeMeta = {
    taskId: input.taskId,
    agent: agentName,
    timestamp: new Date().toISOString(),
  };
  const messages: NodeToAgentMessage[] = [
    { type: "TASK", payload: { taskId: input.taskId, objective: input.objective } },
  ];
  if (input.role) messages.push({ type: "ROLE", payload: input.role });
  if (input.context) messages.push({ type: "CONTEXT", payload: { body: input.context } });
  if (input.instruction) messages.push({ type: "INSTRUCTION", payload: { text: input.instruction } });
  return messages.map((message) => JSON.stringify({ meta, message }));
}

export class ProcessAgent implements IAgent {
  readonly config: AgentConfig;
  readonly info: AgentInfo;
  private readonly log: Logger;
  private readonly running = new Map<string, ChildProcess>();

  constructor(config: AgentConfig, log: Logger = logger) {
    if (!config.command) {
      throw new AgentError("AGENT_NOT_FOUND", `Agent "${config.name}" has no command configured.`);
    }
    this.config = config;
    this.log = log.child({ agent: config.name });
    this.info = {
      name: config.name,
      integration: "process",
      command: config.command,
      cwd: config.cwd,
      status: "ready",
      capabilities: [config.inputMode ?? "stdin"],
    };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    const command = this.config.command;
    if (!command) {
      throw new AgentError("AGENT_NOT_FOUND", `Agent "${this.config.name}" has no command configured.`);
    }
    const mode = this.config.inputMode ?? "stdin";
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<AgentTaskOutput>((resolve, reject) => {
      const child = spawn(
        command,
        [...(this.config.args ?? []), ...(mode === "arg" ? [composeTaskText(input)] : [])],
        {
          cwd: this.config.cwd,
          env: buildChildEnv(this.config),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.running.set(input.taskId, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.log.warn(`Task ${input.taskId} exceeded ${timeoutMs}ms — killing process.`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(input.taskId);
        finish();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Agents that exit without reading stdin raise EPIPE on write — that is
      // not an agent failure, so the stream error is ignored.
      child.stdin?.on("error", () => {});
      if (mode !== "arg") {
        const payload =
          mode === "protocol"
            ? buildProtocolMessages(input, this.config.name).join("\n") + "\n"
            : composeTaskText(input) + "\n";
        child.stdin?.write(payload);
        child.stdin?.end();
      }

      child.on("error", (error) => {
        settle(() => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new AgentError(
                "AGENT_NOT_FOUND",
                `Agent "${this.config.name}": command "${command}" was not found. Is it installed and on PATH?`,
                { cause: error },
              ),
            );
            return;
          }
          reject(
            new AgentError("AGENT_FAILED", `Agent "${this.config.name}" failed to start: ${error.message}.`, {
              cause: error,
            }),
          );
        });
      });

      child.on("close", (code, signal) => {
        settle(() => {
          if (timedOut) {
            reject(
              new AgentError(
                "AGENT_TIMEOUT",
                `Agent "${this.config.name}" timed out after ${timeoutMs}ms and was killed.`,
                {
                  details: {
                    operation: "agent.run",
                    agent: this.config.name,
                    durationMs: timeoutMs,
                    // The process was started and may have performed side
                    // effects before being killed — the outcome is unknown,
                    // not failed (roadmap §6.3).
                    dispatched: true,
                    stdout: stdout.slice(0, 4000),
                    stderr: stderr.slice(0, 2000),
                  },
                },
              ),
            );
            return;
          }

          const logs = stderr.trim().length > 0 ? stderr.split("\n") : undefined;
          if (mode === "protocol") {
            // interpretProtocolRun can reject (e.g. protocol violations); throwing
            // inside this event callback would escape the promise entirely.
            try {
              resolve(
                interpretProtocolRun({
                  input,
                  agentName: this.config.name,
                  stdout,
                  exitCode: code,
                  logs,
                }),
              );
            } catch (error) {
              reject(error);
            }
            return;
          }

          const trimmed = stdout.trim();
          resolve({
            taskId: input.taskId,
            status: code === 0 ? "completed" : "failed",
            summary: trimmed.length > 0 ? firstLine(trimmed) : undefined,
            rawOutput: trimmed.length > 0 ? trimmed : undefined,
            exitCode: code ?? undefined,
            logs,
            error:
              code === 0
                ? undefined
                : `Process exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}`,
          });
        });
      });
    });
  }

  /** Ask the agent to stop current work (SIGTERM). */
  async cancel(taskId: string): Promise<void> {
    const child = this.running.get(taskId);
    if (child) child.kill("SIGTERM");
  }

  runningTaskIds(): string[] {
    return [...this.running.keys()];
  }
}

interface ProtocolRunInput {
  input: AgentTaskInput;
  agentName: string;
  stdout: string;
  exitCode: number | null;
  logs?: string[];
}

function interpretProtocolRun({ input, agentName, stdout, exitCode, logs }: ProtocolRunInput): AgentTaskOutput {
  const reports: Report[] = [];
  let summary: string | undefined;
  let error: string | undefined;
  let sawProtocolMessage = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const message = parseAgentMessage(trimmed);
    if (!message) continue;
    sawProtocolMessage = true;

    if (message.type === "REPORT") {
      const report = normalizeReport(message.payload, input.taskId, agentName, reports.length);
      if (report) reports.push(report);
    } else if (message.type === "COMPLETION") {
      const payload = message.payload as { summary?: unknown } | undefined;
      if (typeof payload?.summary === "string") summary = payload.summary;
    } else if (message.type === "ERROR") {
      const payload = message.payload as { code?: unknown; message?: unknown } | undefined;
      const detail = typeof payload?.message === "string" ? payload.message : "unknown error";
      const code = typeof payload?.code === "string" ? ` [${payload.code}]` : "";
      error = `Agent error${code}: ${detail}`;
    }
    // STATUS / QUESTION / ARTIFACT are informational in v0.4 (§21 backlog).
  }

  if (!sawProtocolMessage && exitCode === 0) {
    throw new ProtocolError(
      `Agent "${agentName}" produced no protocol messages on stdout (input mode "protocol").`,
      { details: { taskId: input.taskId, stdout: stdout.slice(0, 2000) } },
    );
  }

  const trimmed = stdout.trim();
  return {
    taskId: input.taskId,
    status: error !== undefined || exitCode !== 0 ? "failed" : "completed",
    summary: summary ?? reports[0]?.summary,
    rawOutput: trimmed.length > 0 ? trimmed : undefined,
    exitCode: exitCode ?? undefined,
    logs,
    reports: reports.length > 0 ? reports : undefined,
    error:
      error ??
      (exitCode !== 0 ? `Process exited with code ${exitCode ?? "unknown"}` : undefined),
  };
}

/** Accepts both bare `{ type, payload }` and enveloped `{ meta, message }` lines. */
function parseAgentMessage(line: string): { type: string; payload: unknown } | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.type === "string") {
      return { type: parsed.type, payload: parsed.payload };
    }
    const inner = parsed.message as Record<string, unknown> | undefined;
    if (inner && typeof inner.type === "string") {
      return { type: inner.type, payload: inner.payload };
    }
  } catch {
    // Non-JSON chatter is tolerated; protocol compliance is judged overall.
  }
  return undefined;
}

function normalizeReport(
  payload: unknown,
  taskId: string,
  agentName: string,
  index: number,
): Report | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.summary !== "string") return undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : `${taskId}-report-${index}`,
    taskId: typeof raw.taskId === "string" ? raw.taskId : taskId,
    agent: typeof raw.agent === "string" ? raw.agent : agentName,
    summary: raw.summary,
    findings: Array.isArray(raw.findings) ? (raw.findings as Report["findings"]) : [],
    recommendations: Array.isArray(raw.recommendations) ? (raw.recommendations as string[]) : [],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

function firstLine(text: string, maxLength = 200): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}
