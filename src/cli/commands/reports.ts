import type { Command } from "commander";
import { notImplemented } from "./shared.js";

export function registerReportCommands(program: Command): void {
  const report = program
    .command("report")
    .description("Inspect AI reports (Phase 6+).");

  report
    .command("list")
    .description("List collected reports (planned for Phase 6 — Multi-AI Report System).")
    .action(() => {
      throw notImplemented("omninode report list", "Phase 6 (Multi-AI Report System)");
    });
}
