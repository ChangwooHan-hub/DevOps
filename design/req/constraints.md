# Implementation Constraints

This document captures the current non-negotiable implementation constraints for the GitHub-driven AI agent pipeline. These constraints should be treated as design inputs, not optional follow-up hardening.

## 1. Webhook Security

- Every GitHub webhook request must be verified with `X-Hub-Signature-256` against the raw request body.
- Requests that fail signature verification must be rejected before they reach the orchestrator.
- `X-GitHub-Delivery` must be used for idempotency and duplicate delivery suppression.
- Only an allowlisted set of GitHub event types may be accepted.
- Only known GitHub App installations and authorized repositories may trigger pipeline execution.

## 2. Orchestration Boundaries

- Only the central orchestrator may change workflow state.
- Agents must not call each other directly.
- Agents must consume input artifacts and produce output artifacts; they must not perform independent state transitions.
- GitHub side effects such as labels, comments, PR actions, and status updates must be mediated by the orchestrator.

## 3. Isolated Git Mutation

- All code mutation must happen in an isolated runner environment.
- Agents must never push directly to `main` or any protected branch.
- Each automated implementation run must use an agent-owned branch or isolated worktree.
- Shared developer branches are out of scope for automated mutation.

## 4. Dev Agent Execution Budgets

- The Dev Agent must run under explicit hard limits enforced in code, not just in prompts.
- Required limits:
  - maximum wall-clock runtime
  - maximum number of changed files
  - maximum LOC delta
  - maximum number of LLM calls
  - maximum repeated edits to the same file
- Any budget breach must immediately stop execution and move the work item to `HUMAN_REQUIRED`.

## 5. Failure Handling and Rollback

- Validation failure does not imply automatic revert.
- The default failure policy is quarantine, not rollback.
- On validation failure, the system must:
  - block merge
  - preserve the branch unless explicit cleanup policy allows deletion
  - surface a human escalation path
- Automatic revert is only allowed for explicitly safe, isolated cases such as disposable branches with no shared ownership.

## 6. Approval Immutability

- Approval history is an append-only audit log.
- Approval cancellation or replacement must be represented as a new event, never as an update in place.
- `approval_events` must reject `UPDATE` and `DELETE` operations at the database level.
- Approval events should be hash-linked when feasible to strengthen tamper detection.

## 7. Deterministic Validation First

- LLM output must not replace deterministic analysis tools.
- Static analysis, linting, typing, coverage, and security checks must be performed by dedicated tools.
- LLMs may summarize, prioritize, or explain findings, but they must not be treated as the source of truth for these checks.

## 8. Merge Readiness Requirements

- AI review output alone is insufficient to declare merge readiness.
- Merge readiness requires, at minimum:
  - required checks passing
  - required human approvals present
  - CODEOWNERS requirements satisfied
  - no unresolved policy blocks
  - no unresolved critical or high-severity review findings
  - no branch conflicts
- The initial system must stop at `merge-ready` and leave final merge to a human.

## 9. Human Approval Points

- Human approval must be explicit at these stages:
  - plan approval
  - high-risk change approval
  - approval to continue after budget breach or major validation failure
  - final merge approval
- These approvals must be stored in GitHub-visible actions, the internal approval ledger, or both.
- Slack alone must not serve as the system of record for approvals.

## 10. Slack Is a Secondary Interface

- Slack may be used for notifications and convenience commands.
- Slack commands must be reflected into GitHub or the internal ledger before they can justify execution.
- The authoritative audit trail must remain in GitHub and durable backend storage.

## 11. Durable State Requirements

- Redis may be used for queues and caching, but not as the sole workflow state store.
- Work items, policy results, approval events, artifact metadata, and state transitions must be stored durably.
- PostgreSQL is the assumed source of truth for workflow state.

## 12. Structured Agent Outputs

- Each agent must return schema-validated structured output.
- Natural language comments may exist, but downstream execution must depend on typed fields and artifact references.
- Triage, planning, dev, validation, review, and merge-readiness outputs must each have explicit JSON contracts.
- Invalid agent output must be rejected or retried before downstream use.

## 13. Code Search Priority

- Deterministic code search takes priority over embedding search.
- Primary mechanisms:
  - `ripgrep`
  - `tree-sitter`
  - symbol and import graph analysis
- Vector search may be used as a secondary signal, not as the sole basis for impact analysis.

## 14. MVP Scope Control

- The initial implementation must prioritize:
  - webhook verification
  - triage
  - planning
  - approval ledger
  - isolated dev execution
  - validation
  - review
- The following are explicitly lower priority and should not block MVP:
  - story point estimation
  - assignee recommendation
  - automatic TODO/FIXME ticket generation
  - auto-merge

## 15. Current Implementation State

- The repository currently contains a NestJS monorepo scaffold, not a production-ready platform.
- The following services exist as skeletons:
  - `webhook-api`
  - `orchestrator`
  - `runner-service`
  - `llm-gateway`
- PostgreSQL persistence, BullMQ or Temporal integration, GitHub App authentication, and Dockerized runner execution are not yet wired.

## 16. Local Environment Constraints

- In the current local Windows environment, `npm` must be invoked via `cmd /c npm.cmd ...` due to PowerShell execution policy restrictions.
- TypeScript and Nest build validation cannot run until dependencies are installed.
- Current validation has only confirmed file structure and JSON config correctness, not a full runtime boot.

## 17. Observability and Auditability

- Every agent run must be traceable with identifiers such as:
  - `work_item_id`
  - `agent_run_id`
  - `agent_type`
  - `branch`
  - `commit_sha`
  - `artifact_id`
- Policy decisions, failures, approvals, and LLM usage metadata must be queryable after the fact.
- Silent state transitions are not acceptable.

## 18. High-Risk Path Policy

- Changes under high-risk paths must require human review by default.
- Initial high-risk categories include:
  - `auth/`
  - `infra/`
  - `migrations/`
  - `secrets/`
  - `billing/`
- Repository-specific exceptions must be explicit configuration, not ad hoc operator judgment.

