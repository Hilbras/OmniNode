# Agents

An OmniNode agent is any CLI program (or custom integration) that can perform a
task. OmniNode never assumes an agent's internals — it launches it, hands it a
task, and interprets what comes back.

## Registering an agent

```bash
omninode agent add --name opencode --command opencode --input-mode arg
```

```yaml
project:
  agents:
    - name: researcher
      command: some-agent
      input_mode: protocol      # stdin | arg | protocol
      timeout_ms: 600000
      max_output_bytes: 5242880
      env_policy: inherit       # inherit | allowlist | denylist | explicit
      env_allowlist: [HOME, LANG]
      env:
        SOME_AGENT_FLAG: "1"
      cwd: ./workspace
      allow_external_cwd: false
```

```bash
omninode agent inspect researcher   # effective config, env policy, recent tasks
omninode agent test researcher      # send a trivial task through the real adapter
omninode agent run researcher "investigate the build"   # one task, immediately
```

## Input modes

| Mode | What the agent receives | Use for |
| --- | --- | --- |
| `stdin` | the composed task text (objective, role, context, instruction) | agents that read a prompt from stdin |
| `arg` | the composed task text as the **last argument** | `opencode run "<task>"`-style CLIs |
| `protocol` | Agent Protocol v2 JSON-lines envelopes ([PROTOCOL.md](PROTOCOL.md)) | agents that want structure, progress and questions |

The composed text always contains `# Objective`, and when applicable `# Role`,
`# Context` (relevant memory + upstream research) and `# Instruction`.

## Process handling

- Runs in its own process group on POSIX — timeout, `task cancel` and OmniNode's
  own SIGINT/SIGTERM reap the whole tree.
- Output is capped per stream (`max_output_bytes`); a flooding agent is killed
  rather than exhausting memory.
- Working directories are validated and confined to the project root unless
  `allow_external_cwd`.
- A timeout after dispatch leaves the task **`unknown`**, not `failed` — the
  agent may have completed the work remotely.

## States a task can end in

`completed` · `failed` · `timed_out` · `unknown` · `cancelled` ·
`partially_completed`. `unknown` is deliberate: it is resolved by an explicit
`task retry`, never by assuming failure.

## Writing a native (API-level) adapter

CLI agents use the process adapter out of the box. To integrate an agent that
has an HTTP/gRPC API instead, implement `IAgentAdapter` and register it — no
core changes:

```ts
import { createAgent, AgentAdapterRegistry } from "@hilbras/omninode";

const adapters = new AgentAdapterRegistry();
adapters.register({
  integration: "native",
  create: (config) => new MyNativeAgent(config),
});
const agent = createAgent({ name: "my-agent", integration: "native" }, adapters);
```

`IAgent` is the whole contract: `info`, `run(input)`, optional `cancel(taskId)`.
