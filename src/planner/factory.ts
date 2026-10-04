/** Planner factory from project configuration (§18 — planner provider support). */
import { ConfigError } from "../errors/index.js";
import type { AppConfig } from "../config/index.js";
import type { ChatFn } from "../types/chat.js";
import { HeuristicPlanner } from "./heuristic.js";
import { ModelPlanner } from "./model.js";
import type { IPlanner } from "./types.js";
import { logger, type Logger } from "../logger/index.js";

export function buildPlanner(
  plannerConfig: AppConfig["project"]["planner"],
  chat: ChatFn,
  log: Logger = logger,
): IPlanner | undefined {
  if (!plannerConfig) return undefined;
  if (plannerConfig.kind === "heuristic") {
    return new HeuristicPlanner();
  }
  if (!plannerConfig.model) {
    throw new ConfigError(
      "CONFIG_INVALID",
      'Planner kind "model" needs a model reference ("provider:model-id") in omninode.yaml.',
    );
  }
  return new ModelPlanner({
    model: plannerConfig.model,
    chat,
    ...(plannerConfig.instruction !== undefined ? { instruction: plannerConfig.instruction } : {}),
    fallback: new HeuristicPlanner(),
    log,
  });
}
