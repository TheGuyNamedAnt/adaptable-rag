create schema if not exists rag_core;

create table if not exists rag_core.admin_review_states (
  item_id text primary key,
  status text not null check (
    status in ('open', 'acknowledged', 'in_review', 'resolved', 'dismissed')
  ),
  owner text,
  note text,
  acknowledged_at timestamptz,
  acknowledged_by text,
  updated_at timestamptz not null,
  updated_by text not null,
  state jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists rag_admin_review_states_status_idx
  on rag_core.admin_review_states (status, updated_at desc);

create index if not exists rag_admin_review_states_owner_idx
  on rag_core.admin_review_states (owner, updated_at desc);

create index if not exists rag_admin_review_states_updated_idx
  on rag_core.admin_review_states (updated_at desc, item_id asc);
