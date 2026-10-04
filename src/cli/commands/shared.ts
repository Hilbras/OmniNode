import { OmniNodeError } from "../../errors/index.js";

/** Shared helper for commands whose phase has not landed yet. */
export function notImplemented(command: string, when: string): OmniNodeError {
  return new OmniNodeError(
    "NOT_IMPLEMENTED",
    `${command} is planned for ${when}. Edit omninode.yaml directly for now.`,
  );
}
