# Extension guides

OmniNode's extension points are interfaces. None of these guides require
changing core — if you find yourself editing `src/tasks`, `src/pipelines` or
`src/providers/factory.ts` to add a capability, an interface is missing.

All examples import from the package root: `import { … } from "@hilbras/omninode";`

---

## 1. Creating a Provider

A provider talks to an AI gateway. Implement `IProvider` (discovery, health)
and `IChatProvider` (chat), then register the type.

```ts
import {
  requestJson,
  providerHttpError,
  providerTransportError,
  type IChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ProviderConfig,
  type ProviderStatus,
} from "@hilbras/omninode";

export class MyGatewayProvider implements IChatProvider {
  readonly config: ProviderConfig;           // part of IProvider
  readonly providerId: string;
  readonly authentication = { method: "bearer", configured: true } as const;

  constructor(config: ProviderConfig) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
    this.providerId = config.providerId ?? config.name;
  }

  async connect(): Promise<ModelInfo[]> {
    return this.listModels();
  }

  async listModels(): Promise<ModelInfo[]> {
    let response;
    try {
      response = await requestJson(`${this.config.baseUrl}/models`);
    } catch (error) {
      throw providerTransportError({
        provider: this.config.name,
        operation: "listModels",
        cause: error,
      });
    }
    if (response.status !== 200) {
      throw providerHttpError({
        provider: this.config.name,
        operation: "listModels",
        status: response.status,
        body: response.body,
      });
    }
    const data = (response.body as { models?: Array<{ id: string }> }).models ?? [];
    return data.map((model) => ({ provider: this.config.name, id: model.id, status: "available" }));
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    return (await this.listModels()).find((model) => model.id === id);
  }

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const models = await this.listModels();
      return {
        name: this.config.name,
        type: this.config.type,
        baseUrl: this.config.baseUrl,
        health: "healthy",
        connected: true,
        modelCount: models.length,
      };
    } catch (error) {
      return {
        name: this.config.name,
        type: this.config.type,
        baseUrl: this.config.baseUrl,
        health: "unreachable",
        connected: false,
        modelCount: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await requestJson(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: { authorization: "Bearer …", "content-type": "application/json" },
      body: { prompt: request.messages.map((m) => `${m.role}: ${m.content}`).join("\n") },
    });
    const body = response.body as { reply?: string };
    return { model: request.model, content: body.reply ?? "" };
  }
}
```

Register it in `src/providers/factory.ts` behind your `type`, then use
`provider add --type <yours>`.

**Rules:** never log or embed secret values; raise errors through
`providerHttpError` / `providerTransportError` so the normalized `kind`
(`AUTHENTICATION_ERROR`, `RATE_LIMIT_ERROR`, …) stays meaningful; keep
`listModels` cheap — it runs on every discovery command.

---

## 2. Creating an Agent Adapter

CLI agents already work through `ProcessAgent`. Write an adapter when your
agent has an API instead of a process, or needs custom transport.

```ts
import type { AgentConfig, AgentInfo, AgentTaskInput, AgentTaskOutput, IAgent } from "@hilbras/omninode";

export class MyApiAgent implements IAgent {
  readonly info: AgentInfo;

  constructor(private readonly config: AgentConfig) {
    this.info = {
      name: config.name,
      integration: "custom",
      status: "ready",
      capabilities: ["code"],
    };
  }

  async run(input: AgentTaskInput): Promise<AgentTaskOutput> {
    const response = await fetch(`https://agents.example/${this.config.name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: input.objective,
        role: input.role?.id,
        context: input.context,
        correlation: { taskId: input.taskId, executionId: input.executionId },
      }),
    });
    if (!response.ok) {
      return {
        taskId: input.taskId,
        status: "failed",
        error: `agent API returned HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as { summary: string; report?: unknown };
    return {
      taskId: input.taskId,
      status: "completed",
      summary: payload.summary,
      rawOutput: payload.summary,
    };
  }

  async cancel(taskId: string): Promise<void> {
    await fetch(`https://agents.example/tasks/${taskId}/cancel`, { method: "POST" });
  }
}
```

Register the integration:

```ts
import { AgentAdapterRegistry, createAgent } from "@hilbras/omninode";

const adapters = new AgentAdapterRegistry();
adapters.register({ integration: "custom", create: (config) => new MyApiAgent(config) });
const agent = createAgent({ name: "my-agent", integration: "custom" }, adapters);
```

**Rules:** return `unknown` rather than throwing when the agent itself failed
(the task becomes `failed`); throw only when OmniNode mis-configured you; honor
`executionId` for correlation; report a `summary` (it feeds reports and plans).

---

## 3. Creating a Storage Adapter

Stores persist one record type. Extend `JsonFileStore<T>` unless you need
another backend (SQLite, Postgres, remote API) — in which case implement the
narrow interface and pass it into the engine options.

```ts
import type { Task, TaskStore } from "@hilbras/omninode";

// from your own data layer
interface PostgresDb {
  upsert(table: string, row: unknown): Promise<void>;
  get(table: string, id: string): Promise<unknown>;
  query(table: string, filter: Record<string, unknown>): Promise<unknown[]>;
}

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly db: PostgresDb) {}

  async save(task: Task): Promise<void> {
    await this.db.upsert("tasks", task);
  }

  async get(id: string): Promise<Task | undefined> {
    return (await this.db.get("tasks", id)) as Task | undefined;
  }

  async list(filter: { status?: string } = {}): Promise<Task[]> {
    return (await this.db.query("tasks", filter)) as Task[];
  }
}

import { TaskEngine, AgentRegistry, RoleRegistry } from "@hilbras/omninode";

declare const db: PostgresDb; // your database handle

const engine = new TaskEngine({
  agents: new AgentRegistry(),
  roles: new RoleRegistry(),
  store: new PostgresTaskStore(db),
});
```

The same pattern applies to `PipelineRunStore`, `ReportStore`, `PlanStore` and
`AuditSink` (`record(event)`).

**Rules:** keep read-modify-write atomic (the file stores serialize this for
you); never delete user data on parse failure — quarantine and report; version
your schema.

---

## 4. Creating a Memory Adapter

Memory answers "what do we know that is relevant right now".

```ts
import type { IMemoryProvider, MemoryEntry, MemoryProviderMetadata, MemoryQuery } from "@hilbras/omninode";

export class MyVectorMemory implements IMemoryProvider {
  readonly name = "my-vectors";

  // from your own vector store
  private readonly index = {
    search(text: string, options: { topK: number }): Promise<Array<{ entry: MemoryEntry }>> {
      return Promise.resolve([]);
    },
    upsert(record: { id: string; text: string; tags?: string[] }): Promise<void> {
      return Promise.resolve();
    },
  };

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const hits = await this.index.search(query.text ?? "", { topK: query.limit ?? 8 });
    return hits.map((hit) => hit.entry);
  }

  async store(entry: MemoryEntry): Promise<void> {
    await this.index.upsert({ id: entry.key, text: entry.content, tags: entry.tags });
  }

  async search(text: string, options: { limit?: number } = {}): Promise<MemoryEntry[]> {
    return this.retrieve({
      text,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  metadata(): MemoryProviderMetadata {
    return { name: this.name, capabilities: ["retrieve", "store", "search"], relevanceRanking: true };
  }

  // v1 aliases kept working
  async query(q: MemoryQuery): Promise<MemoryEntry[]> { return this.retrieve(q); }
  async write(e: MemoryEntry): Promise<void> { await this.store(e); }
}
```

Wire it through `MemoryService` (handles gathering, formatting and the
`required` failure policy) and pass it to the `TaskEngine`.

**Rules:** retrieval must be relevance-ranked and cheap — the service caps
entries and characters; respect `scope` and `category`; never throw on the
optional path unless the project marked memory `required: true`.

---

## 5. Creating a Planner

A planner turns research into an ordered, actionable plan.

```ts
import {
  buildPlannerContext,
  validatePlan,
  type IPlanner,
  type Plan,
  type PlanRequest,
} from "@hilbras/omninode";

export class MyPlanner implements IPlanner {
  readonly name = "my-planner";

  constructor(private readonly chat: (model: string, messages: Array<{ role: "user"; content: string }>) => Promise<string>) {}

  async plan(request: PlanRequest): Promise<Plan> {
    const context = buildPlannerContext(request);
    const raw = await this.chat("my-model", [{ role: "user", content: `${context}\n\nReturn the plan as JSON.` }]);
    const json = JSON.parse(raw) as {
      summary: string;
      steps: Array<{ title: string; order: number }>;
    };
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      objective: request.objective,
      summary: json.summary,
      steps: json.steps.map((step, index) => ({
        id: `step-${index + 1}`,
        title: step.title,
        order: step.order ?? index + 1,
      })),
      generatedBy: this.name,
      createdAt: new Date().toISOString(),
    };
    const validation = validatePlan(plan);
    if (!validation.valid) {
      throw new Error(`invalid plan: ${validation.issues.map((i) => i.message).join("; ")}`);
    }
    return validation.plan;
  }
}
```

Then configure it, or pass it directly to `PipelineEngine` via the
`planner` option (a `plan` step uses it unless it names its own `model`).

**Rules:** never assume a specific model or vendor; run `buildPlannerContext`
rather than re-assembling inputs; **validate** the plan before returning it;
prefer a deterministic fallback (see `HeuristicPlanner`) when output is
unusable.

---

## Checklist for any extension

- [ ] Implemented only the interface — no core edits
- [ ] Errors carry codes/details; secrets never appear in messages or logs
- [ ] Tests cover the happy path **and** the failure mode
- [ ] Public exports added to `src/index.ts` and [API.md](API.md)
- [ ] `npm run verify` green
