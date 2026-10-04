import type { Command } from "commander";
import { migrateProjectStores, SCHEMA_VERSION } from "../../persistence/index.js";

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description(
      `Inspect and upgrade persisted store files to schema v${SCHEMA_VERSION} (v1 data is migrated in place).`,
    )
    .option("--check", "Only report what would change; do not write.")
    .action(async (options: { check?: boolean }) => {
      const reports = await migrateProjectStores(`${process.cwd()}/.omninode`, {
        checkOnly: options.check ?? false,
      });
      let changed = 0;
      for (const report of reports) {
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
        console.log(`${report.file.padEnd(16)} ${report.state}${detail}`);
      }
      console.log(
        changed === 0
          ? `All stores are at schema v${SCHEMA_VERSION}.`
          : `${options.check ? "Would migrate" : "Migrated"} ${changed} store file(s) to schema v${SCHEMA_VERSION}.`,
      );
    });
}
