/**
 * Remembera memory provider (§19): the preferred Hilbras memory integration,
 * reached over HTTP. Remembera is strictly optional — the core also runs with
 * the local memory provider or none at all (§2).
 *
 * API convention assumed by this adapter (adjust here if the real API differs):
 *   write: POST {baseUrl}/api/memory      body: MemoryEntry JSON → 2xx
 *   query: POST {baseUrl}/api/memory/query body: MemoryQuery JSON → { entries: MemoryEntry[] }
 */
import { MemoryError } from "../errors/index.js";
import { logger, type Logger } from "../logger/index.js";
import { resolveApiKey } from "../providers/auth.js";
import { requestJson } from "../providers/http.js";
import type { IMemoryProvider, MemoryEntry, MemoryQuery } from "../types/memory.js";

export interface RememberaConfig {
  baseUrl: string;
  apiKeyEnvVar?: string;
  env?: Record<string, string | undefined>;
}

export class RememberaMemoryProvider implements IMemoryProvider {
  readonly name = "remembera";
  private readonly baseUrl: string;
  private readonly apiKeyEnvVar?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly log: Logger;

  constructor(config: RememberaConfig, log: Logger = logger) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnvVar = config.apiKeyEnvVar;
    this.env = config.env ?? process.env;
    this.log = log.child({ component: "remembera" });
  }

  private headers(): Record<string, string> {
    const key = this.apiKeyEnvVar
      ? resolveApiKey({ name: "remembera", apiKeyEnvVar: this.apiKeyEnvVar }, this.env)
      : undefined;
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const { status, body } = await this.request(`${this.baseUrl}/api/memory/query`, query);
    if (status !== 200) {
      throw new MemoryError(`Remembera query returned HTTP ${status}.`);
    }
    const entries = (body as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      throw new MemoryError("Remembera query response had no entries array.");
    }
    return entries.map((entry) => this.toEntry(entry)).filter((entry): entry is MemoryEntry => entry !== undefined);
  }

  async write(entry: MemoryEntry): Promise<void> {
    const { status } = await this.request(`${this.baseUrl}/api/memory`, entry);
    if (status !== 200 && status !== 201) {
      throw new MemoryError(`Remembera write returned HTTP ${status}.`);
    }
  }

  private async request(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    // Resolved outside the try so auth failures propagate as-is.
    const headers = this.headers();
    try {
      return await requestJson(url, {
        method: "POST",
        headers,
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MemoryError(`Remembera request to ${url} failed: ${message}`, { cause: error });
    }
  }

  private toEntry(raw: unknown): MemoryEntry | undefined {
    if (raw === null || typeof raw !== "object") {
      this.log.warn("Skipping malformed Remembera memory entry.");
      return undefined;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.key !== "string" || typeof entry.content !== "string") {
      this.log.warn("Skipping Remembera memory entry without key/content.");
      return undefined;
    }
    const scope = entry.scope;
    return {
      key: entry.key,
      content: entry.content,
      scope:
        scope === "project" || scope === "role" || scope === "task" || scope === "knowledge"
          ? scope
          : "knowledge",
      ...(Array.isArray(entry.tags) ? { tags: entry.tags.filter((t): t is string => typeof t === "string") } : {}),
      ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}),
      ...(typeof entry.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
    };
  }
}
