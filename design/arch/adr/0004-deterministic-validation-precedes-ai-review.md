# ADR-0004: Deterministic Validation Precedes AI Review

## Status

Accepted

## Context

LLMs are useful for prioritizing and explaining issues, but they are not a reliable substitute for deterministic linting, testing, typechecking, or security tooling.

## Decision

Deterministic validation must run before AI-assisted review is used as a gate signal.

- validation tools produce the primary pass/fail signal
- AI review may summarize, cluster, and annotate findings
- AI review may add context-aware findings, but it cannot override failed deterministic checks

## Consequences

- merge decisions remain grounded in reproducible tooling
- AI review becomes safer and easier to trust
- validation pipeline quality directly affects review usefulness

