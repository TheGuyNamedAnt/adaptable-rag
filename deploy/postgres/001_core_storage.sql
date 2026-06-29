create schema if not exists rag_core;

create extension if not exists vector;

create table if not exists rag_core.documents (
  id text primary key,
  tenant_id text not null,
  namespace_id text not null,
  source_id text not null,
  source_kind text not null,
  trust_tier text not null,
  access_tags text[] not null default '{}',
  document jsonb not null,
  indexed_at timestamptz not null,
  updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists rag_core.chunks (
  id text primary key,
  document_id text not null references rag_core.documents(id) on delete cascade,
  tenant_id text not null,
  namespace_id text not null,
  source_id text not null,
  source_kind text not null,
  trust_tier text not null,
  safety_flags text[] not null default '{}',
  access_tags text[] not null default '{}',
  chunk jsonb not null,
  fts tsvector not null,
  indexed_at timestamptz not null,
  updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists rag_core.chunk_vectors (
  id text primary key,
  chunk_id text not null references rag_core.chunks(id) on delete cascade,
  document_id text not null references rag_core.documents(id) on delete cascade,
  tenant_id text not null,
  namespace_id text not null,
  text_hash text not null,
  embedding_model text not null,
  dimensions integer not null check (dimensions > 0),
  vector vector,
  metadata jsonb not null default '{}',
  embedded_at timestamptz not null,
  indexed_at timestamptz not null,
  updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists rag_core.ingestion_jobs (
  job_id text primary key,
  run_id text not null,
  tenant_id text not null,
  namespace_id text not null,
  source_ids text[] not null default '{}',
  status text not null check (
    status in (
      'queued',
      'loading_source',
      'normalizing',
      'parsing',
      'chunking',
      'embedding',
      'indexing',
      'graph_extracting',
      'completed',
      'completed_with_warnings',
      'failed',
      'cancelled'
    )
  ),
  stage text not null check (
    stage in (
      'queued',
      'loading_source',
      'normalizing',
      'parsing',
      'chunking',
      'embedding',
      'indexing',
      'visual_embedding',
      'graph_extracting',
      'completed',
      'completed_with_warnings',
      'failed',
      'cancelled'
    )
  ),
  attempt integer not null default 1 check (attempt > 0),
  requested_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null,
  checkpoint jsonb not null default '{}',
  counts jsonb,
  error_name text,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists rag_core.ingestion_checkpoints (
  checkpoint_id text primary key default ('checkpoint_' || md5(random()::text || clock_timestamp()::text)),
  job_id text not null references rag_core.ingestion_jobs(job_id) on delete cascade,
  sequence integer not null check (sequence > 0),
  stage text not null check (
    stage in (
      'queued',
      'loading_source',
      'normalizing',
      'parsing',
      'chunking',
      'embedding',
      'indexing',
      'visual_embedding',
      'graph_extracting',
      'completed',
      'completed_with_warnings',
      'failed',
      'cancelled'
    )
  ),
  checkpoint jsonb not null,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);

create table if not exists rag_core.ingestion_source_progress (
  job_id text not null references rag_core.ingestion_jobs(job_id) on delete cascade,
  source_id text not null,
  status text not null check (status in ('queued', 'loading', 'completed', 'failed', 'skipped')),
  loaded_document_count integer not null default 0 check (loaded_document_count >= 0),
  accepted_document_count integer not null default 0 check (accepted_document_count >= 0),
  failed_document_count integer not null default 0 check (failed_document_count >= 0),
  skipped_document_count integer not null default 0 check (skipped_document_count >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null,
  error_message text,
  created_at timestamptz not null default now(),
  primary key (job_id, source_id)
);

create table if not exists rag_core.ingestion_document_progress (
  job_id text not null references rag_core.ingestion_jobs(job_id) on delete cascade,
  source_id text not null,
  document_id text not null,
  status text not null check (
    status in (
      'queued',
      'normalizing',
      'parsing',
      'chunking',
      'embedding',
      'indexing',
      'graph_extracting',
      'accepted',
      'failed',
      'skipped'
    )
  ),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  retryable boolean not null default false,
  attempt integer not null default 1 check (attempt > 0),
  failure_stage text check (
    failure_stage is null or
    failure_stage in (
      'queued',
      'loading_source',
      'normalizing',
      'parsing',
      'chunking',
      'embedding',
      'indexing',
      'graph_extracting',
      'completed',
      'completed_with_warnings',
      'failed',
      'cancelled',
      'visual_embedding'
    )
  ),
  failure_phase text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null,
  error_message text,
  created_at timestamptz not null default now(),
  primary key (job_id, source_id, document_id)
);

create table if not exists rag_core.source_sync_ledgers (
  connector_id text not null,
  source_id text not null,
  namespace_id text not null,
  ledger_id text not null,
  status text not null check (status in ('succeeded', 'partial', 'failed')),
  cursor text,
  generated_at timestamptz not null,
  metrics jsonb not null,
  ledger jsonb not null,
  updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (connector_id, source_id, namespace_id)
);

create table if not exists rag_core.source_sync_ledger_entries (
  connector_id text not null,
  source_id text not null,
  namespace_id text not null,
  source_item_id text not null,
  record_id text,
  status text not null check (status in ('active', 'deleted', 'failed')),
  last_action text not null check (last_action in ('created', 'updated', 'unchanged', 'deleted', 'failed')),
  version text,
  content_hash text,
  access_scope_hash text,
  source_acl_hash text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_changed_at timestamptz,
  deleted_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error_code text,
  retryable boolean,
  entry jsonb not null,
  created_at timestamptz not null default now(),
  primary key (connector_id, source_id, namespace_id, source_item_id),
  foreign key (connector_id, source_id, namespace_id)
    references rag_core.source_sync_ledgers (connector_id, source_id, namespace_id)
    on delete cascade
);

create index if not exists rag_documents_scope_idx
  on rag_core.documents (tenant_id, namespace_id);

create index if not exists rag_documents_source_idx
  on rag_core.documents (tenant_id, namespace_id, source_id);

create index if not exists rag_documents_access_tags_idx
  on rag_core.documents using gin (access_tags);

create index if not exists rag_chunks_scope_idx
  on rag_core.chunks (tenant_id, namespace_id);

create index if not exists rag_chunks_document_idx
  on rag_core.chunks (document_id);

create index if not exists rag_chunks_source_idx
  on rag_core.chunks (tenant_id, namespace_id, source_id);

create index if not exists rag_chunks_trust_idx
  on rag_core.chunks (tenant_id, namespace_id, trust_tier);

create index if not exists rag_chunks_safety_flags_idx
  on rag_core.chunks using gin (safety_flags);

create index if not exists rag_chunks_access_tags_idx
  on rag_core.chunks using gin (access_tags);

create index if not exists rag_chunks_fts_idx
  on rag_core.chunks using gin (fts);

create index if not exists rag_chunk_vectors_scope_idx
  on rag_core.chunk_vectors (tenant_id, namespace_id);

create index if not exists rag_chunk_vectors_identity_idx
  on rag_core.chunk_vectors (
    tenant_id,
    namespace_id,
    dimensions,
    embedding_model,
    (metadata->>'embeddingProvider'),
    (metadata->>'embeddingConfigHash')
  );

create index if not exists rag_chunk_vectors_chunk_idx
  on rag_core.chunk_vectors (chunk_id);

create index if not exists rag_chunk_vectors_document_idx
  on rag_core.chunk_vectors (document_id);

create index if not exists rag_ingestion_jobs_scope_idx
  on rag_core.ingestion_jobs (tenant_id, namespace_id, updated_at desc);

create index if not exists rag_ingestion_jobs_status_idx
  on rag_core.ingestion_jobs (status, updated_at desc);

create index if not exists rag_ingestion_checkpoints_job_idx
  on rag_core.ingestion_checkpoints (job_id, sequence desc);

create index if not exists rag_ingestion_source_progress_status_idx
  on rag_core.ingestion_source_progress (status, updated_at desc);

create index if not exists rag_ingestion_document_progress_status_idx
  on rag_core.ingestion_document_progress (status, updated_at desc);

create index if not exists rag_source_sync_ledgers_status_idx
  on rag_core.source_sync_ledgers (status, updated_at desc);

create index if not exists rag_source_sync_entries_status_idx
  on rag_core.source_sync_ledger_entries (connector_id, source_id, namespace_id, status);

create index if not exists rag_source_sync_entries_record_idx
  on rag_core.source_sync_ledger_entries (namespace_id, record_id)
  where record_id is not null;

create index if not exists rag_source_sync_entries_deleted_idx
  on rag_core.source_sync_ledger_entries (namespace_id, deleted_at desc)
  where status = 'deleted';
