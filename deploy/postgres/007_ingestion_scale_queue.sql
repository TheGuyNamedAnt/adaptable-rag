create table if not exists rag_core.ingestion_queue (
  queue_id text primary key,
  job_id text not null,
  run_id text,
  tenant_id text not null,
  namespace_id text not null,
  source_ids text[] not null default '{}',
  priority integer not null default 0,
  status text not null check (status in ('queued', 'leased', 'completed', 'dead_letter', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  available_at timestamptz not null,
  enqueued_at timestamptz not null,
  updated_at timestamptz not null,
  leased_by text,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  error_name text,
  error_message text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists rag_ingestion_queue_claim_idx
  on rag_core.ingestion_queue (status, available_at, priority desc, enqueued_at, queue_id);

create index if not exists rag_ingestion_queue_scope_idx
  on rag_core.ingestion_queue (tenant_id, namespace_id, updated_at desc);

create index if not exists rag_ingestion_queue_source_ids_idx
  on rag_core.ingestion_queue using gin (source_ids);

create index if not exists rag_ingestion_queue_lease_idx
  on rag_core.ingestion_queue (leased_by, lease_expires_at)
  where status = 'leased';

create table if not exists rag_core.ingestion_leases (
  resource_id text primary key,
  holder_id text not null,
  token text not null,
  acquired_at timestamptz not null,
  updated_at timestamptz not null,
  lease_expires_at timestamptz not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists rag_ingestion_leases_expiry_idx
  on rag_core.ingestion_leases (lease_expires_at);

create index if not exists rag_ingestion_leases_holder_idx
  on rag_core.ingestion_leases (holder_id, lease_expires_at);
