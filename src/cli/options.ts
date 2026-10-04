/**
 * CLI-level configuration options (roadmap §16 precedence: CLI arguments
 * sit above environment variables, project file, user file and defaults).
 */
import { findConfigFile, loadConfigDetailed, type AppConfig } from "../config/index.js";

export const cliConfigOptions: { path?: string; profile?: string } = {};

/** Loads the project configuration honoring --config / --profile. */
export function loadProjectConfig(): AppConfig {
  return loadConfigDetailed({
    ...(cliConfigOptions.path !== undefined ? { path: cliConfigOptions.path } : {}),
    ...(cliConfigOptions.profile !== undefined ? { profile: cliConfigOptions.profile } : {}),
  }).config;
}

/** The configuration file in effect (explicit --config wins). */
export function activeConfigPath(): string | undefined {
  return cliConfigOptions.path ?? findConfigFile();
}
