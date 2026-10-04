/** Typed error hierarchy shared across the whole codebase (§4.1 — error model). */

export type OmniNodeErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH_FAILED"
  | "MODEL_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_FAILED"
  | "AGENT_TIMEOUT"
  | "TASK_INVALID"
  | "TASK_NOT_FOUND"
  | "TASK_FAILED"
  | "PIPELINE_NOT_FOUND"
  | "PIPELINE_INVALID"
  | "PIPELINE_FAILED"
  | "PROTOCOL_VIOLATION"
  | "MEMORY_UNAVAILABLE"
  | "REPORT_NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "CLI_USAGE"
  | "INTERNAL";

export interface OmniNodeErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class OmniNodeError extends Error {
  readonly code: OmniNodeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: OmniNodeErrorCode, message: string, options: OmniNodeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }
}

export class ConfigError extends OmniNodeError {
  constructor(
    code: "CONFIG_NOT_FOUND" | "CONFIG_INVALID",
    message: string,
    options: OmniNodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class ProviderError extends OmniNodeError {
  constructor(
    code:
      | "PROVIDER_NOT_FOUND"
      | "PROVIDER_UNAVAILABLE"
      | "PROVIDER_AUTH_FAILED"
      | "MODEL_NOT_FOUND",
    message: string,
    options: OmniNodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class AgentError extends OmniNodeError {
  constructor(
    code: "AGENT_NOT_FOUND" | "AGENT_FAILED" | "AGENT_TIMEOUT",
    message: string,
    options: OmniNodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class TaskError extends OmniNodeError {
  constructor(
    code: "TASK_INVALID" | "TASK_NOT_FOUND" | "TASK_FAILED",
    message: string,
    options: OmniNodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class PipelineError extends OmniNodeError {
  constructor(
    code: "PIPELINE_NOT_FOUND" | "PIPELINE_INVALID" | "PIPELINE_FAILED",
    message: string,
    options: OmniNodeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class ProtocolError extends OmniNodeError {
  constructor(message: string, options: OmniNodeErrorOptions = {}) {
    super("PROTOCOL_VIOLATION", message, options);
  }
}

export class MemoryError extends OmniNodeError {
  constructor(message: string, options: OmniNodeErrorOptions = {}) {
    super("MEMORY_UNAVAILABLE", message, options);
  }
}

export function isOmniNodeError(value: unknown): value is OmniNodeError {
  return value instanceof OmniNodeError;
}
