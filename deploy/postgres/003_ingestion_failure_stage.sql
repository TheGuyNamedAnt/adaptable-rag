alter table rag_core.ingestion_document_progress
  add column if not exists failure_stage text;

alter table rag_core.ingestion_document_progress
  add column if not exists failure_phase text;

alter table rag_core.ingestion_document_progress
  drop constraint if exists ingestion_document_progress_failure_stage_check;

alter table rag_core.ingestion_document_progress
  add constraint ingestion_document_progress_failure_stage_check
  check (
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
  );
