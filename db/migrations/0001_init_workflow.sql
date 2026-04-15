begin;

create extension if not exists pgcrypto;

create table repositories (
  id uuid primary key default gen_random_uuid(),
  github_installation_id bigint not null,
  github_repo_id bigint not null unique,
  full_name text not null unique,
  default_branch text not null,
  created_at timestamptz not null default now()
);

create table work_items (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  source_type text not null check (source_type in ('issue', 'pull_request')),
  issue_number int,
  pr_number int,
  title text not null,
  state text not null check (
    state in (
      'OPEN',
      'TRIAGED',
      'PLANNED',
      'APPROVED_FOR_DEV',
      'IN_PROGRESS',
      'DRAFT_PR',
      'VALIDATING',
      'REVIEWING',
      'CHANGES_REQUESTED',
      'REVIEW_PASSED',
      'MERGE_READY',
      'MERGED',
      'HUMAN_REQUIRED',
      'QUARANTINED',
      'CANCELLED'
    )
  ),
  risk_level text check (risk_level in ('low', 'medium', 'high')),
  current_branch text,
  current_head_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_work_items_issue_or_pr check (
    (source_type = 'issue' and issue_number is not null and pr_number is null) or
    (source_type = 'pull_request' and pr_number is not null and issue_number is null)
  )
);

create index idx_work_items_repo_issue on work_items(repository_id, issue_number);
create index idx_work_items_repo_pr on work_items(repository_id, pr_number);
create index idx_work_items_state on work_items(state);

create table github_events (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  delivery_id text not null unique,
  event_name text not null,
  action text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (
    processing_status in ('received', 'processing', 'processed', 'failed', 'ignored')
  )
);

create index idx_github_events_repo on github_events(repository_id, received_at desc);
create index idx_github_events_name on github_events(event_name, action);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id),
  agent_type text not null check (
    agent_type in ('triage', 'planning', 'dev', 'validation', 'review', 'merge_readiness')
  ),
  status text not null check (
    status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'blocked')
  ),
  trigger_event_id uuid references github_events(id),
  input_artifact_id uuid,
  output_artifact_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  attempt int not null default 1 check (attempt > 0),
  budget_seconds int check (budget_seconds is null or budget_seconds >= 0),
  budget_llm_calls int check (budget_llm_calls is null or budget_llm_calls >= 0),
  budget_max_files int check (budget_max_files is null or budget_max_files >= 0),
  budget_max_loc int check (budget_max_loc is null or budget_max_loc >= 0),
  actual_llm_calls int not null default 0 check (actual_llm_calls >= 0),
  actual_changed_files int not null default 0 check (actual_changed_files >= 0),
  actual_loc_delta int not null default 0,
  error_code text,
  error_message text
);

create index idx_agent_runs_work_item on agent_runs(work_item_id, started_at desc);
create index idx_agent_runs_status on agent_runs(status, agent_type);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id),
  agent_run_id uuid references agent_runs(id),
  artifact_type text not null,
  storage_uri text not null,
  sha256 text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_artifacts_work_item on artifacts(work_item_id, artifact_type);
create index idx_artifacts_agent_run on artifacts(agent_run_id);

alter table agent_runs
  add constraint fk_agent_runs_input_artifact
  foreign key (input_artifact_id) references artifacts(id) deferrable initially deferred;

alter table agent_runs
  add constraint fk_agent_runs_output_artifact
  foreign key (output_artifact_id) references artifacts(id) deferrable initially deferred;

create table policy_results (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id),
  agent_run_id uuid references agent_runs(id),
  policy_name text not null,
  verdict text not null check (verdict in ('allow', 'block', 'needs_human')),
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_policy_results_work_item on policy_results(work_item_id, created_at desc);
create index idx_policy_results_verdict on policy_results(verdict);

create table approval_events (
  id uuid primary key default gen_random_uuid(),
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

create index idx_approval_events_work_item on approval_events(work_item_id, created_at desc);
create index idx_approval_events_subject on approval_events(subject_type, subject_id);

create table state_transitions (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references work_items(id),
  from_state text,
  to_state text not null,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text not null,
  reason text,
  created_at timestamptz not null default now()
);

create index idx_state_transitions_work_item on state_transitions(work_item_id, created_at desc);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_work_items_set_updated_at
before update on work_items
for each row execute function set_updated_at();

create or replace function forbid_approval_mutation()
returns trigger as $$
begin
  raise exception 'approval_events is append-only';
end;
$$ language plpgsql;

create trigger trg_no_update_approval_events
before update or delete on approval_events
for each row execute function forbid_approval_mutation();

commit;
