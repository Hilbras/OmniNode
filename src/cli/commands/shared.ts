import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { appConfigSchema, findConfigFile } from "../../config/index.js";
import { ConfigError, OmniNodeError } from "../../errors/index.js";

/** Shared helper for commands whose phase has not landed yet. */
export function notImplemented(command: string, when: string): OmniNodeError {
  return new OmniNodeError(
    "NOT_IMPLEMENTED",
    `${command} is planned for ${when}. Edit omninode.yaml directly for now.`,
  );
}

/**
 * Appends an item to a list in omninode.yaml, preserving comments and
 * formatting, and validates the resulting document before writing.
 * Returns the config path that was edited.
 */
export function appendToConfigList(listKey: "providers" | "agents", item: unknown): string {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new OmniNodeError("CONFIG_NOT_FOUND", "No omninode.yaml found. Run `omninode init` first.");
  }

  // Edit as a YAML document so existing comments and formatting survive.
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (doc.getIn(["project", listKey]) === undefined) {
    doc.setIn(["project", listKey], [item]);
  } else {
    doc.addIn(["project", listKey], item);
  }

  const validated = appConfigSchema.safeParse(doc.toJS());
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(
      "CONFIG_INVALID",
      `Editing ${configPath} would produce an invalid configuration: ${issues}`,
    );
  }

  writeFileSync(configPath, doc.toString(), "utf8");
  return configPath;
}
