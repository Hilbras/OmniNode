# OmniNode v2.0.0 — Complete Development Roadmap

**Project:** Hilbras OmniNode  
**Current Version:** v1.0.0  
**Target Version:** v2.0.0  
**Package:** `@hilbras/omninode`  
**License:** MIT  
**Runtime:** Node.js 20+  
**Language:** TypeScript

---

## 1. v2.0.0 Vision

OmniNode v2.0.0 will transform OmniNode from a strong v1 orchestration foundation into a **production-ready Multi-AI Agent Orchestration Layer**.

The primary objective of v2.0.0 is **not** to add every advanced AI orchestration feature.

Instead, v2.0.0 will focus on making the existing architecture:

- More reliable
- More predictable
- More secure
- More observable
- More interoperable
- More resilient to failures
- Better at handling real agent processes
- Better at handling long-running pipelines
- Better documented
- Easier to extend
- Safer for production workloads

The release should establish a stable foundation for future OmniNode versions.

---

# 2. v2.0.0 Core Goals

The release will focus on ten major areas:

1. Execution Reliability
2. Agent Protocol Maturity
3. Pipeline Lifecycle Management
4. Provider & Model Infrastructure
5. Persistence & Storage Hardening
6. Report & Planner Reliability
7. Security Hardening
8. Testing & Failure Resilience
9. CLI & Developer Experience
10. Documentation & Release Quality

---

# 3. Scope Boundaries

The following features are intentionally **NOT part of v2.0.0 implementation scope**.

They remain future roadmap items:

- Dynamic Model Router
- Consensus Engine
- Advanced Evidence-Based Findings
- Verification Loop
- Advanced Persistent Project Intelligence
- Role Packs / Role Marketplace
- Advanced Provider Health & Failover
- Advanced Parallel Execution
- Cost / Token Budgeting
- Replayable Tasks
- Context Compression
- Human Approval Gates
- Learning From Outcomes

Basic versions of existing capabilities may be improved, but v2.0.0 must not become overloaded with speculative features.

---

# 4. Target Architecture

The v2 architecture should preserve the current modular structure.

```text
User / CLI Agent
       │
       ▼
┌──────────────────────────────┐
│        OmniNode Core         │
├──────────────────────────────┤
│ Task System                  │
│ Pipeline Engine              │
│ Agent Registry               │
│ Provider Manager             │
│ Report System                │
│ Planner                      │
│ Context Manager              │
│ Execution Manager            │
│ Persistence Layer            │
│ Audit / Observability        │
└──────────────┬───────────────┘
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
   Providers Agents  Remembera
       │       │        │
       ▼       ▼        ▼
    AI APIs  CLI      Memory
             Agents
```

The architecture must remain interface-driven.

---

# 5. Phase 1 — v2 Foundation & Architecture Stabilization

## Objective

Prepare the codebase for v2 development without introducing unnecessary architectural rewrites.

### Tasks

- Review every public interface.
- Identify unstable internal APIs.
- Identify duplicated abstractions.
- Identify modules with excessive responsibilities.
- Review dependency boundaries.
- Review circular dependency risks.
- Review public exports.
- Define stable v2 interfaces.
- Mark experimental APIs clearly.
- Remove obsolete v1 terminology.
- Establish architecture rules for v2.

### Core Interfaces

Review and stabilize:

```text
IProvider
IAgent
IAgentAdapter
ITask
IPipeline
IPipelineExecutor
IReport
IPlanner
IMemoryProvider
IStorage
IContextManager
```

### Requirements

Every major subsystem must have:

- Clear ownership
- Clear input/output contracts
- Explicit error behavior
- Explicit lifecycle behavior
- Test coverage
- Documentation

### Deliverables

- Architecture review
- API stability policy
- v2 architecture document
- Public API inventory
- Deprecated API list
- Dependency boundary rules

### Exit Criteria

- No unresolved architectural contradictions.
- Public APIs are clearly defined.
- Core modules can evolve independently.
- No unnecessary rewrite is introduced.

---

# 6. Phase 2 — Execution Reliability

## Objective

Make OmniNode execution reliable under real-world failures.

This is one of the most important v2 phases.

### 6.1 Execution State Model

Expand execution states where appropriate.

Recommended states:

```text
CREATED
QUEUED
RUNNING
COMPLETED
FAILED
TIMED_OUT
CANCELLED
UNKNOWN
PARTIALLY_COMPLETED
```

Each state must have clearly defined semantics.

### 6.2 State Transitions

Define a strict state machine.

Example:

```text
CREATED
   ↓
QUEUED
   ↓
RUNNING
   ├── COMPLETED
   ├── FAILED
   ├── TIMED_OUT
   ├── CANCELLED
   └── UNKNOWN
```

Invalid transitions must be rejected.

### 6.3 Unknown Execution State

Introduce explicit handling for situations such as:

- Process timeout after possible side effects
- Network connection lost after request submission
- Provider response lost
- Agent process terminated unexpectedly
- System restart during execution

OmniNode must not automatically assume:

```text
timeout = failed
```

because the operation may actually have completed remotely.

### 6.4 Retry Safety

Improve retry behavior.

Every retryable operation must define:

- Retryable errors
- Maximum retries
- Backoff
- Retry state
- Attempt number
- Previous error
- Execution identity

Retries must not blindly duplicate side effects.

### 6.5 Idempotency

Introduce execution identifiers.

Example:

```text
execution_id
task_id
attempt_id
pipeline_execution_id
```

Where possible, adapters should support idempotent execution.

### 6.6 Timeout Model

Separate:

```text
connection timeout
request timeout
process timeout
pipeline timeout
provider timeout
```

Timeout errors must include:

- Duration
- Operation
- Provider/agent
- Attempt
- Execution ID

### Exit Criteria

- No silent execution failures.
- Timeout behavior is deterministic.
- Retry behavior is documented and tested.
- Unknown execution states are represented correctly.

---

# 7. Phase 3 — Agent Protocol v2

## Objective

Upgrade OmniNode's agent communication protocol from a basic process protocol into a stable interoperability layer.

### 7.1 Protocol Versioning

Introduce explicit protocol versions.

Example:

```text
omninode-agent-protocol/2
```

Agents must declare:

- Protocol version
- Agent name
- Agent version
- Capabilities
- Supported message types

### 7.2 Message Envelope

Standardize the message envelope.

Conceptually:

```text
message_id
request_id
task_id
agent_id
timestamp
type
payload
metadata
```

### 7.3 Message Types

Standardize:

```text
TASK_REQUEST
TASK_ACCEPTED
TASK_STARTED
STATUS
QUESTION
CONTEXT
INSTRUCTION
REPORT
ARTIFACT
COMPLETION
ERROR
CANCEL
CANCELLED
```

### 7.4 Correlation

Every message must be traceable to:

```text
agent
task
pipeline
execution
request
```

### 7.5 Malformed Messages

Handle:

- Invalid JSON
- Unknown message type
- Missing fields
- Invalid payload
- Oversized messages
- Unexpected protocol versions

The agent must not crash OmniNode.

### 7.6 Interactive Questions

Improve the protocol so agents can explicitly request information.

Example:

```text
Agent
  ↓
QUESTION
  ↓
OmniNode
  ↓
CONTEXT / RESPONSE
  ↓
Agent
```

This should remain protocol-level functionality, not become a human approval system.

### 7.7 Artifacts

Standardize artifact reporting.

Artifacts may include:

- Files
- Patches
- Reports
- Logs
- Screenshots
- Generated documents
- Structured data

### Exit Criteria

An external agent should be able to integrate with OmniNode without depending on OmniNode internals.

---

# 8. Phase 4 — Agent Adapter Hardening

## Objective

Make external CLI agents reliable in production environments.

### Process Adapter

Improve:

- Process spawning
- Environment handling
- stdin/stdout management
- stderr handling
- signal handling
- timeout handling
- process termination
- child process cleanup
- output limits
- encoding handling
- exit-code interpretation

### Process Tree Cleanup

When an agent terminates, OmniNode must prevent orphaned child processes where possible.

### Environment Isolation

Support explicit environment policies:

```text
inherit
allowlist
denylist
explicit
```

### Working Directory

Validate:

- Directory existence
- Permissions
- Path normalization
- Project boundaries

### Output Protection

Protect OmniNode from:

- Extremely large stdout
- Extremely large stderr
- Infinite output
- Malformed JSONL
- Binary output

### Native Adapters

Improve the native adapter interface so future integrations can implement direct API-level integrations without changing OmniNode core.

### Exit Criteria

Agent failures must be isolated from OmniNode.

---

# 9. Phase 5 — Pipeline Lifecycle v2

## Objective

Make pipeline execution more predictable and manageable.

### 9.1 Pipeline Execution Model

Define:

```text
Pipeline
Pipeline Run
Step
Step Run
Execution Attempt
```

These must not be conflated.

### 9.2 Pipeline Cancellation

Implement first-class cancellation.

When a pipeline is cancelled:

```text
Pipeline
   ↓
Cancellation Requested
   ↓
Stop scheduling pending steps
   ↓
Cancel running tasks
   ↓
Terminate child processes where possible
   ↓
Persist final states
   ↓
Pipeline = CANCELLED
```

### 9.3 Failure Propagation

Define behavior for:

- Step failure
- Dependency failure
- Timeout
- Cancellation
- Unknown state
- Partial completion

### 9.4 Conditions

Improve conditional steps.

Conditions should be:

- Deterministic
- Validated
- Documented
- Testable

### 9.5 Pipeline Validation

Validate before execution:

- Missing dependencies
- Duplicate step IDs
- Cycles
- Invalid conditions
- Invalid configuration
- Unsupported step types

### 9.6 Pipeline Recovery

Basic recovery should allow OmniNode to understand persisted pipeline state after interruption.

This is **not full replay functionality**.

### Exit Criteria

Pipeline execution must remain understandable even after failure, timeout, cancellation, or process interruption.

---

# 10. Phase 6 — Provider Infrastructure v2

## Objective

Strengthen provider abstraction without introducing a dynamic routing system.

### Provider Interface

Standardize:

```text
provider_id
name
type
base_url
authentication
models
capabilities
status
metadata
```

### Model Metadata

Improve model metadata.

Recommended fields:

```text
id
name
provider
context_window
input_types
output_types
capabilities
supports_tools
supports_vision
supports_reasoning
supports_structured_output
supports_streaming
```

### Model Discovery

Provider adapters should support:

```text
connect
authenticate
listModels
getModel
healthCheck
```

where supported.

### OpenAI-Compatible Providers

Improve compatibility with:

- OpenAI-compatible APIs
- OpenRouter-compatible APIs
- Custom endpoints
- Local model servers

### Error Normalization

Normalize provider errors:

```text
AUTHENTICATION_ERROR
RATE_LIMIT_ERROR
INVALID_REQUEST
MODEL_NOT_FOUND
TIMEOUT
NETWORK_ERROR
SERVER_ERROR
UNKNOWN_ERROR
```

### Provider Configuration

Ensure secrets are never persisted directly in configuration files.

Use:

```text
environment references
secret references
runtime credentials
```

### Exit Criteria

Adding a new provider should require implementing an adapter rather than modifying OmniNode core.

---

# 11. Phase 7 — OmniHilbras Integration v2

## Objective

Keep OmniHilbras integration powerful while ensuring OmniNode remains provider-agnostic.

### Requirements

OmniHilbras must remain:

```text
Optional
```

OmniNode must function without OmniHilbras.

### Integration Improvements

Support:

- Authentication
- Model discovery
- Model metadata
- Request execution
- Error normalization
- Timeout handling
- Streaming where supported
- Provider metadata

### Separation

Keep:

```text
OmniNode
   ↓
Provider Interface
   ↓
OmniHilbras Adapter
```

rather than:

```text
OmniNode
   ↓
OmniHilbras internals
```

### Exit Criteria

Removing OmniHilbras must not break the OmniNode core.

---

# 12. Phase 8 — Remembera Integration v2

## Objective

Make Remembera integration reliable while keeping memory optional.

### Architecture

```text
OmniNode
    │
    ▼
IMemoryProvider
    │
    ▼
Remembera Adapter
```

### Formalize Contract

Define the exact contract for:

```text
retrieve
store
search
metadata
project
task
role
```

### Context Retrieval

Memory retrieval should be task-oriented.

Example:

```text
Task
 ↓
Context Query
 ↓
Relevant Memory
 ↓
Context Manager
 ↓
Agent / Planner
```

Avoid loading all memory.

### Memory Categories

Support structured categories:

```text
project
architecture
decisions
tasks
problems
solutions
conventions
agent_reports
```

### Failure Handling

If Remembera is unavailable:

```text
OmniNode continues
```

unless memory is explicitly marked as required.

### Exit Criteria

Remembera improves OmniNode context without becoming a mandatory dependency.

---

# 13. Phase 9 — Report System v2

## Objective

Improve the reliability and consistency of reports generated by agents.

### Report Schema

Standardize:

```text
report_id
task_id
agent_id
summary
findings
recommendations
confidence
evidence
artifacts
metadata
created_at
```

### Findings

Each finding should support:

```text
title
description
severity
confidence
evidence
source
recommendation
```

### Evidence

Improve evidence representation without introducing the future advanced Evidence Engine.

Evidence may reference:

- File
- Line
- URL
- Command output
- Agent observation
- Artifact

### Report Validation

Validate reports using schemas.

Malformed reports must not enter the aggregation pipeline.

### Exit Criteria

Reports become reliable machine-readable objects rather than loosely structured text.

---

# 14. Phase 10 — Aggregation Improvements

## Objective

Improve the existing deterministic report aggregation system.

The goal is to improve baseline aggregation without introducing the future Consensus Engine.

### Improvements

Support:

- Duplicate finding detection
- Similar finding grouping
- Source tracking
- Confidence preservation
- Conflict detection
- Recommendation grouping
- Report provenance

### Conflicts

When agents disagree:

```text
Finding A
Finding B
     ↓
Conflict Detected
```

OmniNode should preserve both positions rather than silently choosing one.

### Aggregation Output

Example structure:

```text
AggregatedReport
├── Summary
├── Findings
├── Agreements
├── Conflicts
├── Recommendations
├── Sources
└── Metadata
```

### Exit Criteria

Aggregation must be deterministic, explainable, and provenance-aware.

---

# 15. Phase 11 — Planner v2

## Objective

Make the planner more reliable while keeping it provider-agnostic.

### Planner Input

The planner should receive:

```text
Original Task
Project Context
Agent Reports
Aggregated Findings
Relevant Memory
Constraints
```

### Planner Output

Structured plan:

```text
Goal
Steps
Targets
Dependencies
Acceptance Criteria
Risks
Source Findings
```

### Validation

Every generated plan must pass schema validation.

Invalid plans must:

1. Be rejected.
2. Produce a structured error.
3. Optionally fall back to heuristic planning where supported.

### Planner Independence

The planner must not assume:

- OpenAI
- ChatGPT
- OmniHilbras
- A specific model

### Exit Criteria

A planner provider can be replaced without changing the orchestration engine.

---

# 16. Phase 12 — Persistence Layer v2

## Objective

Make persistence safer and more extensible.

Current local persistence is useful for v1, but v2 should establish a stronger abstraction.

### Storage Interfaces

Define clear interfaces for:

```text
TaskStore
PipelineStore
ReportStore
PlanStore
MemoryStore
AuditStore
```

### Atomic Writes

Local storage must minimize corruption risk.

Use:

```text
temporary write
→ fsync where appropriate
→ atomic rename
```

### Corruption Recovery

Detect:

- Invalid JSON
- Partial writes
- Missing records
- Invalid schema versions

### Schema Versioning

Persisted data should include schema versions.

Example:

```text
schema_version: 2
```

### Migration

Implement migration support:

```text
v1 data
   ↓
migration
   ↓
v2 data
```

### Future Compatibility

The storage interfaces should make future implementations possible:

```text
SQLite
PostgreSQL
Remote API
Distributed storage
```

without changing OmniNode business logic.

---

# 17. Phase 13 — Security Hardening

## Objective

Raise OmniNode's security baseline.

### Secrets

Never store:

- API keys
- Access tokens
- Passwords
- Session credentials

in plain configuration.

### Process Execution

Continue using safe process spawning.

Avoid shell-string execution by default.

### Environment Security

Prevent accidental exposure of secrets to agents.

### Working Directory Security

Validate project paths.

Prevent unintended execution outside the requested workspace where possible.

### Output Limits

Limit:

- stdout
- stderr
- report size
- protocol message size
- artifact metadata

### Agent Trust Model

Document clearly:

> OmniNode agents execute with the permissions available to the operating system user running OmniNode.

### Sandbox Boundary

Do not claim that OmniNode provides a real sandbox.

Document optional future isolation mechanisms separately.

### Exit Criteria

Security behavior is explicit, documented, and tested.

---

# 18. Phase 14 — Audit & Observability

## Objective

Improve operational visibility while keeping advanced event sourcing/replay out of v2.

### Basic Audit Logging

Continue recording:

```text
task created
task started
task completed
task failed
pipeline started
pipeline completed
pipeline failed
plan generated
agent started
agent completed
provider error
```

### Correlation

Every event should include:

```text
timestamp
task_id
pipeline_id
execution_id
agent_id
provider_id
```

where applicable.

### Structured Logs

Prefer machine-readable logs.

### CLI Diagnostics

Provide useful diagnostics such as:

```text
omninode task inspect <id>
omninode pipeline inspect <id>
omninode agent inspect <id>
omninode provider inspect <id>
```

Exact CLI names can be finalized during implementation.

### Exit Criteria

Developers should be able to understand what happened during a failed execution.

---

# 19. Phase 15 — CLI v2

## Objective

Improve OmniNode's CLI into a reliable developer-facing interface.

### Command Groups

Recommended structure:

```text
omninode
├── init
├── config
├── provider
├── model
├── agent
├── task
├── pipeline
├── report
├── plan
├── memory
├── inspect
└── version
```

### Task Commands

Support:

```text
create
run
status
inspect
cancel
retry
```

### Pipeline Commands

Support:

```text
create
validate
run
status
inspect
cancel
```

### Provider Commands

Support:

```text
add
remove
list
test
models
inspect
```

### Agent Commands

Support:

```text
list
inspect
test
run
```

### Output Modes

Support:

```text
human-readable
JSON
JSONL
```

This is important for automation.

### Exit Codes

Define consistent CLI exit codes.

Example:

```text
0 = success
1 = general failure
2 = invalid input
3 = configuration error
4 = provider failure
5 = agent failure
6 = timeout
7 = cancellation
```

Exact codes can be finalized during implementation.

---

# 20. Phase 16 — Configuration System v2

## Objective

Make configuration predictable and environment-friendly.

### Configuration Sources

Define precedence:

```text
CLI arguments
↓
Environment variables
↓
Project configuration
↓
User configuration
↓
Defaults
```

### Validation

Configuration must be validated before execution.

### Profiles

Allow project/user profiles where useful.

Example:

```text
default
development
production
testing
```

### Secrets

Support references rather than raw credentials.

### Configuration Diagnostics

Provide useful validation errors.

Example:

```text
Provider "deepseek":
API key reference is missing.
```

rather than generic errors.

---

# 21. Phase 17 — Testing Expansion

## Objective

Move testing from feature coverage toward failure-resilience coverage.

### Unit Tests

Increase coverage for:

- State transitions
- Retry logic
- Provider errors
- Pipeline conditions
- Storage
- Protocol parsing
- Report validation
- Planner validation

### Integration Tests

Test:

```text
OmniNode
 → Provider
 → Agent
 → Report
 → Aggregation
 → Planner
```

### Failure Matrix

Explicitly test:

- Timeout
- Cancellation
- Provider 429
- Provider 500
- Network failure
- Invalid API key
- Model unavailable
- Agent crash
- Agent timeout
- Malformed JSONL
- Huge output
- Missing dependency
- Corrupted persistence
- Duplicate execution
- Partial pipeline failure
- Remembera unavailable
- OmniHilbras unavailable

### E2E Tests

Create realistic workflows:

```text
User
 ↓
Task
 ↓
Multiple Agents
 ↓
Reports
 ↓
Aggregation
 ↓
Planner
 ↓
Final Plan
```

### Regression Tests

Every production bug fixed in v2 should receive a regression test.

### Target

The final v2 release should maintain a strong automated test suite and should not reduce existing v1 coverage.

---

# 22. Phase 18 — Documentation Overhaul

## Objective

Bring all documentation in line with the actual v2 system.

### Required Documents

```text
README.md
ARCHITECTURE.md
DEVELOPMENT_PLAN.md
SECURITY.md
CONTRIBUTING.md
PROTOCOL.md
PROVIDERS.md
AGENTS.md
PIPELINES.md
PERSISTENCE.md
MEMORY.md
CLI.md
TROUBLESHOOTING.md
MIGRATION.md
CHANGELOG.md
```

### README

Rewrite outdated v1 references.

Clearly explain:

- What OmniNode is
- What it is not
- Core architecture
- Providers
- Agents
- Pipelines
- Reports
- Planner
- Remembera
- OmniHilbras
- CLI
- Installation
- Quick start

### Architecture

Document:

```text
Core
Provider Layer
Agent Layer
Task Layer
Pipeline Layer
Report Layer
Planner Layer
Memory Layer
Persistence Layer
Observability Layer
```

### Protocol

Publish the OmniNode Agent Protocol v2 specification.

### Migration

Document:

```text
v1 → v2
```

including:

- Breaking changes
- Deprecated APIs
- Configuration changes
- Storage migrations
- Protocol changes
- CLI changes

---

# 23. Phase 19 — API & Package Quality

## Objective

Prepare `@hilbras/omninode` for external consumers.

### Public Exports

Audit all exports.

Only intentionally public APIs should be exported.

### Type Quality

Ensure:

- No unnecessary `any`
- Strong types
- Good generic usage
- Correct optionality
- Stable interfaces

### Runtime Validation

Use schema validation at external boundaries.

### Package Contents

Ensure npm package contains only required files.

Exclude:

```text
tests
internal development artifacts
local data
temporary files
```

where appropriate.

### Package Metadata

Verify:

```text
name
version
description
keywords
repository
homepage
bugs
license
engines
exports
types
files
```

---

# 24. Phase 20 — Performance & Resource Management

## Objective

Improve resource safety without prematurely optimizing the entire system.

### Memory

Avoid:

- Unbounded report accumulation
- Unbounded stdout
- Unbounded logs
- Large context duplication

### Processes

Ensure:

- Child processes terminate correctly
- Timers are cleaned up
- Streams are closed
- Event listeners are removed

### Network

Ensure:

- Connections are released
- Timeouts exist
- Retries are bounded

### Pipeline

Prevent accidental execution storms.

Basic scheduling limits may be introduced where necessary for safety, but sophisticated dynamic concurrency management remains future scope.

---

# 25. Phase 21 — Developer Experience

## Objective

Make OmniNode easier to develop and extend.

### Development Commands

Provide predictable scripts:

```text
npm run build
npm run test
npm run test:watch
npm run lint
npm run typecheck
npm run clean
```

### Local Development

Document:

```text
Node.js version
npm version
environment variables
test setup
provider setup
agent setup
```

### Contribution Workflow

Document:

```text
branch
→ implementation
→ tests
→ lint
→ typecheck
→ review
→ release
```

### Extension Guide

Create guides for:

```text
Creating a Provider
Creating an Agent Adapter
Creating a Storage Adapter
Creating a Memory Adapter
Creating a Planner
```

---

# 26. Phase 22 — CI/CD Hardening

## Objective

Make releases more reliable.

### CI

Run:

```text
install
lint
typecheck
test
build
package validation
```

against supported Node.js versions.

### Security

Add:

- Dependency audit
- Lockfile validation
- Secret scanning where appropriate
- Supply-chain checks

### Release Validation

Before release:

```text
CI
 ↓
Tests
 ↓
Build
 ↓
Package
 ↓
npm package validation
 ↓
Release
```

### GitHub Release

Each release must include:

- Version
- Highlights
- Breaking changes
- Bug fixes
- Migration notes
- Known limitations

---

# 27. Phase 23 — Migration from v1 to v2

## Objective

Make the v2 upgrade predictable.

### Migration Categories

```text
API
Configuration
Storage
CLI
Agent Protocol
Provider Configuration
Pipeline Definitions
```

### Compatibility

Where practical:

- Preserve v1 APIs temporarily.
- Deprecate rather than immediately remove.
- Provide migration warnings.

### Breaking Changes

All intentional breaking changes must be explicitly documented.

### Migration Tooling

If storage changes significantly, provide a migration command.

Example:

```text
omninode migrate
```

---

# 28. Phase 24 — Final Hardening

Before declaring v2.0.0 stable, perform a full system audit.

### Architecture Audit

Check:

- Module boundaries
- Dependency direction
- Public APIs
- Adapter isolation

### Security Audit

Check:

- Secrets
- Process execution
- Environment variables
- File access
- Input validation
- Output limits

### Reliability Audit

Check:

- Retry behavior
- Timeout behavior
- Cancellation
- Unknown states
- Persistence failures

### Protocol Audit

Check:

- Message validation
- Correlation
- Version compatibility
- Malformed input

### Performance Audit

Check:

- Memory
- Processes
- Network resources
- Large reports
- Large outputs

---

# 29. v2.0.0 Release Criteria

OmniNode v2.0.0 should not be released until all of the following are satisfied.

## Core

- [ ] Architecture stabilized
- [ ] Public APIs reviewed
- [ ] State machine hardened
- [ ] Execution lifecycle documented

## Agents

- [ ] Agent Protocol v2 implemented
- [ ] Process adapter hardened
- [ ] Process cleanup implemented
- [ ] Protocol validation implemented
- [ ] Agent failures isolated

## Pipelines

- [ ] Pipeline cancellation implemented
- [ ] Failure propagation defined
- [ ] Pipeline validation hardened
- [ ] Recovery after interruption supported

## Providers

- [ ] Provider interface stabilized
- [ ] Model metadata improved
- [ ] Error normalization implemented
- [ ] OpenAI-compatible adapter hardened
- [ ] OmniHilbras adapter hardened

## Memory

- [ ] Remembera contract formalized
- [ ] Memory retrieval improved
- [ ] Remembera failure is handled safely
- [ ] Memory remains optional

## Reports

- [ ] Report schema stabilized
- [ ] Findings validated
- [ ] Provenance preserved
- [ ] Aggregation conflicts preserved

## Planner

- [ ] Planner interface stabilized
- [ ] Structured plan validation implemented
- [ ] Planner remains provider-agnostic

## Persistence

- [ ] Storage interfaces stabilized
- [ ] Atomic writes implemented
- [ ] Schema versioning implemented
- [ ] Migration path documented

## Security

- [ ] Secret handling reviewed
- [ ] Process execution reviewed
- [ ] Environment handling reviewed
- [ ] Output limits implemented
- [ ] Security documentation updated

## CLI

- [ ] CLI commands standardized
- [ ] JSON output supported
- [ ] Exit codes documented
- [ ] Diagnostics improved

## Testing

- [ ] Unit tests
- [ ] Integration tests
- [ ] E2E tests
- [ ] Failure matrix
- [ ] Regression tests

## Documentation

- [ ] README updated
- [ ] Architecture updated
- [ ] Protocol documented
- [ ] Migration guide written
- [ ] Security documentation updated
- [ ] CLI documentation updated

## Release

- [ ] CI passing
- [ ] Build passing
- [ ] Package validation passing
- [ ] npm package verified
- [ ] GitHub release prepared
- [ ] Changelog finalized

---

# 30. GitHub + npm Release Strategy

Every completed phase should be committed and pushed.

Recommended process:

```text
Phase completed
      ↓
Run tests
      ↓
Run lint
      ↓
Run typecheck
      ↓
Run build
      ↓
Update documentation
      ↓
Commit
      ↓
Push to GitHub
```

Intermediate releases should be created when appropriate.

Example:

```text
v2.0.0-alpha.1
v2.0.0-alpha.2
v2.0.0-beta.1
v2.0.0-beta.2
v2.0.0-rc.1
v2.0.0
```

Before final release:

```text
npm publish
+
GitHub Release
```

The final release should be generated only after all release gates pass.

---

# 31. Recommended Development Sequence

The recommended implementation order is:

```text
Phase 1
Architecture Stabilization
        ↓
Phase 2
Execution Reliability
        ↓
Phase 3
Agent Protocol v2
        ↓
Phase 4
Agent Adapter Hardening
        ↓
Phase 5
Pipeline Lifecycle
        ↓
Phase 6
Provider Infrastructure
        ↓
Phase 7
OmniHilbras Integration
        ↓
Phase 8
Remembera Integration
        ↓
Phase 9
Report System
        ↓
Phase 10
Aggregation
        ↓
Phase 11
Planner
        ↓
Phase 12
Persistence
        ↓
Phase 13
Security
        ↓
Phase 14
Observability
        ↓
Phase 15
CLI
        ↓
Phase 16
Configuration
        ↓
Phase 17
Testing
        ↓
Phase 18
Documentation
        ↓
Phase 19
Package/API Quality
        ↓
Phase 20
Performance
        ↓
Phase 21
Developer Experience
        ↓
Phase 22
CI/CD
        ↓
Phase 23
Migration
        ↓
Phase 24
Final Hardening
        ↓
v2.0.0
```

---

# 32. What OmniNode v2.0.0 Should Become

At the end of this roadmap, OmniNode should provide a stable orchestration foundation:

```text
                    OmniNode v2
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
    Providers         Agents          Remembera
        │                │                │
        ▼                ▼                ▼
   AI Models        CLI Agents        Project Memory
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                  Task Engine
                         │
                         ▼
                 Pipeline Engine
                         │
                         ▼
                  Report System
                         │
                         ▼
                   Aggregation
                         │
                         ▼
                     Planner
                         │
                         ▼
                  Execution Plan
```

The important distinction is:

> **OmniNode v2.0.0 is the reliability and interoperability release.**

It should establish a strong foundation before OmniNode moves into more advanced orchestration intelligence.

---

# 33. Future Roadmap After v2.0.0

After v2.0.0 is stable, future versions can progressively introduce:

### v2.x

- Advanced provider health
- Better execution scheduling
- More agent integrations
- Better memory retrieval
- More sophisticated aggregation
- Additional observability

### v3.x

Potentially introduce:

- Dynamic Model Router
- Consensus Engine
- Verification Loops
- Advanced project intelligence
- Advanced parallel execution
- Cost/token management

### Later

Potentially introduce:

- Replayable execution
- Context compression
- Human approval workflows
- Role Packs
- Learning from outcomes
- Distributed execution

These should only be introduced after the v2 foundation proves reliable.

---

# 34. Final v2.0.0 Definition

OmniNode v2.0.0 should be considered successful when it can reliably perform:

```text
User Task
    ↓
Task Creation
    ↓
Context Loading
    ↓
Agent Selection
    ↓
Agent Execution
    ↓
Multiple Independent Reports
    ↓
Report Validation
    ↓
Report Aggregation
    ↓
Planner
    ↓
Structured Execution Plan
    ↓
Execution
    ↓
Result
    ↓
Persistence
    ↓
Audit / Diagnostics
```

while correctly handling:

```text
timeouts
failures
retries
cancellation
provider errors
agent crashes
malformed messages
persistence errors
partial pipeline failures
unknown execution states
```

without compromising OmniNode's modular architecture.

---

# 35. v2.0.0 Success Statement

**OmniNode v2.0.0 will be the stable production foundation of the Hilbras multi-agent ecosystem.**

It will provide:

- A stable provider abstraction
- A stable agent protocol
- Reliable task execution
- Reliable pipeline execution
- Strong process handling
- Structured reports
- Deterministic aggregation
- Provider-agnostic planning
- Optional Remembera integration
- Optional OmniHilbras integration
- Strong persistence foundations
- Better security
- Better observability
- A mature CLI
- Comprehensive testing
- Production-grade documentation

The goal is not to make OmniNode the most feature-heavy agent platform.

The goal is to make it the **reliable orchestration layer on which more advanced OmniNode capabilities can safely be built.**