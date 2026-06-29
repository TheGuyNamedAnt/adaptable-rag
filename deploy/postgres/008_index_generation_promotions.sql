create table if not exists rag_core.index_generation_manifests (
  generation_id text primary key,
  tenant_id text not null,
  namespace_id text not null,
  profile_id text not null,
  status text not null check (status in ('candidate', 'active', 'deprecated', 'failed')),
  manifest jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  promoted_at timestamptz,
  deprecated_at timestamptz
);

create unique index if not exists rag_index_generation_active_scope_idx
  on rag_core.index_generation_manifests (tenant_id, namespace_id)
  where status = 'active';

create index if not exists rag_index_generation_scope_status_idx
  on rag_core.index_generation_manifests (tenant_id, namespace_id, status, updated_at desc);

create index if not exists rag_index_generation_profile_idx
  on rag_core.index_generation_manifests (profile_id, updated_at desc);

create table if not exists rag_core.index_generation_promotions (
  promotion_id text primary key,
  tenant_id text not null,
  namespace_id text not null,
  candidate_generation_id text not null references rag_core.index_generation_manifests (generation_id),
  previous_active_generation_id text references rag_core.index_generation_manifests (generation_id),
  required_eval_ids text[] not null default '{}',
  actions text[] not null default '{}',
  status text not null check (status in ('planned', 'ready', 'promoted', 'failed')),
  planned_at timestamptz not null,
  updated_at timestamptz not null,
  promoted_at timestamptz,
  failure_reason text,
  eval_results jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index if not exists rag_index_generation_promotions_scope_status_idx
  on rag_core.index_generation_promotions (tenant_id, namespace_id, status, updated_at desc);

create index if not exists rag_index_generation_promotions_candidate_idx
  on rag_core.index_generation_promotions (candidate_generation_id, updated_at desc);
