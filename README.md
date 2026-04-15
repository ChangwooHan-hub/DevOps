# UWB AI Pipeline

NestJS monorepo for a GitHub-integrated AI agent pipeline.

## Services

- `services/webhook-api`: GitHub webhook ingress, signature verification, allowlist checks, optional queue enqueue, webhook dedupe
- `services/orchestrator`: durable-ready work item orchestration, transition gates, immutable approval ledger API, queue consumer
- `services/orchestrator`: durable-ready work item orchestration, transition gates, immutable approval ledger API, queue consumer, auto-trigger to runner on `APPROVED_FOR_DEV`
- `services/runner-service`: budget-checked execution planning, coding/review/merge-decision agent loops (LLM -> patch/review/decision), plus deterministic validation runs
- `services/llm-gateway`: structured LLM call boundary
- `services/ops-ui`: placeholder for the admin UI

## Shared Packages

- `packages/domain`: shared enums and event contracts

## Quick Start

```bash
cmd /c npm.cmd install
cmd /c npm.cmd run db:migrate
cmd /c npm.cmd run build
cmd /c npm.cmd run start:webhook-api
```

## Agent Spec

- `agents.md` defines role instructions for:
  - `planning_agent`
  - `coding_agent`
  - `code_review_agent`
  - `merge_decision_agent`
- `runner-service` loads this file at runtime (`AGENTS_SPEC_PATH`).
- If `AGENTS_SPEC_REQUIRED=true`, missing/empty role sections will fail runs.
- Real coding execution is blocked when `LLM_PROVIDER=mock` unless `RUNNER_ALLOW_MOCK_EXECUTION=true`.

## Next Steps

1. Wire PostgreSQL migration execution and Redis provisioning for non-local environments.
2. Extend artifact storage from inline metadata to object storage-backed blobs.
3. Connect runner execution to isolated worktrees/containers and full CI policy checks.
