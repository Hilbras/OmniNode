import type { Command } from "commander";
import { loadConfig } from "../../config/index.js";
import { createMemoryProvider, MemoryService } from "../../memory/index.js";
import { truncate } from "./shared.js";

export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description("Inspect and manage persistent project memory (§19–§20).");

  memory
    .command("status")
    .description("Show the active memory provider and how much is stored.")
    .action(async () => {
      const config = loadConfig();
      const configured = config.project.memory?.provider ?? "local (default — add a `memory:` section to opt in)";
      const svc = new MemoryService(createMemoryProvider(config.project.memory));
      const entries = await svc.providerRef.query({ limit: 10_000 });
      console.log(`provider: ${configured}`);
      console.log(`entries:  ${entries.length}`);
      const scopes = new Map<string, number>();
      for (const entry of entries) {
        scopes.set(entry.scope, (scopes.get(entry.scope) ?? 0) + 1);
      }
      for (const [scope, count] of [...scopes.entries()].sort()) {
        console.log(`  ${scope}: ${count}`);
      }
    });

  memory
    .command("query <text>")
    .description("Search memory for entries relevant to the text.")
    .option("-s, --scope <scope>", "Restrict to a scope: project, task, role or knowledge.")
    .option("-n, --limit <count>", "Maximum entries to return.", (value: string) => Number(value), 10)
    .action(async (text: string, options: { scope?: string; limit: number }) => {
      const config = loadConfig();
      const svc = new MemoryService(createMemoryProvider(config.project.memory));
      const entries = await svc.providerRef.query({
        text,
        ...(options.scope !== undefined ? { scope: options.scope as "project" | "task" | "role" | "knowledge" } : {}),
        limit: options.limit,
      });
      if (entries.length === 0) {
        console.log("No relevant memory found.");
        return;
      }
      for (const entry of entries) {
        console.log(`[${entry.scope}] ${entry.key}`);
        console.log(`  ${truncate(entry.content.replace(/\n/g, " "), 120)}`);
      }
    });

  memory
    .command("write <text>")
    .description("Write an entry to memory.")
    .option("-s, --scope <scope>", "Memory scope: project, task, role or knowledge.", "project")
    .option("-t, --tags <tags>", "Comma-separated tags.", (value: string) =>
      value.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    )
    .option("-k, --key <key>", "Entry key (defaults to a generated note key).")
    .action(async (text: string, options: { scope: string; tags?: string[]; key?: string }) => {
      const config = loadConfig();
      const svc = new MemoryService(createMemoryProvider(config.project.memory));
      const key = options.key ?? `note:${Date.now().toString(36)}`;
      await svc.providerRef.write({
        key,
        scope: options.scope as "project" | "task" | "role" | "knowledge",
        content: text,
        ...(options.tags !== undefined && options.tags.length > 0 ? { tags: options.tags } : {}),
      });
      console.log(`Stored memory entry "${key}" (${options.scope}).`);
    });
}
