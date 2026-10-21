/**
 * Agent adapter registry + factory coverage (roadmap §8 native adapters, §9–§10).
 *
 * The adapter registry is the extension seam for native/API-level integrations,
 * so every lookup path is pinned here: a registered adapter, an unknown
 * integration, an empty registry, a replaced adapter, and the factory's
 * validation and NOT_IMPLEMENTED branches — plus the default adapter set that
 * ships with the library.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentAdapterRegistry, ProcessAgentAdapter } from "../src/agents/adapters.js";
import { buildAgentRegistry, createAgent, defaultAgentAdapters } from "../src/agents/factory.js";
import { ProcessAgent } from "../src/agents/process/index.js";
import type { AppConfig } from "../src/config/index.js";
import { AgentError, ConfigError } from "../src/errors/index.js";
import { Logger, type LogLevel, type LogSink } from "../src/logger/index.js";
import type { AgentConfig, AgentIntegrationType, IAgent } from "../src/types/agent.js";

/** The adapter ids the library ships with. */
const DEFAULT_ADAPTER_IDS = defaultAgentAdapters.list().map((adapter) => adapter.integration);

/** A stand-in agent: records the task it was asked to run. */
function stubAgent(name: string, integration: AgentIntegrationType = "native"): IAgent {
  return {
    info: { name, integration, status: "ready" },
    async run(input) {
      return { taskId: input.taskId, status: "completed", summary: `${name} ran ${input.taskId}` };
    },
  };
}

/** Collects log lines so a warning can be asserted on. */
class RecordingSink implements LogSink {
  readonly lines: { level: LogLevel; line: string }[] = [];

  write(level: LogLevel, line: string): void {
    this.lines.push({ level, line });
  }
}

/** Minimal project config carrying only the agents the factory reads. */
function appConfig(agents: AgentConfig[]): AppConfig {
  return {
    project: {
      name: "adapter-test",
      providers: [],
      agents,
      roles: [],
      pipelines: [],
    },
  };
}

describe("AgentAdapterRegistry — lookup paths", () => {
  it("registers adapters under their integration id and lists them in insertion order", () => {
    const registry = new AgentAdapterRegistry();
    const process = { integration: "process", create: () => stubAgent("p", "process") };
    const native = { integration: "native", create: () => stubAgent("n") };

    registry.register(process);
    registry.register(native);

    expect(registry.list()).toEqual([process, native]);
    expect(registry.get("native")).toBe(native);
    expect(registry.get("process")).toBe(process);
  });

  it("returns undefined for an integration that was never registered", () => {
    const registry = new AgentAdapterRegistry();
    registry.register({ integration: "process", create: () => stubAgent("p", "process") });
    expect(registry.get("native")).toBeUndefined();
  });

  it("replaces the adapter when the same integration is registered twice", () => {
    const registry = new AgentAdapterRegistry();
    const first = { integration: "native", create: () => stubAgent("first") };
    const second = { integration: "native", create: () => stubAgent("second") };

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("native")).toBe(second);
    expect(registry.create({ name: "x", integration: "native" }).info.name).toBe("second");
  });

  it("create hands the config to the registered adapter and returns its agent", () => {
    const registry = new AgentAdapterRegistry();
    const seen: AgentConfig[] = [];
    registry.register({
      integration: "native",
      create: (config) => {
        seen.push(config);
        return stubAgent("native-agent");
      },
    });

    const config: AgentConfig = { name: "native-agent", integration: "native" };
    const agent = registry.create(config);

    expect(agent.info.name).toBe("native-agent");
    expect(seen).toEqual([config]);
  });

  it("create throws AGENT_NOT_FOUND and names the registered integrations", () => {
    const registry = new AgentAdapterRegistry();
    registry.register({ integration: "process", create: () => stubAgent("p", "process") });

    let caught: unknown;
    try {
      registry.create({ name: "x", integration: "native" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect(caught).toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect((caught as Error).message).toContain(
      'No agent adapter registered for integration "native"',
    );
    expect((caught as Error).message).toContain("Registered: process");
  });

  it("create reports (none) when the registry is empty", () => {
    const registry = new AgentAdapterRegistry();

    let caught: unknown;
    try {
      registry.create({ name: "x", integration: "native" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as Error).message).toContain("Registered: (none)");
  });
});

describe("ProcessAgentAdapter", () => {
  it("serves the process integration and delegates to the injected factory", () => {
    const seen: AgentConfig[] = [];
    const adapter = new ProcessAgentAdapter((config) => {
      seen.push(config);
      return stubAgent("worker", "process");
    });

    expect(adapter.integration).toBe("process");

    const config: AgentConfig = { name: "worker", integration: "process", command: "node" };
    const agent = adapter.create(config);

    expect(agent.info.name).toBe("worker");
    expect(seen).toEqual([config]);
  });
});

describe("default adapter set", () => {
  it("ships exactly the built-in process adapter", () => {
    expect(DEFAULT_ADAPTER_IDS).toEqual(["process"]);
    expect(defaultAgentAdapters.get("process")).toBeInstanceOf(ProcessAgentAdapter);
    expect(defaultAgentAdapters.list().map((adapter) => adapter.integration)).toContain("process");
  });
});

describe("createAgent — validation", () => {
  it("builds a ProcessAgent through the default adapter set", () => {
    const agent = createAgent({ name: "worker", integration: "process", command: "node" });
    expect(agent).toBeInstanceOf(ProcessAgent);
    expect(agent.info.name).toBe("worker");
    expect(agent.info.integration).toBe("process");
  });

  it("prefers a caller-supplied adapter registry over the default set", () => {
    const adapters = new AgentAdapterRegistry();
    const stub = stubAgent("stubbed", "process");
    adapters.register({ integration: "process", create: () => stub });

    const agent = createAgent({ name: "worker", integration: "process", command: "node" }, adapters);

    expect(agent).toBe(stub);
    expect(agent).not.toBeInstanceOf(ProcessAgent);
  });

  it("rejects an empty agent name", () => {
    let caught: unknown;
    try {
      createAgent({ name: "", integration: "process", command: "node" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({ code: "CONFIG_INVALID" });
    expect((caught as Error).message).toBe("Agent name must not be empty.");
  });

  it("rejects a whitespace-only agent name", () => {
    expect(() => createAgent({ name: "   ", integration: "native" })).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("Agent name must not be empty."),
      }),
    );
  });

  it("rejects a process agent without a command", () => {
    expect(() => createAgent({ name: "worker", integration: "process" })).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: expect.stringContaining('Agent "worker" needs a command for the process adapter.'),
      }),
    );
  });

  it("rejects a process agent whose command is only whitespace", () => {
    expect(() => createAgent({ name: "worker", integration: "process", command: "   " })).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("needs a command for the process adapter"),
      }),
    );
  });
});

describe("createAgent — unsupported integrations", () => {
  it("uses a registered native adapter instead of throwing", () => {
    const adapters = new AgentAdapterRegistry();
    const stub = stubAgent("native-agent");
    adapters.register({ integration: "native", create: () => stub });

    expect(createAgent({ name: "native-agent", integration: "native" }, adapters)).toBe(stub);
  });

  it("reports NOT_IMPLEMENTED for a native integration with no adapter", () => {
    expect(() => createAgent({ name: "n", integration: "native" }, new AgentAdapterRegistry())).toThrow(
      expect.objectContaining({
        code: "NOT_IMPLEMENTED",
        message: expect.stringContaining("No native adapter is registered"),
      }),
    );
  });

  it("reports NOT_IMPLEMENTED for an integration that has no adapter yet", () => {
    expect(() => createAgent({ name: "c", integration: "custom" }, new AgentAdapterRegistry())).toThrow(
      expect.objectContaining({
        code: "NOT_IMPLEMENTED",
        message: expect.stringContaining('Agent integration "custom" has no adapter yet.'),
      }),
    );
  });
});

describe("buildAgentRegistry", () => {
  it("registers every agent that can be constructed", () => {
    const sink = new RecordingSink();
    const registry = buildAgentRegistry(
      appConfig([
        { name: "beta", integration: "process", command: "node" },
        { name: "alpha", integration: "process", command: "node" },
      ]),
      new Logger({ sink }),
    );

    expect(registry.list().map((agent) => agent.info.name)).toEqual(["alpha", "beta"]);
    expect(registry.get("alpha")).toBeInstanceOf(ProcessAgent);
    expect(sink.lines).toEqual([]);
  });

  it("skips agents that fail to construct and warns about each one", () => {
    const sink = new RecordingSink();
    const registry = buildAgentRegistry(
      appConfig([
        { name: "good", integration: "process", command: "node" },
        { name: "broken", integration: "process" },
      ]),
      new Logger({ sink }),
    );

    expect(registry.list().map((agent) => agent.info.name)).toEqual(["good"]);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.level).toBe("warn");
    expect(sink.lines[0]?.line).toContain('Skipping agent "broken"');
    expect(sink.lines[0]?.line).toContain("needs a command for the process adapter");
  });

  it("warns through the default logger when no logger is supplied", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let written = "";
    try {
      const registry = buildAgentRegistry(
        appConfig([{ name: "broken", integration: "process" }]),
      );
      expect(registry.list()).toEqual([]);
      written = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stderr.mockRestore();
    }

    expect(written).toContain('Skipping agent "broken"');
  });

  it("stringifies a non-Error failure instead of losing it", () => {
    // The default registry only knows the process integration, so the lookup
    // is stubbed to observe how a non-Error failure is reported.
    const get = vi.spyOn(defaultAgentAdapters, "get").mockImplementation((integration) =>
      integration === "native"
        ? {
            integration: "native",
            create: () => {
              throw "agent exploded";
            },
          }
        : undefined,
    );

    try {
      const sink = new RecordingSink();
      const registry = buildAgentRegistry(
        appConfig([{ name: "exploding", integration: "native" }]),
        new Logger({ sink }),
      );

      expect(registry.list()).toEqual([]);
      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]?.line).toContain('Skipping agent "exploding": agent exploded');
    } finally {
      get.mockRestore();
    }

    // The shared default registry is left exactly as the library shipped it.
    expect(defaultAgentAdapters.list().map((adapter) => adapter.integration)).toEqual(
      DEFAULT_ADAPTER_IDS,
    );
  });
});
