/**
 * v2 Phase 7 tests — OmniHilbras Integration v2 (roadmap §11):
 * provider metadata across the boundary, timeout handling, streaming where
 * supported, and the exit criterion that the core works with OmniHilbras
 * entirely absent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OmniHilbrasProvider } from "../src/providers/omnihilbras/index.js";
import { createProvider } from "../src/providers/factory.js";
import { ModelRegistry } from "../src/registry/index.js";
import type { ChatStreamChunk } from "../src/types/chat.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: string[] = [];
    req.on("data", (c) => chunks.push(String(c)));
    req.on("end", () => {
      const body = chunks.join("");
      if (req.url?.endsWith("/chat/completions") && body.includes('"stream":true')) {
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ model: "hb-model", choices: [{ delta: { content: "Hel" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model: "hb-model", choices: [{ delta: { content: "lo" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model: "hb-model", choices: [{ delta: { content: "!" }, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (req.url?.endsWith("/chat/completions")) {
        // A "slow-model" request is deliberately slow so provider timeouts fire.
        if (body.includes("slow-model")) {
          setTimeout(() => {
            if (!res.writableEnded) res.end("{}");
          }, 3000);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "hb-model", choices: [{ message: { content: "Hi!" } }] }));
        return;
      }
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            gateway: { version: "2.4.0", tier: "pro", region: "eu" },
            data: [{ id: "hb-model", context_length: 64_000 }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => vi.unstubAllGlobals());

function omnihilbrasProvider(extra: Record<string, unknown> = {}) {
  return new OmniHilbrasProvider({
    name: "hb",
    type: "omnihilbras",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ...extra,
  });
}

describe("OmniHilbras adapter (§11)", () => {
  it("captures gateway-level metadata and attaches it to models", async () => {
    const provider = omnihilbrasProvider();
    const models = await provider.listModels();
    expect(provider.gatewayMetadata()).toEqual({ version: "2.4.0", tier: "pro", region: "eu" });
    expect(models[0]?.metadata).toMatchObject({ gateway: { version: "2.4.0", tier: "pro" } });
  });

  it("inherits normalized model metadata from discovery", async () => {
    const [model] = await omnihilbrasProvider().listModels();
    expect(model).toMatchObject({ id: "hb-model", contextWindow: 64_000, provider: "hb" });
  });

  it("honors a provider-level timeout", async () => {
    const slow = new OmniHilbrasProvider({
      name: "hb",
      type: "omnihilbras",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 250,
    });
    await expect(
      slow.chat({ model: "slow-model", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { kind: "TIMEOUT" } });
  });

  it("streams completions through the shared SSE path", async () => {
    const provider = omnihilbrasProvider();
    const chunks: ChatStreamChunk[] = [];
    const response = await provider.stream!(
      { model: "hb-model", messages: [{ role: "user", content: "hi" }] },
      (chunk) => chunks.push(chunk),
    );
    expect(chunks.map((c) => c.delta).join("")).toBe("Hello!");
    expect(response.content).toBe("Hello!");
    expect(response.finishReason).toBe("stop");
  }, 15_000);

  it("connectAndRegister still runs the full plan flow", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omninode-hb-"));
    const registry = new ModelRegistry();
    const result = await omnihilbrasProvider().connectAndRegister(registry);
    expect(result.status.health).toBe("healthy");
    expect(result.registered).toBeGreaterThan(0);
    expect(registry.list()).not.toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

describe("separation: OmniNode works without OmniHilbras (§11 exit criterion)", () => {
  it("only the provider layer references OmniHilbras", () => {
    const root = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        const referencesHilbras = source.includes("omnihilbras") || source.includes("OmniHilbras");
        const allowed =
          full.includes(path.join("providers", "omnihilbras")) ||
          full.endsWith(path.join("providers", "factory.ts")) ||
          full.includes(path.join("config", "schema.ts")) || // the type union + config schema
          full.includes(path.join("config", "loader.ts")) ||
          full.endsWith(path.join("cli", "commands", "providers.ts")) || // CLI lists the type
          full.endsWith(path.join("providers", "index.ts")) || // barrel re-export
          full.endsWith(path.join("types", "provider.ts")); // the provider type union
        if (referencesHilbras && !allowed) offenders.push(full.replace(`${root}/`, ""));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("the factory serves every non-OmniHilbras integration with core-only adapters", () => {
    for (const type of ["openai-compatible", "openrouter", "local", "custom"] as const) {
      const provider = createProvider({ name: "p", type, baseUrl: "http://localhost/v1" });
      expect(provider).toBeDefined();
      expect(provider.providerId).toBe("p");
    }
  });

  it("a project configured without OmniHilbras runs a full pipeline", async () => {
    const { PipelineEngine } = await import("../src/pipelines/engine.js");
    const { TaskEngine } = await import("../src/tasks/engine.js");
    const { FileTaskStore } = await import("../src/tasks/store.js");
    const { FilePipelineRunStore } = await import("../src/pipelines/store.js");
    const { AgentRegistry } = await import("../src/agents/index.js");
    const { RoleRegistry } = await import("../src/roles/index.js");
    const { ProcessAgent } = await import("../src/agents/process/index.js");

    const dir = mkdtempSync(path.join(tmpdir(), "omninode-nohb-"));
    const agents = new AgentRegistry();
    agents.register(new ProcessAgent({
      name: "echo",
      integration: "process",
      command: "node",
      args: ["-e", "process.stdout.write('no-omnihilbras-needed')"],
    }));
    const tasks = new TaskEngine({ agents, roles: new RoleRegistry(), store: new FileTaskStore(dir) });
    const engine = new PipelineEngine({
      tasks,
      agents,
      roles: new RoleRegistry(),
      providers: [],
      store: new FilePipelineRunStore(dir),
    });
    const run = await engine.run(
      { id: "no-hb", steps: [{ id: "execute", kind: "execute", agent: "echo" }] },
      { objective: "run without OmniHilbras" },
    );
    expect(run.status).toBe("completed");
    expect(run.resultSummary).toContain("no-omnihilbras-needed");
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});