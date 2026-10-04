# Reports (v2)

A report is what an agent hands back. In v2 reports are **validated
machine-readable objects** — malformed ones are rejected at the door and never
reach aggregation (§13).

## Schema

```jsonc
{
  "id": "rep-1",              // report_id
  "taskId": "task-1",
  "agent": "kimi",            // agent_id
  "pipelineRunId": "run-a91", // provenance
  "summary": "found one high-severity issue",
  "findings": [
    {
      "id": "f1",
      "title": "SQL injection in the login handler",
      "detail": "…",              // v1 field, still written
      "description": "…",         // v2 field (mirrors detail when omitted)
      "severity": "high",         // info | low | medium | high | critical
      "confidence": "medium",     // low | medium | high
      "evidence": [               // typed evidence (§13)
        { "kind": "line", "ref": "src/auth.ts", "line": 42 },
        { "kind": "url", "ref": "https://example.test/poc" }
      ],
      "source": { "agent": "kimi", "reportId": "rep-1" },
      "recommendation": "Use parameterized queries"
    }
  ],
  "recommendations": ["Use parameterized queries"],
  "confidence": "high",
  "evidence": [{ "kind": "observation", "excerpt": "…" }],
  "artifacts": [{ "kind": "patch", "ref": "fix.diff", "bytes": 2048 }],
  "createdAt": "2026-01-01T12:00:00.000Z",
  "metadata": {}
}
```

**Evidence kinds**: `file`, `line`, `url`, `command`, `observation`,
`artifact`. Plain strings are still accepted anywhere evidence appears and
normalize to `{ kind: "observation", excerpt }`.

## Validation

`validateReport(report)` returns either a normalized report or a list of
issues. It runs on every report entering the system:

- `ReportService.collectFromTasks()` validates and **drops** malformed
  reports, recording `lastDiagnostics = { collected, accepted, rejected[] }`.
- Aggregation only ever sees validated reports, so one broken agent response
  cannot poison a combined report.
- Normalization on the way in: `description` mirrors `detail`, and each
  finding gets `source` provenance (`agent`, `reportId`, `pipelineRunId`).

## Provenance

Every finding carries `source`, and every aggregated finding carries
`sources[]` — which agents and reports confirmed it. Combined reports keep the
full `reportIds` list so any conclusion can be traced back to its sources.

## CLI

```bash
omninode report list [--agent <name>]
omninode report show <report-id>
omninode report combined [--run <run-id>]
```

## Writing reports from an agent

In protocol mode an agent sends a `REPORT` message whose payload is the report
object; OmniNode validates it exactly like any other source. In text mode the
extractor builds a report from markdown sections (`Findings`,
`Recommendations`, `Evidence`), then the same validation applies.