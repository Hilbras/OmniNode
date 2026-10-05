import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { migrateProjectStores, SCHEMA_VERSION, type MigrationReport } from "../../persistence/index.js";
import {
  findConfigV1Patterns,
  applyConfigMigration,
  type ConfigMigrationFinding,
} from "../../config/index.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description(
      `Inspect and upgrade persisted store files (schema v${SCHEMA_VERSION}) and migrate v1 configuration patterns.`,
    )
    .option("--check", "Only report what would change; do not write.")
    .action(async (options: { check?: boolean }) => {
      let changed = 0;

      console.log("storage:");
      const storageReports: MigrationReport[] = await migrateProjectStores(
        `${process.cwd()}/.omninode`,
        { checkOnly: options.check ?? false },
      );
      for (const report of storageReports) {
        if (report.migrated || report.state === "v1-legacy") changed += 1;
        const detail =
          report.state === "corrupt"
            ? `  (corrupt: ${report.note})`
            : report.state === "future"
              ? `  (${report.note})`
              : report.state === "v1-legacy"
                ? `  ${report.migrated ? "migrated" : "would migrate"} ${report.before ?? 0} → ${report.after ?? 0} item(s)`
                : report.state === "current"
                  ? `  ${report.after ?? 0} item(s)`
                  : "";
        console.log(`  ${report.file.padEnd(16)} ${report.state}${detail}`);
      }

      console.log("configuration:");
      const configPath = `${process.cwd()}/omninode.yaml`;
      let configFindings: ConfigMigrationFinding[] = [];
      try {
        readFileSync(configPath, "utf8"); // presence check
        configFindings = findConfigV1Patterns(configPath);
        if (configFindings.length === 0) {
          console.log("  omninode.yaml    current (no v1 patterns)");
        } else {
          for (const finding of configFindings) {
            console.log(`  omninode.yaml    ${finding.change} (${finding.path})`);
          }
          if (!options.check) {
            applyConfigMigration(configPath);
            console.log(`  omninode.yaml    migrated ${configFindings.length} pattern(s)`);
          }
          changed += 1;
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }

      const suffix = options.check ? " (dry run)" : "";
      console.log(
        changed === 0
          ? `\nEverything is at the v2 shape${suffix}.`
          : `\n${changed} item(s) ${options.check ? "would be migrated" : "migrated"} to the v2 shape${suffix}.`,
      );
    });
}
