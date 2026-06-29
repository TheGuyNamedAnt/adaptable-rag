create schema if not exists rag_core;

create table if not exists rag_core.admin_connector_disabled_overrides (
  id text primary key,
  company_id text not null,
  connector_id text not null,
  source_id text not null,
  namespace_id text,
  disabled_at timestamptz not null,
  disabled_by text not null,
  reason text,
  override jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rag_admin_connector_disabled_company_idx
  on rag_core.admin_connector_disabled_overrides (company_id, source_id, disabled_at desc);

create index if not exists rag_admin_connector_disabled_connector_idx
  on rag_core.admin_connector_disabled_overrides (connector_id, source_id, disabled_at desc);

create table if not exists rag_core.admin_connector_actions (
  action_id text primary key,
  action text not null check (
    action in (
      'delta_sync',
      'full_sync',
      'retry_failed',
      'disable_connector',
      'reenable_connector'
    )
  ),
  status text not null check (status in ('succeeded', 'partial', 'failed', 'rejected')),
  requested_at timestamptz not null,
  finished_at timestamptz not null,
  requested_by text not null,
  connector_record_id text,
  company_id text,
  connector_id text,
  source_id text,
  namespace_id text,
  mode text check (mode is null or mode in ('delta', 'full')),
  delete_missing boolean,
  command text[],
  result jsonb,
  error text,
  record jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists rag_admin_connector_actions_requested_idx
  on rag_core.admin_connector_actions (requested_at desc, action_id desc);

create index if not exists rag_admin_connector_actions_record_idx
  on rag_core.admin_connector_actions (connector_record_id, requested_at desc);

create index if not exists rag_admin_connector_actions_source_idx
  on rag_core.admin_connector_actions (company_id, source_id, requested_at desc);

create index if not exists rag_admin_connector_actions_status_idx
  on rag_core.admin_connector_actions (status, requested_at desc);
