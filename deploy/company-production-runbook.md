# Company Production Runbook

This runbook promotes a compiled company deployment module onto the serious production target: Postgres documents/chunks, native pgvector text embeddings, and Postgres source-sync ledgers.

## Inputs

- compiled company module path, profile export, and adapter-pack export
- tenant id, namespace id, company use case id, source ids, and sync principal claims
- `RAG_DATABASE_URL` for a Postgres database where the `rag_core` schema can be created
- embedding dimensions and matching pgvector index migration
- provider endpoints and secrets for answer model, embedding model, and grounding judge

## 1. Build

```bash
npm ci
npm run build
```

## 2. Fill Production Env

```bash
cp deploy/company-production.example.env .env.company-production
```

Replace placeholder values from the deployment secret manager. Keep:

```text
RAG_INDEX_KIND=postgres
RAG_VECTOR_KIND=postgres
RAG_SOURCE_SYNC_LEDGER_KIND=postgres
RAG_POSTGRES_URL_ENV=RAG_DATABASE_URL
RAG_APP_EMBEDDING_MODE=required
RAG_APP_GROUNDING_JUDGE_MODE=required
RAG_COMPANY_PACK_CONTRACT_MODE=required
```

## 3. Automated Postgres Gate

For an actual local Postgres/pgvector deployment drill, start the bundled pgvector service:

```bash
docker compose -f deploy/postgres/docker-compose.pgvector.yml up -d
export RAG_DATABASE_URL=postgres://rag:rag_dev_password@127.0.0.1:54329/rag
```

Then run the automated storage gate with a deterministic local provider. This applies migrations, checks Postgres readiness, runs full company smoke, then runs delta company smoke while writing real Postgres rows and pgvector embeddings:

```bash
npm run company:smoke:postgres -- \
  --local-provider \
  --reset-schema \
  --probe-providers \
  --report-dir .rag/company-postgres-smoke/latest
```

Prefer `RAG_DATABASE_URL` or `RAG_POSTGRES_URL_ENV` over `--database-url` for normal runs, because package managers and CI systems often echo CLI arguments. `--local-provider` is only for storage and deployment-pipeline validation. It proves the provider HTTP boundary can write deterministic embeddings into pgvector, but it is not proof that the live answer, embedding, rerank, or grounding providers are healthy.

For a real deployment with real provider endpoints and secrets, omit `--local-provider` and point at the filled env file:

```bash
npm run company:smoke:postgres -- \
  --env-file .env.company-production \
  --probe-providers \
  --report-dir .rag/company-postgres-smoke/latest
```

Do not use `--reset-schema` against a shared or production database.

The script writes `.rag/company-postgres-smoke/latest/postgres-company-smoke.json` plus nested full and delta company-smoke artifacts. Promote only when the top-level report is `passed` and both nested smoke gates pass.

The CI version of this gate is `.github/workflows/company-postgres-smoke.yml`. It runs the same command against a `pgvector/pgvector:pg17` service container and uploads `.rag/company-postgres-smoke/ci` as a release artifact, so failed promotion runs keep their Postgres smoke reports.

## 4. Manual Storage Migration

The automated gate applies these migrations by default. To apply them manually:

```bash
set -a
. ./.env.company-production
set +a

psql "$RAG_DATABASE_URL" -f deploy/postgres/001_core_storage.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/002_vector_hnsw_1536.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/003_ingestion_failure_stage.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/004_admin_trace_history.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/005_admin_connector_state.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/006_admin_review_queue.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/007_ingestion_scale_queue.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/008_index_generation_promotions.sql
```

`002_vector_hnsw_1536.sql` is only correct when `RAG_VECTOR_DIMENSIONS=1536`. For another embedding dimension, copy that migration, replace `1536`, and apply the copied migration before traffic.

## 5. Validate The Company Pack

```bash
set -a
. ./.env.company-production
set +a

npm run company:validate -- \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportDeployment \
  --require-manifest-env \
  --require-smoke-commands \
  --manifest-root . \
  --run-pack-contracts \
  --use-case support \
  --principal-role support \
  --principal-tag trusted \
  --report-dir .rag/company/acme-support
```

Do not promote unless `.rag/company/acme-support/company-deployment.json` reports `status=ready` and `.rag/company/acme-support/company-pack-contracts.json` reports `status=passed`.
The manifest validation section must also report `status=passed`; that proves required production env names are populated, required eval files exist under the manifest root, and the module publishes its smoke commands.

## 6. Check Runtime And Database Readiness

```bash
set -a
. ./.env.company-production
set +a

node dist/runtime/production-cli.js validate-config --run-pack-contracts true
node dist/runtime/production-cli.js validate-config --self-test true
```

The self-test calls the Postgres index and vector readiness checks. It fails when the core tables, weighted FTS index, pgvector extension, vector table, embedding identity filter index, vector dimension compatibility, or dimension-specific ANN index are missing.

For a controlled live-provider drill, add:

```bash
node dist/runtime/production-cli.js validate-config --self-test true --probe-providers true
```

## 7. First Import

Use full sync for the first import or repair. Keep `--delete-missing false` on the first promotion if the connector's full listing has not yet been proven complete in production.

```bash
npm run company:smoke -- \
  --env-file .env.company-production \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportDeployment \
  --use-case support \
  --sync-mode full \
  --delete-missing false \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --source-id support_docs \
  --principal-user-id sync_operator \
  --principal-tenant-id tenant_acme \
  --principal-namespace-id acme-support \
  --principal-role support \
  --principal-tag trusted \
  --report-dir .rag/company-smoke/latest
```

Do not promote unless `.rag/company-smoke/latest/smoke.json` reports `status=passed` with `packContracts`, `sync`, and `selfTest` all passed.

## 8. Delta Smoke

After the first import, normal company updates should use delta sync against the saved Postgres ledger:

```bash
npm run company:smoke -- \
  --env-file .env.company-production \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportDeployment \
  --use-case support \
  --sync-mode delta \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --source-id support_docs \
  --principal-user-id sync_operator \
  --principal-tenant-id tenant_acme \
  --principal-namespace-id acme-support \
  --principal-role support \
  --principal-tag trusted \
  --report-dir .rag/company-smoke/latest
```

Delta smoke proves the module can reload the saved source-sync cursor and write a new safe ledger entry without replaying the whole source system.

## 9. Distributed Ingestion Workers

For large backfills, enqueue bounded batches instead of running one foreground
ingest:

```bash
node dist/runtime/production-cli.js enqueue-ingestion \
  --plan-id backfill_acme_support_20260624 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --source-id support_docs \
  --batch-size 10 \
  --priority 5 \
  --metadata reason=promotion_backfill
```

Then run one or more bounded workers:

```bash
node dist/runtime/production-cli.js worker \
  --max-jobs 10 \
  --worker-id worker_acme_1 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --principal-namespace-id acme-support \
  --user-id ingestion_worker \
  --role ingestion-worker \
  --overwrite replace
```

Use `enqueue-ingestion --mode reindex --dry-run true` before embedding or
chunking migrations to review the candidate generation and promotion plan before
writing queue rows.

Inspect, cancel, or requeue queue items through the same CLI:

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

Cancellation only applies to queued or leased jobs. Requeue only applies to
dead-letter jobs and preserves the last error fields for audit.

## 10. Promote Index Generations

For embedding or chunking migrations, persist the candidate generation and
promotion gate before switching active traffic:

```bash
node dist/runtime/production-cli.js plan-generation-promotion \
  --promotion-id promote_acme_support_20260624 \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --profile-id acme-support-profile \
  --generation-id gen_acme_support_20260624 \
  --embedding-provider openai \
  --embedding-model text-embedding-3-large \
  --embedding-dimensions 3072 \
  --embedding-config-hash replace_with_candidate_embedding_hash \
  --embedding-index-config-hash replace_with_candidate_index_hash \
  --chunking-policy-id default \
  --chunking-policy-version 2 \
  --required-eval-id retrieval_regression \
  --required-eval-id citation_regression
node dist/runtime/production-cli.js record-generation-eval \
  --promotion-id promote_acme_support_20260624 \
  --eval-id retrieval_regression \
  --eval-status passed \
  --report-uri s3://rag-evals/acme/retrieval-regression.json
node dist/runtime/production-cli.js record-generation-eval \
  --promotion-id promote_acme_support_20260624 \
  --eval-id citation_regression \
  --eval-status passed \
  --report-uri s3://rag-evals/acme/citation-regression.json
node dist/runtime/production-cli.js inspect-generation-promotion \
  --promotion-id promote_acme_support_20260624
node dist/runtime/production-cli.js promote-generation \
  --promotion-id promote_acme_support_20260624
```

`promote-generation` fails if any required eval id is missing or failed. After
promotion, verify the active generation:

```bash
node dist/runtime/production-cli.js inspect-index-generations \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --generation-status active
```

## 11. Inspect Production State

After full or delta sync, inspect the durable Postgres job state before opening traffic:

```bash
node dist/runtime/production-cli.js inspect-ingestion-jobs \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --limit 20
node dist/runtime/production-cli.js inspect-ingestion-job \
  --job-id company_sync_20260624 \
  --source-id support_docs \
  --document-status failed \
  --document-limit 50
node dist/runtime/production-cli.js inspect-source-health \
  --job-id company_sync_20260624 \
  --source-id support_docs
```

Use the latest run id from the smoke artifact or job list. The output includes job stage, checkpoints, source progress, failed documents, skipped documents, accepted documents, and retryable failure counts without source bodies or chunk text.

For eval and incident artifacts:

```bash
node dist/runtime/production-cli.js inspect-eval-failure --summary .rag/eval-runs/latest/summary.json
node dist/runtime/production-cli.js inspect-citation --context .rag/eval-runs/latest/context.json
```

## 12. Serve

```bash
set -a
. ./.env.company-production
set +a

node dist/runtime/production-cli.js serve
```

Verify operations endpoints from inside the deployment network:

```bash
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:8787/metrics
```

## Promotion Rule

Promote only when all of these are true:

- migrations applied for the configured vector dimensions
- company validator reports `ready`
- manifest validation reports `passed`
- pack contracts report `passed`
- runtime self-test reports `passed`
- first full company smoke reports `passed`
- delta company smoke reports `passed`
- provider probes have passed for every required live provider during a controlled deployment drill

## Rollback

Stop traffic first. Repoint `RAG_COMPANY_MODULE_PATH` and `RAG_COMPANY_DEPLOYMENT_EXPORT` to the previous compiled module, then rerun `validate-config --run-pack-contracts true` and a delta company smoke. If the failed rollout may have produced incorrect deletes, run a repair full sync with `--delete-missing false` until the connector's complete listing is trusted.
