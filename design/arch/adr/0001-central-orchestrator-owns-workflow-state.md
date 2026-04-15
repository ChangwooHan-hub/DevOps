# ADR-0001: Central Orchestrator Owns Workflow State

## Status

Accepted

## Context

The system coordinates multiple agents across issue triage, planning, implementation, validation, and review. If each agent can change workflow state independently, duplicate transitions, race conditions, and inconsistent audit records become likely.

## Decision

All workflow state transitions are owned by the orchestrator.

- agents may read input artifacts and emit output artifacts
- agents may not directly transition work item state
- GitHub side effects are executed through orchestrator-controlled adapters

## Consequences

- state transitions are easier to audit and replay
- policy evaluation has a single enforcement point
- agent implementations stay narrower and easier to replace
- orchestration service becomes a critical dependency and must be durable

