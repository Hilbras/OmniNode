/**
 * Configuration migration (roadmap §23): rewrites v1-isms in omninode.yaml
 * to their v2 equivalents, preserving comments and formatting. Safe by
 * construction: the result is schema-validated before the file is written.
 *
 * Rewrites applied:
 *   - `inherit_env: false`          → `env_policy: explicit`
 *   - agents without `input_mode`   → `input_mode: stdin` (explicit)
 *   - memory without `provider`     → `provider: local` (explicit)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { appConfigSchema } from "./schema.js";
import { ConfigError } from "../errors/index.js";

export interface ConfigMigrationFinding {
  path: string;
  change: string;
}

export interface ConfigMigrationResult {
  file: string;
  findings: ConfigMigrationFinding[];
  applied: boolean;
}

/** Detects v1-isms without modifying anything (the `--check` view). */
export function findConfigV1Patterns(path: string): ConfigMigrationFinding[] {
  const doc = parseDocument(readFileSync(path, "utf8"));
  const findings: ConfigMigrationFinding[] = [];

  const agents = doc.getIn(["project", "agents"]);
  const agentCount = agents ? Number(doc.getIn(["project", "agents", "length"]) ?? 0) : 0;
  for (let index = 0; index < agentCount; index += 1) {
    const prefix = `project.agents.${index}`;
    if (doc.getIn(["project", "agents", index, "inherit_env"]) === false) {
      findings.push({ path: `${prefix}.inherit_env`, change: "inherit_env: false → env_policy: explicit" });
    }
    if (doc.getIn(["project", "agents", index, "input_mode"]) === undefined) {
      findings.push({ path: `${prefix}.input_mode`, change: "implicit input_mode → input_mode: stdin" });
    }
  }

  // Only when the user configured memory at all — adding a whole memory
  // section would silently enable it for projects that opted out (§12).
  const memorySection = doc.getIn(["project", "memory"]);
  if (memorySection && doc.getIn(["project", "memory", "provider"]) === undefined) {
    findings.push({ path: "project.memory.provider", change: "implicit provider → provider: local" });
  }

  return findings;
}

/** Applies the rewrites, schema-validates the result, and writes the file. */
export function applyConfigMigration(path: string): ConfigMigrationResult {
  const findings = findConfigV1Patterns(path);
  if (findings.length === 0) {
    return { file: path, findings, applied: false };
  }

  const doc = parseDocument(readFileSync(path, "utf8"));
  const agentCount = Number(doc.getIn(["project", "agents", "length"]) ?? 0);
  for (let index = 0; index < agentCount; index += 1) {
    const prefix = ["project", "agents", index];
    if (doc.getIn([...prefix, "inherit_env"]) === false) {
      doc.deleteIn([...prefix, "inherit_env"]);
      doc.setIn([...prefix, "env_policy"], "explicit");
    }
    if (doc.getIn([...prefix, "input_mode"]) === undefined) {
      doc.setIn([...prefix, "input_mode"], "stdin");
    }
  }
  const memorySection = doc.getIn(["project", "memory"]);
  if (memorySection && doc.getIn(["project", "memory", "provider"]) === undefined) {
    doc.setIn(["project", "memory", "provider"], "local");
  }

  const validated = appConfigSchema.safeParse(doc.toJS());
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(
      "CONFIG_INVALID",
      `Migrating ${path} would produce an invalid configuration: ${issues}`,
    );
  }

  writeFileSync(path, doc.toString(), "utf8");
  return { file: path, findings, applied: true };
}
