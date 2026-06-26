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

## 4. Manual Storage Migration

The automated gate applies these migrations by default. To apply them manually:

```bash
set -a
. ./.env.company-production
set +a

psql "$RAG_DATABASE_URL" -f deploy/postgres/001_core_storage.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/002_vector_hnsw_1536.sql
```

`002_vector_hnsw_1536.sql` is only correct when `RAG_VECTOR_DIMENSIONS=1536`. For another embedding dimension, copy that migration, replace `1536`, and apply the copied migration before traffic.

## 5. Validate The Company Pack

```bash
npm run company:validate -- \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportCompanyProfile \
  --adapter-pack-export acmeSupportAdapterPack \
  --run-pack-contracts \
  --use-case support \
  --principal-role support \
  --principal-tag trusted \
  --report-dir .rag/company/acme-support
```

Do not promote unless `.rag/company/acme-support/company-deployment.json` reports `status=ready` and `.rag/company/acme-support/company-pack-contracts.json` reports `status=passed`.

## 6. Check Runtime And Database Readiness

```bash
set -a
. ./.env.company-production
set +a

node dist/runtime/production-cli.js validate-config --run-pack-contracts true
node dist/runtime/production-cli.js validate-config --self-test true
```

The self-test calls the Postgres index and vector readiness checks. It fails when the core tables, weighted FTS index, pgvector extension, vector table, vector dimension compatibility, or dimension-specific ANN index are missing.

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
  --export acmeSupportCompanyProfile \
  --adapter-pack-export acmeSupportAdapterPack \
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
  --export acmeSupportCompanyProfile \
  --adapter-pack-export acmeSupportAdapterPack \
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

## 9. Serve

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
- pack contracts report `passed`
- runtime self-test reports `passed`
- first full company smoke reports `passed`
- delta company smoke reports `passed`
- provider probes have passed for every required live provider during a controlled deployment drill

## Rollback

Stop traffic first. Repoint `RAG_COMPANY_MODULE_PATH` and adapter-pack exports to the previous compiled module, then rerun `validate-config --run-pack-contracts true` and a delta company smoke. If the failed rollout may have produced incorrect deletes, run a repair full sync with `--delete-missing false` until the connector's complete listing is trusted.
