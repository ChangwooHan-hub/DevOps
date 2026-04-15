# Database Schema

This document defines the target relational schema for durable workflow state. PostgreSQL is the assumed datastore.

## Design Principles

- workflow state must survive restarts
- approval history must be append-only
- artifacts must be referenceable and checksummed
- agent runs and policy decisions must be audit-friendly

## 1. repositories

Purpose:

- map GitHub repositories and installations into internal IDs

Suggested columns:

```sql
create table repositories (
  id uuid primary key,
  github_installation_id bigint not null,
  github_repo_id bigint not null unique,
  full_name text not null unique,
  default_branch text not null,
  created_at timestamptz not null default now()
);
```

## 2. work_items

Purpose:

- represent the issue- or PR-scoped unit of orchestration

Suggested columns:

```sql
create table work_items (
  id uuid primary key,
  repository_id uuid not null references repositories(id),
  source_type text not null check (source_type in ('issue', 'pull_request')),
  issue_number int,
  pr_number int,
  title text not null,
  state text not null,
  risk_level text,
  current_branch text,
  current_head_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_work_items_repo_issue on work_items(repository_id, issue_number);
create index idx_work_items_repo_pr on work_items(repository_id, pr_number);
```

## 3. github_events

Purpose:

- store received webhooks and dedupe via delivery ID

Suggested columns:

```sql
create table github_events (
  id uuid primary key,
  repository_id uuid not null references repositories(id),
  delivery_id text not null unique,
  event_name text not null,
  action text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received'
);
```

## 4. agent_runs

Purpose:

- capture each agent execution, budgets, outputs, and failures

Suggested columns:

```sql
create table agent_runs (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  agent_type text not null,
  status text not null,
  trigger_event_id uuid references github_events(id),
  input_artifact_id uuid,
  output_artifact_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  attempt int not null default 1,
  budget_seconds int,
  budget_llm_calls int,
  budget_max_files int,
  budget_max_loc int,
  actual_llm_calls int not null default 0,
  actual_changed_files int not null default 0,
  actual_loc_delta int not null default 0,
  error_code text,
  error_message text
);
```

## 5. artifacts

Purpose:

- register output documents, validation reports, patches, and summaries

Suggested columns:

```sql
create table artifacts (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  agent_run_id uuid references agent_runs(id),
  artifact_type text not null,
  storage_uri text not null,
  sha256 text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_artifacts_work_item on artifacts(work_item_id, artifact_type);
```

## 6. policy_results

Purpose:

- record rule evaluations and gate decisions

Suggested columns:

```sql
create table policy_results (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  agent_run_id uuid references agent_runs(id),
  policy_name text not null,
  verdict text not null check (verdict in ('allow', 'block', 'needs_human')),
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
```

## 7. approval_events

Purpose:

- immutable approval ledger for plan approval, exception handling, and merge gating

Suggested columns:

```sql
create table approval_events (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  subject_type text not null,
  subject_id text not null,
  action text not null check (action in ('approved', 'rejected', 'revoked', 'superseded')),
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text not null,
  reason text,
  prev_event_id uuid references approval_events(id),
  prev_hash text,
  event_hash text not null,
  created_at timestamptz not null default now()
);
```

Append-only enforcement:

```sql
create function forbid_approval_mutation()
returns trigger as $$
begin
  raise exception 'approval_events is append-only';
end;
$$ language plpgsql;

create trigger trg_no_update_approval_events
before update or delete on approval_events
for each row execute function forbid_approval_mutation();
```

## 8. state_transitions

Purpose:

- maintain a complete workflow transition audit trail

Suggested columns:

```sql
create table state_transitions (
  id uuid primary key,
  work_item_id uuid not null references work_items(id),
  from_state text,
  to_state text not null,
  actor_type text not null,
  actor_id text not null,
  reason text,
  created_at timestamptz not null default now()
);
```

## 9. Optional Future Tables

- `queue_jobs`
  - only if queue introspection must be queryable outside BullMQ or Temporal
- `artifact_blobs`
  - only if object storage is not used
- `operator_overrides`
  - explicit manual bypasses of policy decisions
- `repository_policies`
  - repo-specific high-risk paths, budget limits, and approval rules

