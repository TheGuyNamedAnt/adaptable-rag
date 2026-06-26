-- Apply after 001_core_storage.sql when RAG_VECTOR_DIMENSIONS=1536.
-- For other embedding dimensions, copy this migration and replace 1536 with
-- the configured RAG_VECTOR_DIMENSIONS value.

create index if not exists rag_chunk_vectors_hnsw_cosine_1536_idx
  on rag_core.chunk_vectors
  using hnsw ((vector::vector(1536)) vector_cosine_ops);
