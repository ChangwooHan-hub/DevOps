# ADR-0002: Approval History Is Append-Only

## Status

Accepted

## Context

The pipeline requires human approval at multiple points. Approval records are part of the audit trail and must remain trustworthy, especially when automation can create branches, commits, and PR activity.

## Decision

Approval history is stored as append-only events.

- approval updates are represented as new events, not in-place mutation
- `UPDATE` and `DELETE` operations are disallowed for approval records
- optional hash chaining is recommended for stronger tamper detection

## Consequences

- approval provenance remains intact
- historical queries become simpler and safer
- current approval state must be derived from the event stream
- implementation is slightly more complex than a mutable approvals table

