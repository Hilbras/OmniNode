/**
 * CLI exit codes (roadmap §19). Stable, documented, and mapped from the
 * typed error hierarchy so scripts can branch on failure class.
 */
import { isOmniNodeError } from "../errors/index.js";

export const EXIT = {
  success: 0,
  general: 1,
  invalidInput: 2,
  config: 3,
  provider: 4,
  agent: 5,
  timeout: 6,
  cancelled: 7,
  notFound: 8,
  notImplemented: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Maps an OmniNode error to its documented exit code. */
export function exitCodeFor(error: unknown): number {
  if (!isOmniNodeError(error)) return EXIT.general;
  const code = error.code;
  if (code === "NOT_IMPLEMENTED") return EXIT.notImplemented;
  if (code === "AGENT_TIMEOUT") return EXIT.timeout;
  if (code.startsWith("CONFIG_")) return EXIT.config;
  if (code.startsWith("PROVIDER_") || code === "MODEL_NOT_FOUND") return EXIT.provider;
  if (code.startsWith("AGENT_")) return EXIT.agent;
  if (code.endsWith("_NOT_FOUND")) return EXIT.notFound;
  if (code.endsWith("_INVALID") || code === "CLI_USAGE" || code === "PROTOCOL_VIOLATION") {
    return EXIT.invalidInput;
  }
  return EXIT.general;
}

/** Exit codes returned when a task/pipeline ends in a non-success terminal state. */
export function exitCodeForStatus(status: string): number {
  switch (status) {
    case "completed":
      return EXIT.success;
    case "cancelled":
      return EXIT.cancelled;
    case "timed_out":
      return EXIT.timeout;
    case "failed":
      return EXIT.general;
    default:
      // partial / unknown / queued / running are not failures of the CLI call
      return EXIT.success;
  }
}
