/**
 * Working-directory validation for agent processes (roadmap §8): existence,
 * directory-ness, access, path normalization and project boundaries.
 */
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { AgentError } from "../errors/index.js";

export interface CwdValidation {
  /** Normalized absolute path. */
  cwd: string;
  /** True when the directory sits outside the project root (project boundary). */
  outsideProject: boolean;
}

export function validateWorkingDirectory(
  cwd: string | undefined,
  options: { projectRoot?: string; allowExternal?: boolean } = {},
): CwdValidation | undefined {
  if (!cwd) return undefined;

  const normalized = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
  let stats;
  try {
    stats = statSync(normalized);
  } catch (error) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `Working directory "${normalized}" does not exist or is not accessible.`,
      { cause: error, details: { cwd: normalized } },
    );
  }
  if (!stats.isDirectory()) {
    throw new AgentError("AGENT_NOT_FOUND", `Working directory "${normalized}" is not a directory.`, {
      details: { cwd: normalized },
    });
  }
  // Access check: attempt to list it.
  try {
    statSync(resolve(normalized, "."));
  } catch (error) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `Working directory "${normalized}" is not accessible.`,
      { cause: error },
    );
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const rel = relative(projectRoot, normalized);
  const outsideProject = rel.startsWith("..") || isAbsolute(rel);
  if (outsideProject && options.allowExternal !== true) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `Working directory "${normalized}" is outside the project root "${projectRoot}". ` +
        `Set allow_external_cwd: true on the agent to permit this.`,
      { details: { cwd: normalized, projectRoot } },
    );
  }
  return { cwd: normalized, outsideProject };
}