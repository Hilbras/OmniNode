# OmniNode v2.0.0 — Final Hardening & Fixes Plan

**Project:** Hilbras OmniNode  
**Target:** `v2.0.0`  
**Current Track:** `2.0.0-alpha`  
**Objective:** Resolve the remaining reliability, security, persistence, protocol, documentation, and release-readiness issues before the stable v2.0.0 release.

---

# 1. Purpose

OmniNode has completed the majority of the v2 architecture and implementation roadmap.

The remaining work should focus on **hardening and correctness**, not adding large new features.

This plan addresses the remaining issues identified during the latest repository audit.

The goal is to make OmniNode:

- Reliable under failure
- Predictable during retries
- Correct when execution status is uncertain
- Safe during cancellation
- Robust across process boundaries
- Consistent across providers and agents
- Safe against corrupted persistence
- Easier to operate and debug
- Ready for a stable npm and GitHub release

---

# 2. Scope

This plan covers:

1. Task retry and execution history
2. Cross-process execution semantics
3. Cancellation correctness
4. Unknown execution state handling
5. Provider timeout semantics
6. Remembera API contract
7. Audit failure isolation
8. Context truncation safety
9. Environment security defaults
10. Documentation cleanup
11. Node.js compatibility validation
12. Migration validation
13. Failure-matrix testing
14. Package validation
15. Final release hardening

---

# 3. Non-Goals

The following features must remain outside this release:

- Dynamic Model Router
- Consensus Engine
- Advanced Verification Engine
- Advanced Evidence Engine
- Role Marketplace
- Advanced Provider Failover
- Distributed Worker System
- Distributed Database
- Cost / Token Budgeting
- Replay Engine
- Advanced Context Compression
- Human Approval Gates
- Learning From Outcomes
- Full sandbox/container execution

These belong to future versions.

---

# 4. Priority Model

Use the following priorities:

### P0 — Release Blocker

Must be fixed before beta or release candidate.

### P1 — High Priority

Must be resolved before stable v2.0.0 unless explicitly documented and accepted.

### P2 — Medium Priority

Should be resolved before or shortly after v2.0.0.

---

# 5. Fix 01 — Preserve Task Execution History During Retry

**Priority:** P1

## Problem

Manual retry currently resets the task state and result.

The execution history exists, but the retry model should make it explicit that a retry is a **new execution attempt**, not a replacement of the previous execution.

## Required Design

Separate:

```text
Task
Execution
Attempt
Result
```

Recommended model:

```text
Task
├── task_id
├── current_state
├── current_result
├── executions[]
└── metadata
```

Each execution should contain:

```text
execution_id
attempt_number
started_at
finished_at
state
result
error
```

## Retry Behavior

Instead of:

```text
FAILED
 ↓
reset task
 ↓
CREATED
```

use:

```text
FAILED
 ↓
retry requested
 ↓
new execution
 ↓
attempt #2
 ↓
RUNNING
```

The original failure must remain available.

## Requirements

- Preserve previous attempts.
- Increment attempt numbers.
- Generate a new execution ID.
- Preserve previous errors.
- Preserve timestamps.
- Preserve execution history.
- Never silently delete previous results.
- CLI inspection should expose attempt history.

## Tests

Add tests for:

- Failed task retry
- Timed-out task retry
- Unknown task retry
- Cancelled task retry
- Multiple retries
- Attempt numbering
- Execution history persistence

## Acceptance Criteria

```text
retry()
```

creates a new execution attempt without destroying the history of previous attempts.

---

# 6. Fix 02 — Define Cross-Process Execution Semantics

**Priority:** P1

## Problem

Runtime cancellation and active execution tracking are process-local.

If Process A starts a pipeline and then terminates, Process B cannot automatically control Process A's in-memory runtime objects.

## Required Clarification

Document the difference between:

```text
persistent state
```

and:

```text
live runtime state
```

Persistent storage may survive process termination.

Live process handles cannot.

## Required Behavior

After a restart:

```text
Persisted RUNNING task
        ↓
Runtime recovery
        ↓
Determine whether execution is still valid
        ↓
Mark UNKNOWN / recover where possible
```

Do not falsely mark a task as:

```text
COMPLETED
```

without evidence.

## Requirements

Document:

- What survives restart.
- What does not survive restart.
- How running tasks are recovered.
- How running pipelines are recovered.
- What happens to child processes.
- What happens to cancellation requests.

## Tests

Simulate:

```text
Process A
 ↓
Start task
 ↓
Persist state
 ↓
Process termination
 ↓
Process B starts
 ↓
Inspect task
```

## Acceptance Criteria

Restarting OmniNode never produces an unjustified successful execution state.

---

# 7. Fix 03 — Strengthen Unknown Execution State

**Priority:** P0

## Problem

A network or process timeout does not always mean that the operation failed.

The operation may have completed remotely while the response was lost.

## Required Semantics

Use:

```text
UNKNOWN
```

when OmniNode cannot prove whether execution occurred.

Example:

```text
Request sent
 ↓
Remote system accepts request
 ↓
Connection lost
 ↓
No response
```

Result:

```text
UNKNOWN
```

not:

```text
FAILED
```

## Requirements

Unknown state must include:

```text
reason
last_known_state
execution_id
attempt_id
provider
agent
timestamp
```

## Retry Rule

Automatic retry must not blindly retry unknown executions.

Manual retry should warn the user when duplication is possible.

Example:

```text
Warning:
The previous execution ended in an unknown state.
Retrying may duplicate side effects.
```

## Tests

Add tests for:

- Provider response lost
- Agent output lost
- Network disconnect
- Process timeout
- Remote execution accepted but response missing

## Acceptance Criteria

Every adapter follows the same unknown-state semantics.

---

# 8. Fix 04 — Normalize Timeout Semantics Across Adapters

**Priority:** P0

## Problem

Different execution boundaries may interpret timeout differently.

OmniNode must distinguish:

```text
Connection Timeout
Request Timeout
Provider Timeout
Agent Timeout
Process Timeout
Pipeline Timeout
```

## Required Error Model

Every timeout should contain:

```text
type
operation
duration
execution_id
attempt_id
provider_id
agent_id
retryable
state
```

## Requirements

Adapters must not automatically convert every timeout into `FAILED`.

They must determine whether:

```text
execution definitely did not start
```

or:

```text
execution may have started
```

## Acceptance Criteria

Timeout behavior is consistent across:

- OpenAI-compatible providers
- OmniHilbras
- Process agents
- Native adapters
- Pipelines

---

# 9. Fix 05 — Formalize the Remembera API Contract

**Priority:** P1

## Problem

The Remembera adapter currently depends on an assumed API contract.

This is fragile because Remembera is a separate system.

## Required Solution

Create a formal Remembera integration contract.

Document:

```text
Health
Authentication
Store Memory
Search Memory
Retrieve Memory
Metadata
Project Context
Error Responses
Versioning
```

## Required Schemas

Define request/response schemas.

Example:

```text
MemoryStoreRequest
MemoryStoreResponse
MemorySearchRequest
MemorySearchResponse
MemoryError
```

## API Version

Define an explicit version.

Example:

```text
Remembera API v1
```

The OmniNode adapter should know which contract it supports.

## Failure Behavior

If Remembera is unavailable:

```text
Optional memory
    ↓
Warning
    ↓
Continue execution
```

If memory is explicitly required:

```text
Required memory
    ↓
Remembera unavailable
    ↓
Execution failure
```

## Tests

Test:

- Healthy Remembera
- Authentication failure
- 404
- 400
- 429
- 500
- Timeout
- Invalid response
- Malformed JSON
- Schema mismatch

## Acceptance Criteria

Remembera integration is based on a documented contract rather than implementation assumptions.

---

# 10. Fix 06 — Audit Failure Isolation

**Priority:** P1

## Problem

Audit logging is observability infrastructure.

It must not accidentally change the business result of an otherwise successful execution.

## Required Rule

Execution state is authoritative.

Audit state is observational.

Therefore:

```text
Task succeeds
 ↓
Audit write fails
 ↓
Task remains COMPLETED
 ↓
Audit failure is recorded/logged separately
```

not:

```text
Task succeeds
 ↓
Audit fails
 ↓
Task becomes FAILED
```

## Requirements

Define:

```text
execution failure
```

separately from:

```text
audit failure
```

## Tests

Test:

- Successful task + audit failure
- Failed task + audit success
- Failed task + audit failure
- Pipeline completion + audit failure

## Acceptance Criteria

Audit failures never corrupt execution semantics.

---

# 11. Fix 07 — Improve Audit Event Semantics

**Priority:** P2

## Objective

Keep the current audit system useful without turning it into full event sourcing.

## Requirements

Clearly document:

> OmniNode audit logs describe execution history but are not a replayable authoritative event stream.

Audit records should include:

```text
event_id
timestamp
event_type
task_id
pipeline_id
execution_id
agent_id
provider_id
metadata
```

where applicable.

## Do Not Implement

Do not add:

- Event sourcing
- Full replay
- Distributed event bus
- Event reconstruction

These remain future scope.

---

# 12. Fix 08 — Improve Context Truncation Safety

**Priority:** P2

## Problem

Character-based truncation protects memory usage but may break structured content.

Potentially affected:

- JSON
- Markdown
- Code
- Tables
- Structured reports

## Required Behavior

When possible:

1. Preserve complete structured objects.
2. Truncate at logical boundaries.
3. Mark truncation explicitly.

Example:

```text
[CONTEXT TRUNCATED]
```

## Requirements

Never silently truncate important content.

The system should expose:

```text
original_size
final_size
truncated
```

where useful.

## Tests

Test:

- Large JSON
- Large Markdown
- Large report
- Large code block
- Multi-byte Unicode
- Nested structured data

## Acceptance Criteria

Context limits remain enforced without producing misleading structured content.

---

# 13. Fix 09 — Review Environment Security Defaults

**Priority:** P1

## Problem

Environment inheritance can expose credentials and sensitive variables to external agents.

## Required Policy

Prefer:

```text
explicit
```

or:

```text
allowlist
```

for new configurations.

Legacy behavior may remain temporarily for compatibility.

## Requirements

Document:

```text
inherit
explicit
allowlist
denylist
```

and clearly explain the security implications.

## Recommended Default

For new projects:

```text
explicit
```

or the safest practical allowlist model.

## Tests

Verify that:

- API keys are not exposed unintentionally.
- Secrets are redacted.
- Agent environment follows configuration.
- Child processes do not inherit unexpected variables.

---

# 14. Fix 10 — Node.js Compatibility Audit

**Priority:** P1

## Problem

The package declares a Node.js compatibility range while the development toolchain has been upgraded.

The supported runtime and development dependencies must remain consistent.

## Required Validation

Test the complete project on:

```text
Node 20
Node 22
Node 24
```

## Validate

- Install
- Build
- Typecheck
- Tests
- CLI
- Package generation
- Runtime execution
- Provider adapters
- Agent adapters

## Required Documentation

Keep these synchronized:

```text
package.json
CI matrix
README
installation documentation
release documentation
```

## Acceptance Criteria

Every declared supported Node.js version passes the release gates.

---

# 15. Fix 11 — Migration Matrix

**Priority:** P0

## Objective

Prove that v1 data can safely move to v2.

## Test Matrix

Test:

```text
Fresh installation
v1 storage
v1 storage with missing files
v1 storage with empty files
v1 storage with malformed records
v1 storage with unknown fields
v1 storage with old schema versions
Future schema
Already migrated v2 storage
```

## Migration Requirements

Migration must be:

- Deterministic
- Safe
- Idempotent
- Validated
- Recoverable

Running:

```text
omninode migrate
```

twice should not corrupt data.

## Acceptance Criteria

A valid v1 dataset can be migrated into valid v2 storage without losing supported information.

---

# 16. Fix 12 — Failure Matrix Expansion

**Priority:** P0

Create a final release failure matrix.

## Agent Failures

Test:

```text
Agent crash
Agent timeout
Agent hangs
Invalid JSON
Unknown message type
Unsupported protocol
Oversized message
Huge stdout
Huge stderr
Unexpected exit code
Child process survives
```

## Provider Failures

Test:

```text
401
403
404
429
500
502
503
Timeout
Connection reset
Invalid JSON
Malformed response
Model unavailable
```

## Pipeline Failures

Test:

```text
Dependency failure
Circular dependency
Partial completion
Cancellation
Timeout
Unknown step state
Retry
Concurrent steps
Max concurrency
```

## Storage Failures

Test:

```text
Corrupt JSON
Partial write
Permission denied
Missing directory
Read failure
Write failure
Future schema
Migration failure
```

## Memory Failures

Test:

```text
Remembera unavailable
Timeout
Invalid response
Authentication failure
Large response
Malformed memory
```

---

# 17. Fix 13 — Retry / Side-Effect Safety Tests

**Priority:** P0

Create explicit tests for side-effect scenarios.

Example:

```text
Agent
 ↓
creates file
 ↓
operation succeeds
 ↓
response lost
 ↓
OmniNode = UNKNOWN
```

Then:

```text
retry
```

must warn or require explicit handling.

## Test Cases

- File creation
- Git operation
- API request
- Database mutation
- External command
- Provider request

## Acceptance Criteria

OmniNode never assumes that an unknown operation is safe to repeat.

---

# 18. Fix 14 — Process Tree Validation

**Priority:** P1

Verify that cancelling an agent does not leave orphan processes.

## Test

```text
OmniNode
 ↓
Agent
 ↓
Child Process
 ↓
Grandchild Process
```

Cancel the agent.

Verify:

```text
Agent terminated
Child terminated
Grandchild handled according to process-group policy
```

## Requirements

Document platform differences between:

```text
Linux
macOS
Windows
```

where applicable.

---

# 19. Fix 15 — Documentation Cleanup

**Priority:** P2

Perform a repository-wide terminology audit.

Search for outdated references:

```text
v1.0
Phase 0
stub
prototype
temporary
experimental
old architecture
```

## Update

- README
- SECURITY.md
- ARCHITECTURE.md
- CLI documentation
- Protocol documentation
- Migration documentation
- Development plan
- Changelog

## Requirement

Documentation must describe the actual `2.0.0-alpha` architecture.

---

# 20. Fix 16 — Package Validation

**Priority:** P0

Before stable release:

```text
npm pack
```

and inspect the resulting package.

## Verify

The package contains:

```text
compiled source
type definitions
required metadata
CLI entrypoint
```

and does not contain:

```text
tests
local databases
development artifacts
reports
temporary files
secrets
```

## Clean Install Test

Use a clean environment:

```text
npm install @hilbras/omninode
```

Then verify:

```text
import
CLI
runtime
```

without repository-specific files.

---

# 21. Fix 17 — Public API Audit

**Priority:** P1

Review every exported symbol.

Classify each as:

```text
Public
Internal
Experimental
Deprecated
```

## Requirements

Public APIs must have:

- Stable names
- Stable types
- Documentation
- Tests

Internal implementation details should not accidentally become public package APIs.

## Add API Regression Tests

The test suite should detect accidental removal or modification of important exports.

---

# 22. Fix 18 — Release Gate

**Priority:** P0

Create one final release gate.

The release must fail if any of the following fail:

```text
Lint
Typecheck
Unit tests
Integration tests
E2E tests
Failure matrix
Migration tests
Security checks
Secret scan
Package validation
API validation
Build
CLI smoke tests
```

---

# 23. Final Hardening Phase

After all fixes are implemented, perform a clean environment test.

## Environment

Do not use the development repository state.

Use:

```text
clean Node environment
clean npm cache where practical
fresh package installation
fresh configuration
fresh project directory
```

## Test

```text
Install OmniNode
 ↓
Initialize project
 ↓
Configure provider
 ↓
Register agent
 ↓
Create task
 ↓
Execute task
 ↓
Generate report
 ↓
Create plan
 ↓
Execute pipeline
 ↓
Persist state
 ↓
Restart OmniNode
 ↓
Inspect state
```

---

# 24. Release Candidate Audit

Create:

```text
v2.0.0-rc.1
```

Then freeze feature development.

Only allow:

- Bug fixes
- Security fixes
- Documentation corrections
- Release corrections

No new architecture features.

---

# 25. Release Candidate Checklist

## Architecture

- [ ] No unresolved architectural issues
- [ ] Public interfaces reviewed
- [ ] Dependency boundaries validated

## Tasks

- [ ] Execution history preserved
- [ ] Retry semantics validated
- [ ] Unknown state validated
- [ ] Timeout semantics validated

## Agents

- [ ] Protocol v2 validated
- [ ] Legacy protocol behavior validated
- [ ] Process cleanup validated
- [ ] Environment isolation validated

## Pipelines

- [ ] Cancellation validated
- [ ] Recovery validated
- [ ] Failure propagation validated
- [ ] Concurrency limits validated

## Providers

- [ ] Error normalization validated
- [ ] Timeout behavior validated
- [ ] Model discovery validated
- [ ] OmniHilbras integration validated

## Remembera

- [ ] API contract finalized
- [ ] Error handling validated
- [ ] Optional behavior validated
- [ ] Required behavior validated

## Persistence

- [ ] Atomic writes validated
- [ ] Corruption recovery validated
- [ ] Schema validation validated
- [ ] Migration validated

## Security

- [ ] Secret scanning passes
- [ ] Environment handling reviewed
- [ ] Process execution reviewed
- [ ] Output limits validated
- [ ] Security documentation updated

## CLI

- [ ] Human output validated
- [ ] JSON output validated
- [ ] Exit codes validated
- [ ] Error messages reviewed

## Package

- [ ] npm package inspected
- [ ] Clean install tested
- [ ] Public exports validated
- [ ] Version metadata correct

## CI

- [ ] Node 20 passes
- [ ] Node 22 passes
- [ ] Node 24 passes
- [ ] Security checks pass
- [ ] Build passes

---

# 26. Recommended Execution Order

Implement the fixes in this order:

```text
1. Execution history / retry semantics
        ↓
2. Unknown execution semantics
        ↓
3. Timeout normalization
        ↓
4. Side-effect / retry tests
        ↓
5. Cross-process recovery semantics
        ↓
6. Pipeline cancellation validation
        ↓
7. Agent process-tree validation
        ↓
8. Remembera API contract
        ↓
9. Audit failure isolation
        ↓
10. Environment security review
        ↓
11. Migration matrix
        ↓
12. Failure matrix
        ↓
13. Context truncation hardening
        ↓
14. Node compatibility audit
        ↓
15. Documentation cleanup
        ↓
16. Package/API audit
        ↓
17. Final security audit
        ↓
18. Release candidate
        ↓
19. Final hardening
        ↓
20. v2.0.0
```

---

# 27. Suggested Version Sequence

Current:

```text
2.0.0-alpha.x
```

Recommended:

```text
2.0.0-alpha.next
```

for remaining implementation fixes.

Then:

```text
2.0.0-beta.1
```

after the major P0 work is complete.

Then:

```text
2.0.0-beta.2
```

after integration and failure testing.

Then:

```text
2.0.0-rc.1
```

after feature freeze.

Finally:

```text
2.0.0
```

after the release candidate passes all gates.

---

# 28. GitHub Workflow

Every completed fix should follow:

```text
Implement
   ↓
Add/Update Tests
   ↓
Run Lint
   ↓
Run Typecheck
   ↓
Run Tests
   ↓
Run Build
   ↓
Update Documentation
   ↓
Commit
   ↓
Push
```

Do not accumulate a large unreviewable set of unrelated changes.

Prefer focused commits such as:

```text
fix(tasks): preserve execution history across retries
fix(execution): normalize unknown timeout semantics
fix(pipelines): harden cancellation recovery
fix(remembera): formalize integration contract
fix(security): tighten agent environment handling
test(reliability): expand execution failure matrix
docs(release): update v2 migration and hardening guidance
```

---

# 29. Final v2.0.0 Quality Target

The final release should satisfy this principle:

> An unexpected failure must never cause OmniNode to silently lose execution history, incorrectly report success, incorrectly retry a potentially completed operation, or expose sensitive information.

The system should always answer:

```text
What happened?
When did it happen?
Which task?
Which execution?
Which attempt?
Which agent?
Which provider?
What failed?
Was the execution definitely performed?
Can it safely be retried?
What information was persisted?
```

---

# 30. Final Definition of Done

OmniNode v2.0.0 is ready when:

```text
Architecture
     ✓

Task lifecycle
     ✓

Retry semantics
     ✓

Unknown execution handling
     ✓

Agent Protocol v2
     ✓

Process lifecycle
     ✓

Pipeline lifecycle
     ✓

Provider reliability
     ✓

Remembera contract
     ✓

Report integrity
     ✓

Persistence
     ✓

Migration
     ✓

Security
     ✓

Observability
     ✓

CLI
     ✓

Testing
     ✓

Documentation
     ✓

Package validation
     ✓

CI/CD
     ✓
```

And most importantly:

```text
No known P0 blockers
No unresolved critical security issues
No unexplained execution-state transitions
No destructive migration behavior
No known retry-induced data corruption
No undocumented release-breaking changes
```

---

# 31. Final Release Philosophy

OmniNode v2.0.0 should not be judged by the number of features it contains.

It should be judged by how reliably it behaves when things go wrong.

The release should therefore prioritize:

```text
Correctness
    >
Reliability
    >
Safety
    >
Observability
    >
Compatibility
    >
Performance
    >
New Features
```

Once this foundation is stable, future OmniNode versions can safely introduce advanced orchestration capabilities such as dynamic routing, consensus, verification, advanced memory intelligence, and learning from outcomes.

**v2.0.0 should be the foundation release that makes those future capabilities safe to build.**