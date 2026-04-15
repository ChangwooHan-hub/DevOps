# Architecture Overview

## Objective

Provide a safe execution architecture for AI agents that can influence GitHub delivery flow from issue creation through PR review without bypassing human governance or audit requirements.

## Runtime Split

- `webhook-api` terminates GitHub traffic and enforces webhook authenticity.
- `orchestrator` owns workflow state and controls all downstream execution.
- `runner-service` is the only service allowed to mutate git worktrees.
- `llm-gateway` isolates model prompts, schema validation, and usage accounting.
- `ops-ui` is the operator-facing surface for approvals and inspection.

## Core Principle

Agents do not coordinate with each other directly. They communicate by producing artifacts that are stored, validated, and then interpreted by the orchestrator.

## Immediate Gaps

- Persistence is still in-memory.
- Queueing is still synchronous.
- GitHub App, PostgreSQL, BullMQ, and isolated container execution are not yet wired.

