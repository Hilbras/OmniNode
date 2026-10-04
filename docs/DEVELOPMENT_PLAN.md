# OmniNode — Complete Development Plan

## 1. Product Overview

**OmniNode** is a provider-agnostic multi-AI orchestration platform that connects CLI-based AI agents, AI providers, persistent memory, roles, reports, and planning into a unified execution system.

OmniNode is **not an AI provider** and is **not dependent on OmniHilbras**.

Its primary responsibility is to coordinate different AI systems and agents so they can collaborate on complex software engineering and knowledge-work tasks.

### Core Concept

```text
User / CLI Agent
       │
       ▼
   OmniNode
       │
       ├── Remembera
       ├── Agent Integrations
       ├── Provider Integrations
       ├── Roles
       ├── Reports
       └── Planning
       │
       ▼
Multiple AI Systems
       │
       ▼
Final Decision / Plan
       │
       ▼
Execution Agent
```

---

# 2. Core Design Principles

OmniNode must follow these principles from day one.

## Provider Agnostic

OmniNode must not depend on:

- OmniHilbras
- OpenAI
- Gemini
- DeepSeek
- Qwen
- Kimi
- OpenRouter
- Any specific AI company

All providers must integrate through a common provider interface.

## Agent Agnostic

OmniNode should support different CLI agents without hardcoding their internal architecture.

Examples:

- Kimi CLI
- OpenCode
- Cline
- Claude Code
- Other compatible agents
- Custom user-built agents

## Memory Agnostic

Remembera should be the preferred Hilbras memory integration, but OmniNode's core should not require Remembera to operate.

## Modular

Every major integration should be replaceable:

- Provider
- Agent
- Memory
- Role
- Pipeline
- Transport
- Storage

## Local First

OmniNode should work locally without requiring a mandatory cloud service.

---

# 3. High-Level Architecture

```text
                         ┌──────────────────────┐
                         │        User          │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │      CLI / API       │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │      OmniNode        │
                         │                      │
                         │  Task Engine         │
                         │  Pipeline Engine     │
                         │  Role System         │
                         │  Agent Registry      │
                         │  Provider Manager    │
                         │  Report System       │
                         │  Planning Engine     │
                         │  Context Manager     │
                         └───────┬──────┬───────┘
                                 │      │
                    ┌────────────┘      └────────────┐
                    ▼                                ▼
             ┌─────────────┐                 ┌──────────────┐
             │  Remembera  │                 │ AI Providers │
             └─────────────┘                 └──────┬───────┘
                                                    │
                            ┌───────────────────────┼────────────────────┐
                            ▼                       ▼                    ▼
                         Kimi                    Gemini               Qwen
                            │                       │                    │
                            └───────────────────────┼────────────────────┘
                                                    ▼
                                               Planner AI
                                                    │
                                                    ▼
                                             Execution Agent
```

---

# 4. Main Components

## 4.1 OmniNode Core

The core runtime is responsible for:

- Task lifecycle
- Pipeline execution
- Role assignment
- Agent coordination
- Provider communication
- Report collection
- Context management
- Execution state
- Error handling
- Events

The core must remain independent from individual providers.

---

# 5. Provider System

OmniNode needs a unified provider abstraction.

```text
Provider
├── Name
├── Base URL
├── Authentication
├── Models
├── Capabilities
├── Health
└── Connection Status
```

### Supported Provider Types

Initial architecture should support:

- OpenAI-compatible APIs
- OmniHilbras API
- OpenRouter-compatible APIs
- Local providers
- Custom APIs

OmniHilbras is simply one provider source.

---

# 6. OmniHilbras Integration

OmniHilbras should be an optional integration.

The user can provide:

```text
Base URL
API Key
```

OmniNode then:

```text
Connect
   ↓
Authenticate
   ↓
Fetch Models
   ↓
Validate Models
   ↓
Register Available Models
```

Example:

```text
OmniHilbras
├── Kimi
├── Qwen
├── DeepSeek
└── Gemini
```

OmniNode must not care whether these models originate from OmniHilbras or another gateway.

---

# 7. Custom Provider Support

Users should be able to add their own provider.

Example:

```yaml
provider:
  name: My Gateway
  type: openai-compatible
  base_url: https://example.com/v1
  api_key: ${MY_API_KEY}
```

OmniNode should then discover available models through the provider's API.

---

# 8. Model Registry

OmniNode maintains a normalized model registry.

Example:

```text
Model
├── Provider
├── Model ID
├── Display Name
├── Capabilities
├── Context Window
├── Status
└── Metadata
```

Example:

```json
{
  "provider": "custom-gateway",
  "id": "qwen3-coder",
  "capabilities": {
    "chat": true,
    "coding": true,
    "tools": true
  }
}
```

---

# 9. CLI Agent Integration

This is one of OmniNode's most important components.

OmniNode should support two integration mechanisms.

## Native Adapter

For agents that expose APIs, hooks, plugins, or structured interfaces.

```text
OmniNode
   ↓
Agent Adapter
   ↓
CLI Agent
```

## Process Adapter

For agents without a native integration.

```text
OmniNode
   ↓
Process Adapter
   ↓
stdin/stdout
   ↓
CLI Agent
```

The process adapter should manage:

- Process lifecycle
- stdin
- stdout
- stderr
- Exit codes
- Environment variables
- Working directory
- Logs
- Task completion

---

# 10. Agent Registry

OmniNode should maintain a registry of connected agents.

Example:

```yaml
agents:
  opencode:
    type: cli
    command: opencode

  kimi:
    type: cli
    command: kimi

  custom-agent:
    type: process
    command: ./my-agent
```

Each agent should expose metadata such as:

```text
Agent
├── Name
├── Version
├── Capabilities
├── Command
├── Working Directory
├── Status
└── Integration Type
```

---

# 11. Role System

Roles define **what an AI is supposed to do**, rather than which provider it must use.

Examples:

- Architecture Reviewer
- Security Reviewer
- Code Reviewer
- Researcher
- Planner
- Tester
- Documentation Reviewer

A role can define:

```yaml
role:
  name: Architecture Reviewer

  responsibilities:
    - architecture analysis
    - identify structural problems
    - recommend improvements

  output:
    - findings
    - evidence
    - recommendations
```

Roles should remain provider-independent.

---

# 12. Project System

OmniNode should understand projects as first-class entities.

```text
Project
├── Repository
├── Workspace
├── Agents
├── Roles
├── Tasks
├── Reports
├── Context
└── Memory
```

Example:

```text
Remembra
├── Architecture Reviewer
├── Security Reviewer
├── Code Reviewer
├── Planner
└── Execution Agent
```

---

# 13. Task System

Every operation becomes a Task.

```text
Task
├── ID
├── Project
├── Objective
├── Role
├── Agent
├── Context
├── Status
├── Reports
└── Result
```

Task states:

```text
created
queued
running
waiting
completed
failed
cancelled
```

---

# 14. Pipeline Engine

The Pipeline Engine coordinates multiple AI operations.

Example:

```yaml
pipeline:

  - research:
      agents:
        - kimi
        - gemini
        - qwen

  - collect_reports

  - analyze_reports

  - planner:
      model: chatgpt

  - execute:
      agent: opencode
```

The engine should support:

- Sequential execution
- Parallel execution
- Dependencies
- Conditional execution
- Retries
- Task outputs

---

# 15. Multi-AI Research

A major feature of OmniNode is independent AI analysis.

Example:

```text
                Task
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      Kimi      Gemini     Qwen
        │         │         │
        ▼         ▼         ▼
     Report    Report     Report
        └─────────┼─────────┘
                  ▼
             OmniNode
                  │
                  ▼
               Planner
```

Each AI should initially receive the appropriate task context rather than the reports from the other models.

This preserves independent analysis.

---

# 16. Report System

Reports should use a structured format.

```text
Report
├── Task
├── Agent
├── Model
├── Summary
├── Findings
├── Evidence
├── Recommendations
├── Confidence
└── Metadata
```

This allows OmniNode to process reports programmatically rather than treating them as arbitrary text.

---

# 17. Report Aggregation

After multiple AI systems finish:

```text
Reports
   ↓
Normalizer
   ↓
Aggregator
   ↓
Combined Intelligence
```

OmniNode should:

- Normalize formats
- Identify duplicate findings
- Preserve source attribution
- Group related findings
- Prepare the combined context

---

# 18. Planner Layer

The Planner receives:

```text
Original Task
+
Project Context
+
Relevant Memory
+
AI Reports
+
Role Definitions
```

The Planner then produces:

```text
Final Analysis
+
Prioritized Findings
+
Implementation Plan
+
Execution Instructions
```

ChatGPT can be used as the planner, but **must not be hardcoded as the only planner**.

---

# 19. Remembera Integration

Remembera provides persistent intelligence.

OmniNode should integrate with Remembera for:

## Project Memory

```text
Project history
Decisions
Architecture
Known problems
Previous tasks
```

## Role Memory

```text
Role definitions
Role behavior
Project-specific instructions
```

## Task Memory

```text
Previous reports
Previous outcomes
Important findings
```

## Knowledge

```text
Project conventions
Technical decisions
Relevant historical context
```

---

# 20. Context Retrieval

Before starting a task:

```text
Task
 ↓
OmniNode
 ↓
Remembera
 ↓
Relevant Context
 ↓
Role Context
 ↓
AI Agents
```

Only relevant memory should be passed into each task.

---

# 21. Agent ↔ OmniNode Communication

OmniNode should provide a standard protocol.

Conceptually:

```text
Agent → OmniNode

TASK_REQUEST
REPORT
STATUS
QUESTION
ARTIFACT
COMPLETION
ERROR
```

And:

```text
OmniNode → Agent

TASK
CONTEXT
ROLE
INSTRUCTION
PLAN
FEEDBACK
VERIFICATION_RESULT
```

This protocol becomes the foundation for future integrations.

---

# 22. CLI

OmniNode should have its own CLI.

Example:

```bash
omninode init
omninode provider add
omninode provider list
omninode agent add
omninode agent list
omninode role list
omninode project init
omninode task create
omninode task run
omninode task status
omninode report list
```

Example:

```bash
omninode task run audit-remembra
```

---

# 23. Configuration

Use a project configuration file.

Example:

```yaml
project:
  name: Remembra

providers:
  - omnihilbras
  - custom-gateway

agents:
  - opencode

roles:
  - architecture-reviewer
  - security-reviewer
  - planner

memory:
  provider: remembera
```

---

# 24. Security

Security needs to be part of the architecture from the beginning.

Sensitive credentials should never be stored directly in project files.

Support:

- Environment variables
- Secure credential storage
- API key masking
- Permission boundaries
- Process isolation where possible
- Command execution restrictions
- Audit logging

This is especially important because OmniNode may control CLI agents capable of executing commands.

---

# 25. Local Runtime

The initial version should work locally.

```text
User Machine
│
├── OmniNode
├── CLI Agents
├── Project Files
└── Optional Local Providers
```

Cloud infrastructure should not be required for basic operation.

---

# 26. Suggested Repository Structure

```text
OmniNode/
│
├── core/
│   ├── tasks/
│   ├── pipelines/
│   ├── roles/
│   ├── projects/
│   ├── reports/
│   └── context/
│
├── providers/
│   ├── openai-compatible/
│   ├── omnihilbras/
│   ├── openrouter/
│   └── custom/
│
├── agents/
│   ├── process/
│   ├── native/
│   └── adapters/
│
├── integrations/
│   └── remembera/
│
├── protocol/
│
├── cli/
│
├── config/
│
├── tests/
│
└── docs/
```

---

# 27. Development Roadmap

## Phase 0 — Architecture & Foundation

### Goals

Establish the project foundation.

### Work

- Repository initialization
- License
- Documentation
- Architecture specification
- Core interfaces
- Configuration system
- Logging
- Error model
- Basic CLI
- Test infrastructure
- CI/CD

### Deliverable

A functional OmniNode skeleton with no provider or agent dependency.

---

## Phase 1 — Provider Infrastructure

### Goals

Build the provider abstraction.

### Work

- Provider interface
- Authentication system
- Base URL configuration
- Model discovery
- Model registry
- OpenAI-compatible provider
- Custom provider support
- Provider connection testing
- Model availability validation

### Deliverable

```text
OmniNode
   ↓
Provider
   ↓
Models
```

---

## Phase 2 — OmniHilbras Integration

### Goals

Add OmniHilbras without making it a dependency.

### Work

- OmniHilbras provider adapter
- Base URL configuration
- API authentication
- Model discovery
- Model registration
- Connection testing
- Documentation

### Deliverable

Users can connect OmniHilbras and use its API-exposed models.

---

## Phase 3 — CLI Agent System

### Goals

Connect external AI agents.

### Work

- Agent interface
- Agent registry
- Process adapter
- stdin/stdout communication
- Lifecycle management
- Working-directory support
- Structured task protocol
- Status reporting
- Error handling

### Deliverable

```text
OmniNode ↔ CLI Agent
```

---

## Phase 4 — Roles & Tasks

### Goals

Introduce structured AI work.

### Work

- Role system
- Role registry
- Task model
- Project model
- Task lifecycle
- Role assignment
- Task configuration
- Structured outputs

### Deliverable

```text
Project
 ↓
Task
 ↓
Role
 ↓
Agent
```

---

## Phase 5 — Pipeline Engine

### Goals

Allow multiple AI systems to collaborate.

### Work

- Pipeline definition
- Pipeline parser
- Sequential execution
- Parallel execution
- Dependencies
- Task outputs
- Pipeline state
- Failure handling

### Deliverable

```text
Research
   ↓
Reports
   ↓
Planning
   ↓
Execution
```

---

## Phase 6 — Multi-AI Report System

### Goals

Build the intelligence aggregation layer.

### Work

- Report schema
- Report collection
- Report normalization
- Report storage
- Source attribution
- Finding extraction
- Duplicate detection
- Combined report generation

### Deliverable

Multiple AI systems can independently analyze the same task and OmniNode can combine their outputs.

---

## Phase 7 — Remembera Integration

### Goals

Add persistent project intelligence.

### Work

- Remembera adapter
- Project memory retrieval
- Task memory
- Role memory
- Context retrieval
- Memory writing
- Relevant-context selection
- Project history

### Deliverable

```text
Task
 ↓
Remembera
 ↓
Relevant Context
 ↓
AI Agents
 ↓
Reports
 ↓
Remembera
```

---

## Phase 8 — Planner System

### Goals

Introduce the final planning layer.

### Work

- Planner interface
- Planner provider support
- Planner context builder
- Report injection
- Plan schema
- Implementation plan generation
- Planner result storage

The first implementation may use ChatGPT through the supported connection/provider mechanism, but the architecture must allow other planners.

### Deliverable

```text
Multiple AI Reports
        ↓
     Planner
        ↓
Final Implementation Plan
```

---

## Phase 9 — End-to-End Workflow

### Goals

Connect everything.

Example:

```text
User
 ↓
OmniNode
 ↓
Project Context
 ↓
Remembera
 ↓
Research Agents
 ↓
Reports
 ↓
Report Aggregation
 ↓
Planner
 ↓
Implementation Plan
 ↓
Execution Agent
 ↓
Result
```

### Work

- End-to-end workflows
- State persistence
- Context propagation
- Agent handoff
- Report handoff
- Planner handoff
- Error recovery
- Integration testing

---

## Phase 10 — Production Hardening

### Goals

Prepare OmniNode for real-world usage.

### Work

- Security review
- Performance testing
- Reliability testing
- Large-project testing
- Long-running task testing
- CLI UX improvements
- Documentation
- Examples
- Installation packages
- Release automation

---

## Phase 11 — V1.0.0

### V1.0 Definition

OmniNode 1.0 should provide:

- Provider abstraction
- Custom providers
- OmniHilbras API integration
- Model discovery
- CLI Agent integration
- Agent registry
- Roles
- Projects
- Tasks
- Pipelines
- Multi-AI research
- Report aggregation
- Planner layer
- Remembera integration
- CLI
- Configuration
- Security foundations
- Documentation

---

# 28. Example Real-World Workflow

A user wants to audit Remembra.

```bash
omninode task run remembra-audit
```

OmniNode loads:

```text
Project:
Remembra

Memory:
Remembera

Roles:
Architecture Reviewer
Security Reviewer
Code Reviewer
Planner
```

Then:

```text
                 Remembra Audit
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        Kimi         Gemini        Qwen
          │            │            │
       Report        Report       Report
          └────────────┼────────────┘
                       ▼
                 OmniNode
                       │
                       ▼
                    Planner
                       │
                       ▼
              Final Implementation
                    Plan
                       │
                       ▼
                 CLI Agent
                       │
                       ▼
                  Execution
```

---

# 29. V1 Non-Goals

The following should **not** be part of the initial implementation:

- Automatic model routing
- Cost/token budgeting
- Context compression
- Human approval gates
- Advanced provider optimization
- Advanced autonomous learning
- Complex cloud infrastructure
- Mandatory OmniHilbras dependency
- Mandatory Remembera dependency
- Building another AI model
- Replacing existing CLI agents

OmniNode should **orchestrate existing intelligence**, not try to become another model.

---

# 30. Future / Draft Backlog

The previously discussed advanced ideas remain **draft only** and should not affect the current implementation scope.

Potential future additions include:

1. Dynamic Model Router
2. Consensus Engine
3. Evidence-Based Findings
4. Verification Loop
5. Persistent Project Intelligence expansion
6. Role Packs / Role Marketplace
7. Advanced Provider Health & Failover
8. Advanced Parallel Execution
9. Cost / Token Budgeting
10. Event / Audit System
11. Replayable Tasks
12. Context Compression
13. Human Approval Gates

Additional future research:

14. Learning From Outcomes

These features should be evaluated individually after the core system proves stable.

---

# 31. Version Strategy

```text
v0.1.0 — Foundation
v0.2.0 — Provider System
v0.3.0 — OmniHilbras Integration
v0.4.0 — Agent System
v0.5.0 — Roles & Tasks
v0.6.0 — Pipeline Engine
v0.7.0 — Multi-AI Reports
v0.8.0 — Remembera
v0.9.0 — Planner
v0.10.0 — End-to-End Runtime
v1.0.0 — Production Release
```

After each phase:

```text
Implementation
     ↓
Tests
     ↓
Documentation
     ↓
Package / npm Update
     ↓
GitHub Update
     ↓
GitHub Release
```

---

# 32. Final Product Positioning

**OmniNode is not another AI chatbot.**

It is not:

```text
"One AI that answers you."
```

It is:

```text
"An orchestration layer that allows multiple AI systems
and agents to work together on the same task."
```

The Hilbras ecosystem becomes:

```text
                    HILBRAS AI ECOSYSTEM

                         OmniNode
                    Orchestration Layer
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
         Remembera     OmniHilbras    CLI Agents
          Memory       Connectivity    Execution
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                    Multiple AI Models
                           │
                           ▼
                     Planning / Work
```

## Core Architectural Rule

OmniNode must be able to run successfully with **zero Hilbras dependencies**.

OmniHilbras and Remembera make OmniNode significantly more powerful, but neither should be required for the core engine.

This allows OmniNode to become an independent product while remaining deeply integrated with the Hilbras ecosystem.