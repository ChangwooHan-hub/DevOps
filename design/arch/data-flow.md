# Data Flow and Contracts

## Event Flow

1. GitHub sends a webhook to `webhook-api`.
2. `webhook-api` verifies the signature and rejects duplicates.
3. `webhook-api` emits a domain event to the orchestrator.
4. The orchestrator records or updates the work item.
5. The orchestrator schedules the appropriate agent run.
6. The agent consumes prior artifacts and produces a structured output artifact.
7. The orchestrator validates the artifact and evaluates policy results.
8. The orchestrator publishes comments, labels, PR updates, or checks back to GitHub.

## Source of Truth by Concern

- workflow state: PostgreSQL
- queueing and transient job delivery: Redis or Temporal backing store
- approval history: append-only approval ledger
- git mutation: isolated runner worktree
- repository state: GitHub
- notifications: Slack as secondary channel only

## Artifact Flow

- `triage_artifact` feeds planning
- `plan_artifact` feeds approval and Dev Agent execution
- `dev_artifact` feeds validation and PR creation
- `validation_artifact` feeds review and merge-readiness evaluation
- `review_artifact` feeds merge-readiness evaluation and operator actions

## Contract Requirements

- Every agent output must be schema-validated JSON.
- Every artifact must be referenceable by ID and checksum.
- Every state transition must include actor, reason, and timestamp.
- Every approval event must be append-only and immutable.

## Policy Flow

- Policy checks run after planning, after dev output, and before merge readiness.
- High-risk path changes force human review.
- Budget breaches force `HUMAN_REQUIRED`.
- Validation failure forces `QUARANTINED` unless an explicit exception path is configured.

