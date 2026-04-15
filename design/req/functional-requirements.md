# Functional Requirements

## R1. Issue Triage

- The system must react to `issues.opened`.
- The system must classify the issue into a work type such as bug, feature, or refactor.
- The system must identify candidate impact areas in the repository.
- The system must publish a structured triage comment and apply initial labels.
- The system must create a work item record for downstream orchestration.

## R2. Planning Before Coding

- The system must generate a planning artifact before any Dev Agent execution.
- The planning artifact must include:
  - branch name proposal
  - candidate changed files
  - test plan
  - risk level
  - execution budget
- The system must require explicit human approval before the work item can move to implementation.

## R3. Isolated Dev Execution

- The system must create or use an agent-owned branch for automated implementation.
- The system must run implementation only inside an isolated runner or worktree.
- The system must generate commits with a predictable convention.
- The system must be able to open a draft PR after successful branch push.

## R4. Validation

- The system must run deterministic validation on agent-produced changes.
- Validation must include lint, typecheck, tests, and security/static analysis as configured.
- Validation results must be captured as structured artifacts and published back to GitHub.

## R5. Review

- The system must run AI-assisted review after draft PR is marked ready for review or synchronized.
- Review output must distinguish severity levels.
- Review findings must be mapped to file and line where possible.
- Review output must not override deterministic validation results.

## R6. Merge Readiness

- The system must evaluate merge readiness only after validation and review pass their thresholds.
- The merge-readiness decision must consider:
  - required checks
  - required approvals
  - CODEOWNERS
  - policy blocks
  - unresolved critical findings
- The initial implementation must stop at `MERGE_READY` and not auto-merge.

## R7. Auditability

- The system must record every state transition.
- The system must record every agent run.
- The system must preserve immutable approval history.
- The system must retain enough metadata to trace any automated commit or review decision.

## R8. Human-in-the-Loop

- The system must require human approval for:
  - plan approval
  - high-risk path changes
  - continuation after budget breach
  - continuation after major validation failure
  - final merge

