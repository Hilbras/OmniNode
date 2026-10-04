import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandEnvRefs, findConfigFile, loadConfig } from "../src/config/index.js";
import { ConfigError } from "../src/errors/index.js";

function tmpConfig(content: string, filename = "omninode.yaml"): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "omninode-config-"));
  const file = path.join(dir, filename);
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const validConfig = `
project:
  name: Test Project
  providers:
    - name: my-gateway
      type: openai-compatible
      base_url: https://example.com/v1
      api_key_env_var: MY_API_KEY
  agents:
    - name: opencode
      type: cli
      command: opencode
  roles:
    - id: planner
      name: Planner
      responsibilities:
        - produce a plan
`;

describe("expandEnvRefs", () => {
  it("replaces references from the provided environment", () => {
    expect(expandEnvRefs("key: ${TOKEN}", { TOKEN: "abc" })).toBe("key: abc");
  });

  it("supports ${VAR:-fallback} defaults", () => {
    expect(expandEnvRefs("port: ${MISSING_PORT:-8080}", {})).toBe("port: 8080");
  });

  it("throws a ConfigError when a referenced variable is unset", () => {
    expect(() => expandEnvRefs("${TOTALLY_MISSING}", {})).toThrow(ConfigError);
  });

  it("leaves text without references untouched", () => {
    expect(expandEnvRefs("plain: value", {})).toBe("plain: value");
  });
});

describe("findConfigFile", () => {
  it("discovers omninode.yaml in a directory", () => {
    const { dir, file } = tmpConfig("project:\n  name: D\n");
    try {
      expect(findConfigFile(dir)).toBe(file);
    } finally {
      cleanup(dir);
    }
  });

  it("returns undefined when no config exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-empty-"));
    try {
      expect(findConfigFile(dir)).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });
});

describe("loadConfig", () => {
  it("loads and maps a valid config onto the core contracts", () => {
    const { dir, file } = tmpConfig(validConfig);
    try {
      const config = loadConfig({ path: file, env: { MY_API_KEY: "x" } });
      expect(config.project.name).toBe("Test Project");
      expect(config.project.providers).toHaveLength(1);
      expect(config.project.providers[0]?.baseUrl).toBe("https://example.com/v1");
      expect(config.project.providers[0]?.apiKeyEnvVar).toBe("MY_API_KEY");
      expect(config.project.agents[0]?.name).toBe("opencode");
      // "cli" agents map onto the process integration.
      expect(config.project.agents[0]?.integration).toBe("process");
      expect(config.project.roles[0]?.id).toBe("planner");
      expect(config.project.roles[0]?.responsibilities).toEqual(["produce a plan"]);
    } finally {
      cleanup(dir);
    }
  });

  it("applies defaults for missing collections", () => {
    const { dir, file } = tmpConfig("project:\n  name: Minimal\n");
    try {
      const config = loadConfig({ path: file });
      expect(config.project.providers).toEqual([]);
      expect(config.project.agents).toEqual([]);
      expect(config.project.roles).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it("expands ${ENV} references found in the file", () => {
    const { dir, file } = tmpConfig(
      "project:\n  name: ${PROJECT_NAME:-Fallback}\n",
    );
    try {
      const config = loadConfig({ path: file, env: {} });
      expect(config.project.name).toBe("Fallback");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects invalid configs with issue details", () => {
    const { dir, file } = tmpConfig("project:\n  providers:\n    - name: bad\n");
    try {
      expect(() => loadConfig({ path: file })).toThrow(ConfigError);
      try {
        loadConfig({ path: file });
      } catch (error) {
        expect((error as ConfigError).details).toBeDefined();
      }
    } finally {
      cleanup(dir);
    }
  });

  it("rejects unknown keys (typo protection)", () => {
    const { dir, file } = tmpConfig("project:\n  name: X\n  provirs: []\n");
    try {
      expect(() => loadConfig({ path: file })).toThrow(ConfigError);
    } finally {
      cleanup(dir);
    }
  });
});
