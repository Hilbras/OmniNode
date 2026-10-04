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
import { AgentError } from "../../errors/index.js";
import { PROTOCOL_V2, ProtocolSession, type QuestionResponder } from "../../agent-protocol/index.js";
import { logger, type Logger } from "../../logger/index.js";
import type {
  AgentConfig,
  AgentInfo,
  AgentTaskInput,
  AgentTaskOutput,
  IAgent,
} from "../../types/agent.js";
import type { Report } from "../../types/report.js";
import { validateWorkingDirectory } from "../cwd.js";
import { buildChildEnv } from "../env.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
/** Per-stream byte budget before output is truncated and the agent killed. */
export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

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
  // Protocol v2 envelopes with full correlation (roadmap §7.2, §7.4).
  const session = new ProtocolSession({
    requestId: `req-${input.taskId}`,
    taskId: input.taskId,
    agentId: agentName,
    ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
  });
  return session.taskMessages(
    input.objective,
    input.role,
    input.context,
    input.instruction,
  );
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
      // Validate the working directory BEFORE spawning (roadmap §8): never
      // silently fall back to the OmniNode cwd.
      let cwd: string | undefined;
      try {
        cwd = validateWorkingDirectory(this.config.cwd, {
          allowExternal: this.config.allowExternalCwd,
        })?.cwd;
      } catch (error) {
        // Invalid working directory — fail before spawning anything.
        reject(error);
        return;
      }

      const child = spawn(
        command,
        [...(this.config.args ?? []), ...(mode === "arg" ? [composeTaskText(input)] : [])],
        {
          ...(cwd !== undefined ? { cwd } : {}),
          env: buildChildEnv(this.config),
          stdio: ["pipe", "pipe", "pipe"],
          // Own process group so the whole tree can be terminated together
          // (roadmap §8: no orphaned children).
          ...(process.platform === "win32" ? {} : { detached: true }),
        },
      );
      this.running.set(input.taskId, child);
      GLOBAL_RUNNING.add(child);
      installSignalForwarding();

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      const maxOutputBytes = this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

      const timer = setTimeout(() => {
        timedOut = true;
        this.log.warn(`Task ${input.taskId} exceeded ${timeoutMs}ms — killing process tree.`);
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(input.taskId);
        GLOBAL_RUNNING.delete(child);
        finish();
      };

      // Output protection (roadmap §8): runaway/binary output is truncated at
      // a byte budget, and a flooding agent is killed rather than allowed to
      // exhaust memory.
      const collect = (into: "stdout" | "stderr", chunk: Buffer): void => {
        if (outputLimitExceeded) return;
        const text = sanitizeChunk(chunk);
        if (into === "stdout") {
          if (stdout.length + text.length > maxOutputBytes) {
            stdout = (stdout + text).slice(0, maxOutputBytes);
            outputLimitExceeded = true;
            this.log.warn(`Agent "${this.config.name}" exceeded the ${maxOutputBytes} byte output limit — killing it.`);
            killTree(child, "SIGKILL");
            return;
          }
          stdout += text;
        } else {
          if (stderr.length + text.length > maxOutputBytes) {
            stderr = (stderr + text).slice(0, maxOutputBytes);
            return;
          }
          stderr += text;
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

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
            status: code === 0 && !outputLimitExceeded ? "completed" : "failed",
            summary: trimmed.length > 0 ? firstLine(trimmed) : undefined,
            rawOutput: trimmed.length > 0 ? trimmed : undefined,
            exitCode: code ?? undefined,
            logs,
            ...(outputLimitExceeded
              ? { error: `Agent exceeded the ${maxOutputBytes} byte output limit and was terminated.` }
              : code === 0
                ? {}
                : { error: describeExit(code, signal) }),
          });
        });
      });
    });
  }

  /** Ask the agent to stop current work (SIGTERM). */
  async cancel(taskId: string): Promise<void> {
    const child = this.running.get(taskId);
    if (child) killTree(child, "SIGTERM");
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
  responder?: QuestionResponder;
}

function interpretProtocolRun({
  input,
  agentName,
  stdout,
  exitCode,
  logs,
  responder,
}: ProtocolRunInput): AgentTaskOutput {
  const session = new ProtocolSession(
    {
      requestId: `req-${input.taskId}`,
      taskId: input.taskId,
      agentId: agentName,
      ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
    },
    { ...(responder !== undefined ? { responder } : {}) },
  );

  // The stream was drained line-by-line already; re-decode deterministically.
  for (const result of session.decoder.push(stdout)) {
    // handled synchronously below via handle(); questions are resolved eagerly
    session.handle(result);
  }
  for (const result of session.decoder.flush()) {
    session.handle(result);
  }

  const reports = session.reports
    .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
    .map((payload, index) => normalizeReport(payload, input.taskId, agentName, index))
    .filter((report): report is NonNullable<typeof report> => report !== undefined);

  const trimmed = stdout.trim();
  const protocolBlock = {
    protocol: session.descriptor?.protocol ?? PROTOCOL_V2,
    legacy: !session.sawV2 && session.descriptor === undefined,
    ...(session.descriptor !== undefined ? { descriptor: session.descriptor } : {}),
    questions: session.questions,
    violations: session.violations.map((v) => `${v.code}: ${v.message}`),
  };

  if (session.errorMessage !== undefined) {
    return {
      taskId: input.taskId,
      status: "failed",
      error: session.errorMessage,
      rawOutput: trimmed.length > 0 ? trimmed : undefined,
      exitCode: exitCode ?? undefined,
      logs,
      protocol: protocolBlock,
      ...(reports.length > 0 ? { reports } : {}),
    };
  }

  if (session.descriptor === undefined && session.violations.length > 0 && session.reports.length === 0 && session.completionSummary === undefined) {
    // Nothing usable parsed: protocol violation rather than silent success.
    return {
      taskId: input.taskId,
      status: "failed",
      error: `agent produced no valid protocol messages: ${protocolBlock.violations.join("; ")}`,
      rawOutput: trimmed.length > 0 ? trimmed : undefined,
      exitCode: exitCode ?? undefined,
      logs,
      protocol: protocolBlock,
    };
  }

  const completed = exitCode === 0 && session.completionSummary !== undefined;
  return {
    taskId: input.taskId,
    status: completed || exitCode === 0 ? (completed ? "completed" : "completed") : "failed",
    summary: session.completionSummary ?? reports[0]?.summary,
    rawOutput: trimmed.length > 0 ? trimmed : undefined,
    exitCode: exitCode ?? undefined,
    logs,
    protocol: protocolBlock,
    ...(reports.length > 0 ? { reports } : {}),
    ...(exitCode !== 0 ? { error: `Process exited with code ${exitCode ?? "unknown"}` } : {}),
  };
}

/**
 * Every live agent process, so Ctrl-C / SIGTERM on OmniNode reaches the whole
 * tree instead of orphaning children (roadmap §8, signal handling).
 */
const GLOBAL_RUNNING = new Set<ChildProcess>();
let signalForwardingInstalled = false;

function installSignalForwarding(): void {
  if (signalForwardingInstalled) return;
  signalForwardingInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const child of GLOBAL_RUNNING) {
        killTree(child, "SIGTERM");
      }
    });
  }
}

/** Kills a child and, on POSIX, its whole process group (roadmap §8 tree cleanup). */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone — fall through to direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

/** Human-readable exit reason, including signal terminations. */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return signal === "SIGKILL"
      ? "Process was killed (SIGKILL) — usually an external kill or OOM."
      : `Process terminated by signal ${signal}.`;
  }
  if (code === null) return "Process terminated without an exit code.";
  return `Process exited with code ${code}.`;
}

/**
 * Decodes a stdout/stderr chunk safely: invalid UTF-8 becomes replacement
 * characters and NUL bytes are stripped, so binary noise cannot poison the
 * protocol decoder or the terminal (roadmap §8, encoding hardening).
 */
export function sanitizeChunk(chunk: Buffer): string {
  return [...chunk.toString("utf8")].filter((char) => char.charCodeAt(0) !== 0).join("");
}

/** Normalizes a loose REPORT payload into a strict Report; drops malformed entries. */
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
