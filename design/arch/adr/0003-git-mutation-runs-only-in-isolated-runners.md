# ADR-0003: Git Mutation Runs Only in Isolated Runners

## Status

Accepted

## Context

Automated implementation can loop, over-edit, or leave a repository in a partial state. Shared worktrees and protected branches are unsafe execution targets for agent-driven mutation.

## Decision

All git mutation runs must happen in isolated runners or isolated worktrees.

- Dev Agent executions use agent-owned branches only
- protected branches are never direct targets
- branch creation, patching, commit, and push run behind the runner-service boundary

## Consequences

- repository safety improves significantly
- failed runs are easier to quarantine
- runner infrastructure becomes mandatory
- local debugging must account for runner parity

