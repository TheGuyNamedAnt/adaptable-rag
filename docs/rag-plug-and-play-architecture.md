# Plug-and-Play RAG Architecture

This project treats RAG components as replaceable only when they honor explicit contracts. The goal is to let teams swap embedding models, vector stores, chunking policies, and providers without silently mixing incompatible vectors or returning stale evidence.

## Embedding Adapter Contract

Every embedding adapter must expose a stable identity:

- `id`
- `provider`
- `modelName`
- `dimensions`

The runtime builds `embeddingConfigHash` from that identity. Chunk indexing stores it on each vector, and retrieval sends the query embedding hash into vector search. A vector store must reject vectors whose embedding identity does not match the query.

Adapters should use the reusable contract test in `src/test-support/embedding-adapter-contract.ts`.

## Vector Store Contract

Every vector store must:

- enforce tenant and namespace filters
- enforce `embeddingModel`, `embeddingProvider`, and `embeddingConfigHash`
- reject stale vectors when chunk metadata no longer matches
- delete all vectors for a document
- report capabilities honestly

Vector stores should use the reusable contract test in `src/test-support/vector-store-contract.ts`.

## Chunking And Index Generations

Chunks carry:

- `chunkingPolicyId`
- `chunkingPolicyVersion`
- `chunkerVersion`

Vectors also store `embeddingIndexConfigHash`, which includes embedding identity plus available chunking and preprocessing metadata. Retrieval gates on `embeddingConfigHash`; migration and audit workflows use `embeddingIndexConfigHash`.

## Update And Rechunk Cleanup

When production ingestion runs with `overwriteMode: "replace"`, it deletes old text and visual vectors for accepted documents before indexing the new chunk set. This prevents old chunk IDs from surviving a rechunk.

## Migration Lifecycle

Safe provider or chunking changes should follow this lifecycle:

1. Build a candidate index with the new embedding/chunking config.
2. Run evals against the candidate.
3. Compare candidate vs baseline with the embedding migration report.
4. Promote only if pass rate, recall, and citation recall stay within thresholds.
5. Delete or archive old vector generations according to the deployment policy.

For snapshot-backed stores, `scripts/run-vector-generation-cleanup.mjs` can produce a dry-run generation inventory and cleanup plan. Use `--apply --cleaned-snapshot <path>` only after the migration report passes.

Postgres-backed stores expose SQL aggregation through `PostgresVectorStore.vectorGenerationInventory()` so large deployments do not need to load every vector to count generations.

## 10M-Chunk Readiness

At large scale, a deployment needs:

- tenant/namespace/config-hash partitioning or highly selective indexes
- ANN indexes for durable vector stores
- hybrid retrieval and reranking, not raw vector topK alone
- idempotent backfills and resumable migrations
- vector generation counts by tenant, namespace, model, and config hash
- alerts for zero-result retrieval, low-score retrieval, stale vectors, and identity mismatches
