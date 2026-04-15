# Requirements Overview

## Goal

Build a GitHub-driven AI agent pipeline that can participate in the delivery workflow from issue creation through PR review, while preserving human approval, auditability, and branch safety.

## Primary Outcomes

- Automatically triage new issues and convert them into structured engineering work.
- Produce implementation plans before any code mutation is allowed.
- Run code-writing agents only inside isolated execution environments.
- Validate and review generated changes with deterministic tooling plus AI-assisted review summaries.
- Stop at merge readiness unless explicit human merge authority is granted later.

## In Scope

- GitHub issue ingestion
- triage and planning artifacts
- branch-scoped automated implementation
- draft PR generation
- validation and review automation
- merge-readiness assessment
- approval ledger and audit trail

## Out of Scope for MVP

- direct auto-merge
- automatic assignee selection
- story point estimation as a gating signal
- TODO/FIXME-driven auto-ticket generation
- direct mutation of shared developer branches

## Source of Truth

- Workflow state: PostgreSQL
- approval history: append-only approval ledger
- git state: GitHub repository and agent-owned branches
- operator actions: GitHub plus backend audit logs

