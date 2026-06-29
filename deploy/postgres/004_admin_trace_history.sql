create schema if not exists rag_core;

create table if not exists rag_core.admin_answer_runs (
  run_id text primary key,
  trace_id text not null unique,
  saved_at timestamptz not null,
  status text not null,
  tenant_id text not null,
  namespace_id text not null,
  profile_id text not null,
  question_hash text not null,
  retrieval_mode text,
  candidate_pool_size integer,
  returned_count integer,
  retrieval_rejected_count integer,
  context_status text,
  context_block_count integer,
  context_rejected_count integer,
  final_citation_count integer not null default 0 check (final_citation_count >= 0),
  rejected_chunk_count integer not null default 0 check (rejected_chunk_count >= 0),
  event_count integer not null default 0 check (event_count >= 0),
  has_answer boolean not null default false,
  answer_redacted boolean not null default false,
  has_evidence_summary boolean not null default false,
  evidence_summary_redacted boolean not null default false,
  rejection_codes text[] not null default '{}',
  saved_request jsonb not null,
  summary jsonb not null,
  response jsonb not null,
  rejected_evidence jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists rag_admin_answer_runs_saved_at_idx
  on rag_core.admin_answer_runs (saved_at desc, run_id desc);

create index if not exists rag_admin_answer_runs_scope_idx
  on rag_core.admin_answer_runs (tenant_id, namespace_id, saved_at desc);

create index if not exists rag_admin_answer_runs_status_idx
  on rag_core.admin_answer_runs (status, saved_at desc);

create index if not exists rag_admin_answer_runs_trace_idx
  on rag_core.admin_answer_runs (trace_id);

create index if not exists rag_admin_answer_runs_question_hash_idx
  on rag_core.admin_answer_runs (question_hash);

create index if not exists rag_admin_answer_runs_rejection_codes_idx
  on rag_core.admin_answer_runs using gin (rejection_codes);
