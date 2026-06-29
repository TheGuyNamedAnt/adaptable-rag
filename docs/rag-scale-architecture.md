# RAG Scale Architecture

This repo keeps scale portable by making backends declare capabilities instead of
letting runtime code assume Postgres, SQLite, local JSON, or a hosted vector DB.

The reusable core stays centered on `RagProfile`, `namespaceId`, `ChunkStore`,
`VectorStore`, and `FtsIndexStore`. Scale-specific behavior is exposed through
optional `StorageScaleCapabilities` metadata on existing store capabilities.

## Capability Contract

Stores can now report:

- topology: `embedded`, `database`, or `hosted`
- stats support
- vector generation inventory support
- readiness check support
- metadata filtering support
- batch upsert support
- delete-by-document support
- delete-by-filter support
- cursor pagination support
- partitioning support
- ANN index support
- resumable backfill support
- portable partition keys

This makes adapters honest. For example, Postgres vector storage supports async
generation inventory and ANN readiness checks, but table partitioning and
delete-by-filter are still explicitly unsupported. Hosted vector storage can
advertise vendor-native ANN and metadata filtering without pretending it has a
portable generation inventory contract.

## Production Health

`ProductionRagApp.health()` remains synchronous for local and embedded callers.
If a backend can only answer through async storage operations, sync health uses
safe fallback values and avoids expensive snapshot loading.

`ProductionRagApp.healthAsync()` is the production path. HTTP and CLI
operations use it when available, so durable stores can report accurate counts
and generation health.

For vector generation health, async production health uses this order:

1. Use `vectorGenerationInventory()` when the store exposes it.
2. Fall back to snapshot-derived inventory for bounded local stores.
3. Omit generation counts when the backend cannot report them portably.

Postgres vector storage implements `vectorGenerationInventory()` with SQL
aggregation so large deployments do not need to load every vector just to count
active and stale embedding generations.

## Current Backend Posture

| Backend           | Topology | Generation inventory  | ANN            | Partitioning  |
| ----------------- | -------- | --------------------- | -------------- | ------------- |
| memory vector     | embedded | sync snapshot         | no             | no            |
| JSON vector       | embedded | sync snapshot         | no             | no            |
| Postgres vector   | database | async SQL aggregation | yes            | not wired     |
| hosted vector     | hosted   | not portable yet      | vendor-native  | vendor-native |
| memory/JSON index | embedded | not applicable        | not applicable | no            |
| SQLite index      | embedded | not applicable        | not applicable | no            |
| Postgres index    | database | not applicable        | not applicable | not wired     |

## Next Scale Work

The distributed ingestion layer now has portable contracts in
`src/runtime/ingestion-scale.ts`:

- `IngestionJobQueue`
- `IngestionLeaseStore`
- `planIngestionBackfillJobs()`
- `planReindex()`
- `IndexGenerationManifest`
- `planGenerationPromotion()`
- `IndexGenerationStore`
- `IndexGenerationPromotionService`

These sit above the existing durable `IngestionJobStore`,
`IngestionCheckpointStore`, `IngestionProgressStore`, and `IngestionJobRunner`.
Local mode can keep running inline. Enterprise mode can enqueue backfill/reindex
work, lease jobs to workers, retry transient failures, dead-letter exhausted
jobs, and only promote a candidate index generation after required evals pass.

The in-memory implementations are contract fixtures for local mode. The
Postgres implementations, `PostgresIngestionJobQueue` and
`PostgresIngestionLeaseStore`, provide the durable production backend over
`rag_core.ingestion_queue` and `rag_core.ingestion_leases`. Apply
`deploy/postgres/007_ingestion_scale_queue.sql` before enabling distributed
workers.

`ProductionIngestionWorker` connects the worker-control layer to the existing
`IngestionJobRunner`:

1. Claim the next eligible queue item.
2. Acquire source leases and, for reindex jobs, a generation lease.
3. Keep queue and resource leases alive while ingestion runs.
4. Run the existing production ingest runtime.
5. Complete, retry, or dead-letter the queue item.

The worker is intentionally runtime-agnostic. It can use in-memory queue/lease
stores for local tests or Postgres queue/lease stores for distributed workers
without changing the ingestion runner.

Generation promotion state is also portable. `InMemoryIndexGenerationStore`
keeps local tests simple, while `PostgresIndexGenerationStore` persists
candidate/active/deprecated manifests and promotion records in
`rag_core.index_generation_manifests` and
`rag_core.index_generation_promotions`. Apply
`deploy/postgres/008_index_generation_promotions.sql` with the queue migration.
The promotion service refuses to switch the active generation until every
required eval id has a passing result; Postgres additionally enforces one active
generation per tenant/namespace.

The CLI exposes this as storage-only control-plane commands:

- `inspect-index-generations`
- `inspect-generation-promotion`
- `plan-generation-promotion`
- `record-generation-eval`
- `promote-generation`

These commands use the same `IndexGenerationStore` boundary as the in-process
service. Local tests can inject an in-memory store; production deployments use
the Postgres store through configured index storage.

## Worker CLI

The production CLI now exposes the producer and worker boundaries. Enqueue a
portable backfill plan:

```bash
node dist/runtime/production-cli.js enqueue-ingestion \
  --plan-id backfill_acme_support_20260624 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --source-id support_docs \
  --source-id policies \
  --batch-size 10 \
  --priority 5 \
  --metadata reason=quarterly_backfill
```

For embedding/chunking migrations, dry-run or enqueue an explicit reindex plan:

```bash
node dist/runtime/production-cli.js enqueue-ingestion \
  --mode reindex \
  --dry-run true \
  --plan-id reindex_acme_support_embeddings_v2 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --source-id support_docs \
  --batch-size 10 \
  --generation-id gen_acme_support_embeddings_v2 \
  --embedding-provider openai \
  --embedding-model text-embedding-3-large \
  --embedding-dimensions 3072 \
  --embedding-config-hash cfg_hash \
  --embedding-index-config-hash index_hash \
  --chunking-policy-id default \
  --chunking-policy-version 2 \
  --required-eval-id retrieval_regression
```

Run bounded workers against those queued jobs:

```bash
node dist/runtime/production-cli.js worker \
  --max-jobs 10 \
  --worker-id worker_us_east_1a_1 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --principal-namespace-id acme-support \
  --user-id ingestion_worker \
  --role ingestion-worker \
  --overwrite replace
```

`--tenant-id`, `--namespace-id`, and `--source-id` are claim filters. If no
principal namespace is supplied, the worker derives one from the queued job
namespace so the same binary can run across profiles. Production deployments
should pass explicit principal flags when workers are pinned to a tenant or
namespace.

The enqueue and worker commands create `PostgresIngestionJobQueue` and
`PostgresIngestionLeaseStore` from the configured Postgres index storage. Tests
and embedded local runtimes can inject any `IngestionJobQueue` and
`IngestionLeaseStore`, which keeps the architecture portable while making
distributed production durable.

Worker output is intentionally a redacted summary: queue state, run ids, source
ids, counts, integrity summaries, and warnings. It does not print raw ingested
documents or chunks.

Queue control uses the same durable queue contract:

```bash
node dist/runtime/production-cli.js inspect-ingestion-queue \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --status dead_letter \
  --limit 20

node dist/runtime/production-cli.js cancel-ingestion-queue-job \
  --queue-id backfill_acme_support_20260624_queue_4 \
  --reason "Duplicate backfill request"

node dist/runtime/production-cli.js requeue-ingestion-queue-job \
  --queue-id backfill_acme_support_20260624_queue_5 \
  --available-at 2026-06-24T12:00:00.000Z \
  --max-attempts 3 \
  --reason "Provider recovered" \
  --metadata operator=search-team
```

Cancellation is limited to queued or leased jobs. Requeue is limited to
dead-letter jobs, resets the attempt counter, preserves the last error fields,
and adds bounded requeue metadata for audit.
