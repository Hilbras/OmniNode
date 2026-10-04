import { describe, expect, it } from "vitest";
import { ConsoleLogSink, Logger, type LogSink, type LogLevel } from "../src/logger/index.js";

class MemorySink implements LogSink {
  readonly lines: string[] = [];

  write(_level: LogLevel, line: string): void {
    this.lines.push(line);
  }
}

describe("Logger", () => {
  it("writes messages through the sink", () => {
    const sink = new MemorySink();
    const log = new Logger({ sink });
    log.info("hello", { key: "value" });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain("INFO hello");
    expect(sink.lines[0]).toContain('"key":"value"');
  });

  it("filters messages below the configured level", () => {
    const sink = new MemorySink();
    const log = new Logger({ sink, level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(sink.lines).toHaveLength(2);
    expect(sink.lines[0]).toContain("WARN w");
    expect(sink.lines[1]).toContain("ERROR e");
  });

  it("merges child context into every line", () => {
    const sink = new MemorySink();
    const log = new Logger({ sink }).child({ component: "config" });
    log.info("loaded");
    expect(sink.lines[0]).toContain('"component":"config"');
    log.info("again", { extra: true });
    expect(sink.lines[1]).toContain('"component":"config"');
    expect(sink.lines[1]).toContain('"extra":true');
  });

  it("omits the JSON suffix when there is no data", () => {
    const sink = new MemorySink();
    const log = new Logger({ sink });
    log.info("bare");
    expect(sink.lines[0]).not.toContain("{");
  });

  it("ConsoleLogSink writes to the given stream", () => {
    const chunks: string[] = [];
    const sink = new ConsoleLogSink({ write: (chunk: string) => chunks.push(chunk) });
    sink.write("info", "line");
    expect(chunks).toEqual(["line\n"]);
  });
});
