/** Leveled logger with a pluggable sink and child loggers (§4.1 — logging). */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(level: LogLevel, line: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface WritableLike {
  write(chunk: string): unknown;
}

export class ConsoleLogSink implements LogSink {
  constructor(private readonly stream: WritableLike = process.stderr) {}

  write(_level: LogLevel, line: string): void {
    this.stream.write(line + "\n");
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  /** Structured fields attached to every line, e.g. { component: "config" }. */
  context?: Record<string, unknown>;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly context: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? new ConsoleLogSink();
    this.context = options.context ?? {};
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      context: { ...this.context, ...context },
    });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const parts = [new Date().toISOString(), level.toUpperCase(), message];
    const merged = { ...this.context, ...data };
    if (Object.keys(merged).length > 0) {
      parts.push(JSON.stringify(merged));
    }
    this.sink.write(level, parts.join(" "));
  }
}

/** Default application logger. Writes to stderr so stdout stays clean for CLI output. */
export const logger = new Logger();
