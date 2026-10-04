# OmniNode Agent Protocol v2

**Protocol identifier:** `omninode-agent-protocol/2`
**Transport:** newline-delimited JSON (JSONL) over an agent process's stdin/stdout.
**Status:** stable in the v2 line (exposed from `@hilbras/omninode` via `src/agent-protocol`).

This specification is complete enough for an external agent to integrate with
OmniNode without depending on any OmniNode internals. Reference implementation:
[`src/agent-protocol/`](https://github.com/Hilbras/OmniNode/tree/main/src/agent-protocol).

## Message envelope

Every message, in both directions, is one JSON object on one line:

```json
{
  "protocol": "omninode-agent-protocol/2",
  "messageId": "msg-m1x2-8f3a2b",
  "requestId": "req-task-4f2",
  "taskId": "task-4f2",
  "agentId": "opencode",
  "pipelineId": "run-a91",
  "executionId": "exec-a91-9f2c",
  "timestamp": "2026-01-01T12:00:00.000Z",
  "type": "TASK",
  "payload": {},
  "metadata": {}
}
```

- `protocol`, `messageId` and `type` are always emitted by OmniNode.
- Correlation fields (`requestId`, `taskId`, `agentId`, `pipelineId`,
  `executionId`) make every message traceable to the agent, task, pipeline,
  execution and request it belongs to.
- Messages larger than 1 MiB are rejected (`OVERSIZED`).

## Versioning and backwards compatibility

- An agent declares its dialect with the `protocol` field (or via `HELLO`).
- Inbound messages **without** a `protocol` field are treated as
  `omninode-agent-protocol/1` (the OmniNode 1.x dialect: bare `{type, payload}`
  objects). This keeps v1 agents working unchanged.
- Unknown protocol versions are rejected as `UNSUPPORTED_VERSION` — never
  crash, never silently misinterpret.

## Message types

### OmniNode → agent

| Type | Payload | Meaning |
| --- | --- | --- |
| `HELLO_ACK` | `{ ok, protocol, agent, agentVersion, supportedProtocols }` | handshake accepted |
| `TASK` | `{ taskId, objective }` | the task to perform |
| `CONTEXT` | `{ body }` or `{ role }` | background context / role definition |
| `INSTRUCTION` | `{ text }` | explicit execution instruction |
| `RESPONSE` | `{ questionId, body }` | answer to an agent `QUESTION` |
| `CANCEL` | `{ reason? }` | stop current work |

### Agent → OmniNode

| Type | Payload | Meaning |
| --- | --- | --- |
| `HELLO` | `{ name, version?, capabilities[], supports[] }` | announce the agent (optional) |
| `TASK_ACCEPTED` / `TASK_STARTED` | `{}` | lifecycle acknowledgement |
| `STATUS` | `{ state, detail? }` | progress reporting |
| `QUESTION` | `{ questionId, question, expected?, options? }` | agent needs information |
| `REPORT` | Report or Report[] | structured findings |
| `ARTIFACT` | `{ kind, ref, description?, mediaType?, bytes? }` | produced artifact |
| `COMPLETION` | `{ summary }` | task finished successfully |
| `ERROR` | `{ code?, message }` | task failed |
| `CANCELLED` | `{ reason? }` | agent acknowledges cancellation |

## Handshake

Recommended, optional:

```
Agent → OmniNode    HELLO { name: "my-agent", version: "1.4.2", capabilities: ["code"], supports: ["REPORT","COMPLETION"] }
OmniNode → Agent    HELLO_ACK { ok: true, protocol: "omninode-agent-protocol/2" }
```

Agents that skip `HELLO` still interoperate; the adapter reports them as
`protocol.legacy = true` in the task diagnostics.

## Interactive questions

```
Agent → OmniNode    QUESTION { questionId: "q1", question: "Which branch should I use?" }
OmniNode → Agent    RESPONSE { questionId: "q1", body: "feature/x" }
Agent → OmniNode    COMPLETION { summary: "done" }
```

Questions are answered at the protocol level by OmniNode's responder (never a
human-approval workflow — that is explicitly out of scope). With no responder
configured, the question is recorded and the run continues unanswered.

## Artifacts

`ARTIFACT` payloads carry `kind` ∈ `file | patch | report | log | screenshot |
document | data`, a `ref` (path/URL/name), optional `description`, `mediaType`
and `bytes`. OmniNode records them on the run for later inspection.

## Robustness contract (§7.5)

Decoding is **total** — OmniNode never throws on agent output. Failures are
recorded as typed violations:

| Code | Trigger |
| --- | --- |
| `INVALID_JSON` | line is not JSON |
| `NOT_AN_OBJECT` | valid JSON, but not an object |
| `UNKNOWN_TYPE` | unknown message type |
| `MISSING_FIELD` | required field missing or wrong type |
| `INVALID_PAYLOAD` | required payload missing or malformed |
| `UNSUPPORTED_VERSION` | protocol not supported |
| `OVERSIZED` | message/line exceeds the size limit |

A run whose output contains only violations ends as `failed` with the
violations attached to the task's `protocol.violations` — visible via
`omninode task status`.

## Minimal agent example

```js
// Reads OmniNode's task from stdin, answers, reports, completes.
let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const P = "omninode-agent-protocol/2";
  out({ protocol: P, type: "HELLO", messageId: "m1", payload: { name: "my-agent", version: "1.0.0", capabilities: [], supports: ["REPORT", "COMPLETION"] } });
  out({ protocol: P, type: "REPORT", messageId: "m2", taskId: "task-1", payload: { id: "r1", taskId: "task-1", agent: "my-agent", summary: "I looked and here is what I found", findings: [], recommendations: [], createdAt: new Date().toISOString() } });
  out({ protocol: P, type: "COMPLETION", messageId: "m3", taskId: "task-1", payload: { summary: "done" } });
});
```

Configure it with `input_mode: protocol` (see `omninode agent add`).