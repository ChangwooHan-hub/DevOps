# Workflow and State Machine

## Top-Level Flow

`Issue Opened -> Triage -> Planning -> Human Approval -> Dev Execution -> Draft PR -> Validation -> Review -> Merge Readiness`

## Workflow States

- `OPEN`
- `TRIAGED`
- `PLANNED`
- `APPROVED_FOR_DEV`
- `IN_PROGRESS`
- `DRAFT_PR`
- `VALIDATING`
- `REVIEWING`
- `CHANGES_REQUESTED`
- `REVIEW_PASSED`
- `MERGE_READY`
- `MERGED`
- `HUMAN_REQUIRED`
- `QUARANTINED`
- `CANCELLED`

## Transition Rules

- `OPEN -> TRIAGED` after triage artifact creation
- `TRIAGED -> PLANNED` after planning artifact creation
- `PLANNED -> APPROVED_FOR_DEV` only after human approval
- `APPROVED_FOR_DEV -> IN_PROGRESS` when Dev Agent starts in isolated runner
- `IN_PROGRESS -> DRAFT_PR` after branch push and draft PR creation
- `DRAFT_PR -> VALIDATING` when validation begins
- `VALIDATING -> REVIEWING` after required validation jobs finish
- `REVIEWING -> CHANGES_REQUESTED` when unresolved high-severity issues remain
- `REVIEWING -> REVIEW_PASSED` when review gates pass
- `REVIEW_PASSED -> MERGE_READY` only after policy and approval gates pass

## Exceptional States

- `HUMAN_REQUIRED` on budget breach, unclear execution, or manual escalation
- `QUARANTINED` on major validation failure or blocked policy result

