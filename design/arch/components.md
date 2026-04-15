# Component Responsibilities

## webhook-api

- receive GitHub webhooks
- verify `X-Hub-Signature-256`
- suppress duplicate deliveries
- translate webhook payloads into domain events

## orchestrator

- create and update work items
- enforce state transitions
- evaluate policy rules
- enqueue downstream agent runs
- perform GitHub side effects through controlled adapters

## runner-service

- clone repositories into isolated workspaces
- create agent-owned branches
- apply generated patches
- run bounded implementation workflows
- collect validation results

## llm-gateway

- centralize model access
- enforce structured output contracts
- log latency, tokens, and cost
- isolate prompt templates from workflow services

## ops-ui

- show current work item states
- expose approval actions
- display policy blocks and quarantine reasons
- provide traceability across branches, artifacts, and approvals

## Shared Domain Package

- enums for states and agent types
- typed event contracts
- shared interfaces for work items and artifacts

