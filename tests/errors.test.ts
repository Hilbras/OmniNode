import { describe, expect, it } from "vitest";
import {
  AgentError,
  ConfigError,
  OmniNodeError,
  isOmniNodeError,
} from "../src/errors/index.js";

describe("OmniNodeError", () => {
  it("carries a code and details", () => {
    const error = new OmniNodeError("INTERNAL", "boom", { details: { a: 1 } });
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("boom");
    expect(error.details).toEqual({ a: 1 });
    expect(error.name).toBe("OmniNodeError");
  });

  it("preserves the cause chain", () => {
    const cause = new Error("root cause");
    const error = new ConfigError("CONFIG_INVALID", "bad config", { cause });
    expect(error.cause).toBe(cause);
  });

  it("subclasses keep their own name and specific codes", () => {
    const error = new AgentError("AGENT_TIMEOUT", "agent took too long");
    expect(error).toBeInstanceOf(OmniNodeError);
    expect(error.name).toBe("AgentError");
    expect(error.code).toBe("AGENT_TIMEOUT");
  });

  it("isOmniNodeError narrows unknown values", () => {
    expect(isOmniNodeError(new ConfigError("CONFIG_NOT_FOUND", "nope"))).toBe(true);
    expect(isOmniNodeError(new Error("plain"))).toBe(false);
    expect(isOmniNodeError("string")).toBe(false);
  });
});
