# API Specification

This document describes the current HTTP surface for the NestJS services. Several flows remain incremental, but PostgreSQL-ready state persistence, queue ingestion, and schema-validated LLM boundaries are now wired.

## Conventions

- Base path examples assume local development only.
- All payloads are JSON unless otherwise stated.
- Error handling is currently placeholder-grade and must be expanded before production use.
- Authentication is not yet implemented on internal service-to-service endpoints.

## 1. webhook-api

### `GET /health`

Returns service liveness.

Response:

```json
{
  "status": "ok",
  "service": "webhook-api"
}
```

### `POST /github/webhooks`

Receives GitHub webhooks, verifies signature, suppresses duplicate deliveries, validates allowlists, and routes events to the orchestrator queue.

Headers:

- `X-GitHub-Event`: required
- `X-GitHub-Delivery`: required
- `X-Hub-Signature-256`: required

Request body:

- Raw GitHub webhook JSON payload

Success response:

```json
{
  "accepted": true,
  "routedTo": "orchestrator-queue",
  "event": {
    "deliveryId": "abc",
    "eventName": "issues",
    "action": "opened",
    "repositoryId": 123,
    "installationId": 456,
    "receivedAt": "2026-04-13T00:00:00.000Z"
  }
}
```

Duplicate response:

```json
{
  "accepted": false,
  "duplicate": true,
  "deliveryId": "abc"
}
```

## 2. orchestrator

### `GET /health`

Returns service liveness.

### `GET /work-items`

Returns all current work items (PostgreSQL-backed when `DATABASE_URL` is configured, otherwise in-memory fallback).

Current response shape:

```json
[
  {
    "id": "uuid",
    "repositoryId": "repo-1",
    "sourceType": "issue",
    "issueNumber": 12,
    "title": "Fix token refresh",
    "state": "OPEN",
    "createdAt": "2026-04-13T00:00:00.000Z",
    "updatedAt": "2026-04-13T00:00:00.000Z"
  }
]
```

### `GET /work-items/:id`

Returns a single work item by ID.

### `GET /work-items/:id/transitions`

Returns the state transition audit trail for the work item.

### `POST /work-items`

Creates a work item from issue-like input.

Request:

```json
{
  "title": "Fix token refresh",
  "repositoryId": "repo-1",
  "issueNumber": 12
}
```

Response:

```json
{
  "id": "uuid",
  "repositoryId": "repo-1",
  "sourceType": "issue",
  "issueNumber": 12,
  "title": "Fix token refresh",
  "state": "OPEN",
  "createdAt": "2026-04-13T00:00:00.000Z",
  "updatedAt": "2026-04-13T00:00:00.000Z"
}
```

### `PATCH /work-items/:id/state`

Transitions a work item to a new state.

Request:

```json
{
  "state": "TRIAGED"
}
```

Response:

```json
{
  "id": "uuid",
  "state": "TRIAGED",
  "updatedAt": "2026-04-13T00:10:00.000Z"
}
```

Transition gates:

- `PLANNED -> APPROVED_FOR_DEV` requires latest `plan` approval event action to be `approved`.
- `REVIEW_PASSED -> MERGE_READY` requires latest `merge` approval event action to be `approved`.

Automation side effect:

- On successful transition to `APPROVED_FOR_DEV`, orchestrator can auto-trigger `runner-service /runner/agent-runs` when `RUNNER_AUTOTRIGGER_ENABLED=true` and repository path mapping is configured.
- On successful transition to `REVIEWING`, orchestrator can auto-trigger `runner-service /runner/review-runs` when `RUNNER_AUTOTRIGGER_REVIEW_ENABLED=true`.
- On successful transition to `REVIEW_PASSED`, orchestrator can auto-trigger `runner-service /runner/merge-decision-runs` when `RUNNER_AUTOTRIGGER_MERGE_ENABLED=true`.

### `POST /approvals`

Appends an immutable approval event.

Request:

```json
{
  "workItemId": "uuid",
  "subjectType": "plan",
  "subjectId": "uuid",
  "action": "approved",
  "actorType": "user",
  "actorId": "alice",
  "reason": "plan looks safe"
}
```

### `GET /approvals/:workItemId`

Returns approval ledger events for a work item in chronological order.

## 3. runner-service

### `GET /health`

Returns service liveness.

### `POST /runner/execution-plans`

Builds a bounded execution plan for a Dev Agent run.

Request:

```json
{
  "repository": "org/repo",
  "branchName": "fix/198-null-refresh-token",
  "budget": {
    "maxRuntimeSeconds": 1200,
    "maxChangedFiles": 6,
    "maxLocDelta": 250,
    "maxLlmCalls": 12
  }
}
```

Response:

```json
{
  "repository": "org/repo",
  "branchName": "fix/198-null-refresh-token",
  "budget": {
    "maxRuntimeSeconds": 1200,
    "maxChangedFiles": 6,
    "maxLocDelta": 250,
    "maxLlmCalls": 12
  },
  "executionMode": "ephemeral",
  "nextSteps": [
    "clone repository",
    "checkout base branch",
    "create agent branch",
    "apply patch",
    "run validation subset",
    "commit and push"
  ]
}
```

### `POST /runner/agent-runs`

Runs an end-to-end coding agent loop:

1. planning LLM call (`planning_output`)
2. coding patch LLM call (`coding_patch_output`)
3. branch prepare + patch apply (`git apply --index`)
4. optional validation commands
5. commit + push
6. optional pull request creation

Notes:

- Role instructions are loaded from `agents.md` (`AGENTS_SPEC_PATH`).
- When `AGENTS_SPEC_REQUIRED=true`, missing/empty role sections fail the run.
- With default safety policy, `LLM_PROVIDER=mock` is dry-run only unless `RUNNER_ALLOW_MOCK_EXECUTION=true`.

Request:

```json
{
  "repository": "org/repo",
  "repositoryPath": "C:\\repo\\working-copy",
  "taskPrompt": "Implement null-safe token refresh flow",
  "budget": {
    "maxRuntimeSeconds": 1200,
    "maxChangedFiles": 6,
    "maxLocDelta": 250,
    "maxLlmCalls": 12
  },
  "baseBranch": "main",
  "branchName": "agent/fix-token-refresh",
  "openPullRequest": true,
  "draftPullRequest": true,
  "dryRun": false
}
```

### `POST /runner/review-runs`

Runs a code review agent loop and stores `agent_runs(agent_type='review')` when `workItemId` is provided.

Request:

```json
{
  "repository": "org/repo",
  "workItemId": "uuid",
  "reviewPrompt": "Review issue #9 changes and identify blocking findings"
}
```

### `POST /runner/merge-decision-runs`

Runs a merge readiness decision loop and stores `agent_runs(agent_type='merge_readiness')` when `workItemId` is provided.

Request:

```json
{
  "repository": "org/repo",
  "workItemId": "uuid",
  "decisionPrompt": "Assess merge readiness for issue #9 after review passed"
}
```

Response (shape excerpt):

```json
{
  "mode": "executed",
  "repository": "org/repo",
  "branchName": "agent/fix-token-refresh",
  "actualLlmCalls": 2,
  "changedFiles": 3,
  "locDelta": 88,
  "pullRequest": {
    "number": 42,
    "url": "https://github.com/org/repo/pull/42",
    "state": "open",
    "draft": true
  }
}
```

## 4. llm-gateway

### `GET /health`

Returns service liveness.

### `GET /llm/schemas`

Returns currently supported structured output contracts.

Response:

```json
[
  {
    "schemaName": "triage_output",
    "requiredFields": ["summary", "workType", "impactAreas", "suggestedLabels", "nextAction"]
  },
  {
    "schemaName": "planning_output",
    "requiredFields": [
      "summary",
      "branchName",
      "candidateFiles",
      "testPlan",
      "riskLevel",
      "executionBudget",
      "nextAction"
    ]
  }
]
```

### `POST /llm/structured-completions`

Produces a schema-scoped structured completion.

- `LLM_PROVIDER=mock` (default): deterministic local mock output.
- `LLM_PROVIDER=openai-compatible`: calls `/chat/completions` on `LLM_API_BASE_URL` with `response_format=json_object`.
- Supported `schemaName`: `triage_output`, `planning_output`, `review_output`, `merge_readiness_output`, `coding_patch_output`.
- Unsupported `schemaName` is rejected with `400`.

Request:

```json
{
  "model": "claude-sonnet-4-6",
  "systemPrompt": "You are a planning agent.",
  "userPrompt": "Plan the fix.",
  "schemaName": "planning_output"
}
```

Response:

```json
{
  "model": "claude-sonnet-4-6",
  "schemaName": "planning_output",
  "accepted": true,
  "provider": "mock",
  "latencyMs": 3,
  "output": {
    "summary": "Planning draft for prompt: Plan the fix.",
    "branchName": "agent/fix-token-refresh",
    "candidateFiles": [
      "services/orchestrator/src/work-items/work-items.service.ts",
      "packages/domain/src/work-items/work-item.interface.ts"
    ],
    "testPlan": ["Run unit tests for work-items module", "Run full build"],
    "riskLevel": "medium",
    "executionBudget": {
      "maxRuntimeSeconds": 1200,
      "maxChangedFiles": 6,
      "maxLocDelta": 250,
      "maxLlmCalls": 12
    },
    "nextAction": "request plan approval before dev execution"
  }
}
```

### `POST /runner/executions`

Validates budget and prepares an agent branch run. With `dryRun=true` (default), only plan metadata is returned.

Request:

```json
{
  "repository": "org/repo",
  "branchName": "agent/fix-token-refresh",
  "budget": {
    "maxRuntimeSeconds": 1200,
    "maxChangedFiles": 6,
    "maxLocDelta": 250,
    "maxLlmCalls": 12
  },
  "repositoryPath": "C:\\repo\\working-copy",
  "dryRun": true
}
```

### `POST /runner/validation-runs`

Runs deterministic validation commands and returns structured pass/fail output.

Request:

```json
{
  "repositoryPath": "C:\\repo\\working-copy",
  "commands": [{ "name": "typecheck", "command": "cmd /c npm.cmd run build" }],
  "timeoutSeconds": 900
}
```

Response:

```json
{
  "passed": true,
  "mode": "deterministic",
  "timeoutSeconds": 900,
  "commands": [
    {
      "name": "typecheck",
      "command": "cmd /c npm.cmd run build",
      "passed": true,
      "stdout": "...",
      "stderr": "",
      "durationMs": 1200
    }
  ]
}
```

## 5. Still Planned Internal APIs

The following APIs are planned but not implemented yet:

- `POST /events/github`
  - internal webhook-to-orchestrator handoff
- `POST /artifacts`
  - register output artifacts and checksums
- `POST /policy/evaluate`
  - evaluate path risk, budget, and merge readiness
