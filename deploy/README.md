# Adaptable RAG Deployment

This deployment package runs the production CLI in HTTP mode:

```text
Docker container -> node dist/runtime/production-cli.js serve -> GET /health, GET /ready, GET /metrics, POST /answer
```

## Local Docker Run

```bash
cp .env.example .env
docker compose --env-file .env up --build
curl http://127.0.0.1:8787/ready
```

The compose service mounts a named volume at `/data`. By default the index path is `/data/index.json`, so durable JSON state survives container restarts.
Replace `RAG_HTTP_AUTH_TOKEN` in `.env` with a high-entropy secret before sending answer requests.

## Production Postgres Storage

For company deployments, use Postgres with pgvector instead of JSON files. Apply the core schema before starting the service:

```bash
psql "$RAG_DATABASE_URL" -f deploy/postgres/001_core_storage.sql
psql "$RAG_DATABASE_URL" -f deploy/postgres/002_vector_hnsw_1536.sql
```

Then configure the app:

```text
RAG_INDEX_KIND=postgres
RAG_VECTOR_KIND=postgres
RAG_VECTOR_DIMENSIONS=1536
RAG_SOURCE_SYNC_LEDGER_KIND=postgres
RAG_POSTGRES_URL_ENV=RAG_DATABASE_URL
RAG_DATABASE_URL=postgres://rag:replace_me@postgres:5432/rag
RAG_POSTGRES_SCHEMA=rag_core
```

The Postgres index stores normalized documents and chunks as JSONB with queryable tenant, namespace, source, trust, safety, access-tag, and weighted full-text columns. The same database stores text embeddings in `rag_core.chunk_vectors` through pgvector, so production hybrid retrieval can run as Postgres FTS plus pgvector without JSON snapshots or a separate hosted vector service.

Use `deploy/company-production.example.env` as the safe starting env template for this target. It sets `RAG_INDEX_KIND=postgres`, `RAG_VECTOR_KIND=postgres`, `RAG_SOURCE_SYNC_LEDGER_KIND=postgres`, required text embeddings, required grounding judge config, HTTP auth/rate limits, and company pack-contract enforcement. The full command sequence lives in `deploy/company-production-runbook.md`.

For an actual local pgvector drill, start `deploy/postgres/docker-compose.pgvector.yml`, set `RAG_DATABASE_URL=postgres://rag:rag_dev_password@127.0.0.1:54329/rag`, then run:

```bash
npm run company:smoke:postgres -- \
  --local-provider \
  --reset-schema \
  --probe-providers \
  --report-dir .rag/company-postgres-smoke/latest
```

The Postgres smoke applies migrations, runs startup readiness against Postgres and pgvector, runs full company smoke, then runs delta company smoke. It writes `.rag/company-postgres-smoke/latest/postgres-company-smoke.json` plus nested full and delta smoke artifacts. `--local-provider` is only for deterministic storage validation; omit it and use `--env-file .env.company-production --probe-providers` for real provider deployment checks.

Production ingestion also writes durable run state to `rag_core.ingestion_jobs`. Each job records the tenant, namespace, source ids, status, current stage, checkpoint payload, safe counts, and redacted error fields. Reusing a failed `runId` resumes from completed source/document checkpoints in that durable record; reusing a completed `runId` starts a fresh replace-style pass through the same job id. An already running job is rejected so two workers do not silently race on the same ingest run.

Incremental source connectors should persist their sync ledger in Postgres through `PostgresSourceSyncLedgerStore`. The core schema includes `rag_core.source_sync_ledgers` for the current safe ledger JSON and `rag_core.source_sync_ledger_entries` for queryable source item state, including active records, deleted tombstones, failed retry state, safe hashes, and cursors. These tables are the production basis for delta syncs and delete propagation without reloading entire company sources.

Connector integrations should use `createProductionSourceSyncRuntime({ app, connector })`. The runtime pulls the production chunk store, vector store, visual vector store, source-sync ledger store, embedding adapters, and graph delete-pruning store from the assembled app, then runs delta/full sync, delete propagation, ingestion, post-ingest indexing, and safe ledger saves through one path.

For multi-company deployments, register connector packs through `CompanyAdapterPack`: include corpus adapters, parser extensions, live `SourceConnector` instances, optional source-system permission mappers, parser fixtures, adapter expectation overrides, and contract-test commands. `assembleCompanyProductionSourceSyncRuntimes(...)` resolves the company/use-case profile, validates that the production app matches it, binds each declared connector to the right source ids, and returns ready-to-run sync runtimes.

Before accepting a company connector pack, run `assertCompanyPackContractTests({ registry, company, requestedBy })` from the deployment test suite. The gate validates selected corpus adapters against declared sources, validates selected parsers against pack-owned parser fixtures, executes every registered connector/source pair in delta and full mode, passes the delta ledger into the full sync, validates permission mapper tenant/namespace boundaries, and fails on adapter normalization errors, missing parser fixtures, connector errors, incomplete full syncs, source mismatches, unsafe ACL mapping, delete tombstones without record ids, unsafe ledger scope, ledger evidence-boundary drift, or raw source bodies leaking into ledgers.

The packaged validator can run the same gate from a deployment module:

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

Use `--adapter-pack-export` once per exported pack or export an array. If no `--use-case` is provided, the validator runs pack contracts for every company use case. Optional controls include `--contract-mode delta|full`, `--min-delta-returned-records`, `--allow-incomplete-full`, `--allow-open-acl`, `--disallow-connector-warnings`, `--contract-requested-at`, and principal flags for user, tenant, namespace, team, role, and tag. The `company-pack-contracts.json` artifact includes issue codes and safe counts only; it does not include connector records, parser bodies, warning payloads, source bodies, credentials, or principal claims.

For production startup, point the compiled CLI at the same company module:

```text
RAG_COMPANY_MODULE_PATH=dist/company/examples/acme-support.company.js
RAG_COMPANY_PROFILE_EXPORT=acmeSupportCompanyProfile
RAG_COMPANY_ADAPTER_PACK_EXPORTS=acmeSupportAdapterPack
RAG_COMPANY_USE_CASE_ID=support
RAG_COMPANY_PACK_CONTRACT_MODE=required
```

Then run:

```bash
node dist/runtime/production-cli.js validate-config --run-pack-contracts true
node dist/runtime/production-cli.js sync \
  --mode delta \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --user-id sync_operator \
  --principal-namespace-id acme-support \
  --role support \
  --source-id support_docs
node dist/runtime/production-cli.js serve
```

The CLI builds a `CompanyDeploymentRegistry`, selects the company use-case profile by `RAG_COMPANY_USE_CASE_ID`, `RAG_COMPANY_PROFILE_ID`, or `RAG_COMPANY_NAMESPACE_ID`, injects that profile into the production app config, and passes the selected adapter pack's corpus adapters and parsers into ingestion. `RAG_COMPANY_PACK_CONTRACT_MODE=required` fails startup before serving if the selected pack does not pass the contract gate.

Use `sync --mode delta` for normal incremental company updates. Use `sync --mode full` for first import, repair, or reconciliation; full sync tombstones previous ledger items that the complete connector result no longer lists unless `--delete-missing false` is supplied. Sync output is redacted to counts, statuses, warning codes, and ledger-save state; it does not include connector records, document bodies, chunk text, cursors, source ACL payloads, credentials, or principal claims.

Run the whole company deployment gate as one repeatable smoke before promotion:

```bash
npm run company:smoke -- \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportCompanyProfile \
  --adapter-pack-export acmeSupportAdapterPack \
  --use-case support \
  --source-id support_docs \
  --env-file deploy/company-production.env \
  --report-dir .rag/company-smoke/latest
```

The smoke loads the compiled company module, runs pack contracts, runs `sync --mode delta` unless `--skip-sync` is set, then runs `validate-config --self-test true`. It writes `.rag/company-smoke/latest/smoke.json` with only safe gate status, counts, warnings, and failures; connector records, source bodies, chunks, cursor values, credentials, provider payloads, and raw principal claims are excluded. Add `--sync-mode full` for reconciliation drills and `--probe-providers` only during controlled deployment checks.

Use `templates/company-connector-pack/` for a copyable company integration skeleton. It includes a company profile, adapter pack, source connector, corpus adapter, permission mapper, and a pack contract test that can be kept in the company deployment repo.

`002_vector_hnsw_1536.sql` is dimension-specific. If the embedding provider uses a dimension other than `1536`, copy that migration and replace `1536` with the configured `RAG_VECTOR_DIMENSIONS` value. `validate-config --self-test true` fails Postgres vector readiness when the pgvector extension, core tables, FTS index, dimensions, or dimension-specific ANN index are missing.

## Startup Validation

Run a cheap static config check before serving:

```bash
node dist/runtime/production-cli.js validate-config
node dist/runtime/production-cli.js validate-config --self-test true
```

Use live provider probes only during deployment checks or controlled smoke tests, because they call configured providers:

```bash
node dist/runtime/production-cli.js validate-config --self-test true --probe-providers true
```

The self-test checks retrieval capability honesty, required vector/visual components, fixed dimension compatibility, model reranker wiring, and grounding judge wiring. Provider probes use tiny synthetic requests and return redacted status records. They do not log prompt text, context text, bearer tokens, API keys, or principal claims.

For a repeatable provider smoke drill with artifacts, copy `deploy/provider-smoke.example.env`, fill real endpoints/secrets from the deployment secret manager, and run:

```bash
cp deploy/provider-smoke.example.env .env.smoke
OPENAI_API_KEY=... npm run smoke:providers -- --env-file .env.smoke
```

The smoke runner writes `smoke.json`, `self-test.json`, and `report.html` to `.rag/provider-smoke/latest` by default. It fails when a required provider is skipped, missing, or failed. Required providers default to configured runtime providers, and can be made explicit with `RAG_SMOKE_REQUIRED_PROVIDERS=model,embedding,rerank` or `--required-providers model,embedding`.

## Trace Replay

Eval summaries include safe traces for incident replay. To reproduce an eval incident, keep the original `.rag/eval-runs/latest/summary.json`, rerun the current code, and compare:

```bash
npm run replay:eval
node scripts/run-trace-replay.mjs --eval-summary .rag/eval-runs/latest/summary.json --trace-id eval_trace_id --report-dir .rag/trace-replay/latest
```

The replay runner writes `replay.json`, `current-summary.json`, and `report.html` to `.rag/trace-replay/latest`. It fails when the target case disappears, safe trace data is missing, status/retrieval/citation behavior changes, or the linked run/trace event chain breaks. Replay reports use hashes, ids, statuses, citation pointers, and event metadata; they do not include raw questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, or principal claims.

## SLO Alerts

After evals and trace replay, run the operational SLO gate:

```bash
npm run slo:check
node scripts/run-slo-check.mjs \
  --eval-benchmark .rag/eval-runs/latest/benchmark.json \
  --trace-replay .rag/trace-replay/latest/replay.json \
  --provider-smoke .rag/provider-smoke/latest/smoke.json \
  --http-metrics path/to/http-metrics.json \
  --report-dir .rag/slo/latest
```

The SLO runner writes `slo.json`, `alerts.json`, and `report.html` to `.rag/slo/latest`. High and critical alerts fail the gate; warning alerts are reported without failing CI. Alert events contain rule ids, categories, severities, thresholds, observed values, and runbook actions. They do not contain raw questions, prompt text, retrieved context, generated answers, bearer tokens, API keys, source bodies, or principal claims.

## Alert Delivery

CI runs alert delivery in dry-run mode:

```bash
npm run alerts:deliver
```

The dry-run reads `.rag/slo/latest/alerts.json` and writes `delivery.json` to `.rag/alert-delivery/latest` without sending network requests.

For a live deployment drill, configure a webhook sink through env or CLI flags:

```text
RAG_ALERT_DELIVERY_MODE=live
RAG_ALERT_WEBHOOK_URL=https://alerts.example.test/rag
RAG_ALERT_WEBHOOK_FORMAT=generic
RAG_ALERT_WEBHOOK_TOKEN_ENV=RAG_ALERT_WEBHOOK_TOKEN
RAG_ALERT_WEBHOOK_TOKEN=replace_me
RAG_ALERT_WEBHOOK_TIMEOUT_MS=10000
RAG_ALERT_WEBHOOK_MAX_RETRIES=2
RAG_ALERT_WEBHOOK_BACKOFF_MS=250
```

Supported formats are `generic`, `slack`, and `pagerduty_events_v2`. PagerDuty delivery uses `RAG_ALERT_PAGERDUTY_ROUTING_KEY_ENV` to point at the routing-key variable instead of storing it in config. Delivery reports include delivery status, sink attempts, dedupe keys, and redacted errors. They do not include bearer tokens, routing keys, raw prompts, retrieved context, generated answers, source bodies, or principal claims.

## Incident Bundle

After evals, replay, SLO checks, and alert delivery, build the release or incident evidence bundle:

```bash
npm run incident:bundle
node scripts/build-incident-bundle.mjs \
  --eval-benchmark .rag/eval-runs/latest/benchmark.json \
  --eval-summary .rag/eval-runs/latest/summary.json \
  --trace-replay .rag/trace-replay/latest/replay.json \
  --slo .rag/slo/latest/slo.json \
  --alert-delivery .rag/alert-delivery/latest/delivery.json \
  --provider-smoke .rag/provider-smoke/latest/smoke.json \
  --report-dir .rag/incidents/latest
```

The bundle writes `incident.json` and `postmortem.md` to `.rag/incidents/latest`. It links the artifact paths, status, severity, metrics, impacted profiles, runbooks, findings, recommended actions, and safe trace summaries. Use the Markdown file as the postmortem starter, then attach or link the underlying local artifacts for deeper inspection.

Incident exports are intentionally redacted. They do not copy raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, or full principal claims.

## Human Review Queue

Build the human review handoff after evals and incident bundle generation:

```bash
npm run review:queue
node scripts/build-review-queue.mjs \
  --eval-summary .rag/eval-runs/latest/summary.json \
  --incident .rag/incidents/latest/incident.json \
  --report-dir .rag/human-review/latest
```

The runner writes `queue.json` and `queue.md` to `.rag/human-review/latest`. Queue items include profile ids, namespace ids, trace ids, priorities, SLA due times, destinations from profile `escalationRules`, reason codes, artifact paths, and safe trace summaries.

Expected refusals are skipped by default. Use `--include-refusals` only when a deployment wants every refusal reviewed. Open queue items do not fail CI by themselves; they are work items for the project operator, support lead, security owner, or incident responder.

Queue artifacts do not include raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, or full principal claims.

## Review Decision Ledger

After operators triage queue items, build the decision ledger:

```bash
npm run review:ledger
node scripts/build-review-ledger.mjs \
  --queue .rag/human-review/latest/queue.json \
  --decisions .rag/human-review/decisions.jsonl \
  --report-dir .rag/review-ledger/latest
```

The decisions file is optional. When it is absent, the runner still writes an empty release ledger so CI has a linked audit artifact. When present, each JSONL record should include a `queueItemId`, `action`, reviewer identity as either `reviewerId` or `reviewerIdHash`, and a short `summary`.

The runner writes `ledger.json`, `feedback.json`, and `ledger.md` to `.rag/review-ledger/latest`. Feedback signals are safe shells for eval candidates, profile policy updates, corpus updates, incident follow-ups, or routing updates.

Ledger artifacts do not include raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, or un-hashed reviewer identifiers.

## Review Ticket Sync

After the queue and ledger exist, dry-run external ticket sync:

```bash
npm run review:sync
node scripts/sync-review-tickets.mjs \
  --queue .rag/human-review/latest/queue.json \
  --ledger .rag/review-ledger/latest/ledger.json \
  --report-dir .rag/review-sync/latest \
  --mode dry-run
```

The runner writes `tickets.json`, `sync.json`, and `sync.md` to `.rag/review-sync/latest`. CI uses dry-run mode, so it proves payload shape, dedupe keys, report generation, and redaction without sending network requests.

For a live deployment drill, configure a project-owned webhook or ticket-sync bridge:

```text
RAG_REVIEW_SYNC_MODE=live
RAG_REVIEW_SYNC_WEBHOOK_URL=https://tickets.example.test/rag-review
RAG_REVIEW_SYNC_WEBHOOK_TOKEN_ENV=REVIEW_TICKET_WEBHOOK_TOKEN
REVIEW_TICKET_WEBHOOK_TOKEN=replace_me
RAG_REVIEW_SYNC_WEBHOOK_TIMEOUT_MS=10000
RAG_REVIEW_SYNC_WEBHOOK_MAX_RETRIES=2
RAG_REVIEW_SYNC_WEBHOOK_BACKOFF_MS=250
```

Live sync uses POST, timeout, retry on configured retryable statuses, HTTPS except localhost, bearer-token injection from the named env var, and secret redaction from errors. The webhook payload is generic so a project can translate it to Linear, Jira, Zendesk, an admin dashboard, or an internal support queue.

Ticket sync artifacts do not include raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, or un-hashed reviewer identifiers.

## Review Ticket Reconciliation

After dry-run or live ticket sync, reconcile local review payloads with the external ticket system:

```bash
npm run review:reconcile
node scripts/reconcile-review-tickets.mjs \
  --tickets .rag/review-sync/latest/tickets.json \
  --sync .rag/review-sync/latest/sync.json \
  --external-statuses .rag/review-sync/external-statuses.jsonl \
  --report-dir .rag/review-reconciliation/latest
```

The runner writes `idempotency-store.json`, `reconciliation.json`, and `reconciliation.md` to `.rag/review-reconciliation/latest`. The idempotency store preserves first-seen timestamps, payload hashes, external references, last live sync times, and reconciliation statuses so repeated deploys do not create duplicate tickets.

External status snapshots are optional. When present, `.rag/review-sync/external-statuses.jsonl` should contain one JSON object per external ticket:

```json
{
  "dedupeKey": "rag_review_ticket:queue_item:create:review_1:trace_1",
  "externalId": "TICKET-123",
  "status": "open",
  "updatedAt": "2026-06-24T00:00:00.000Z",
  "url": "https://tickets.example.test/TICKET-123"
}
```

Closed or resolved external statuses mark local entries closed. Old open statuses become stale after the configured threshold, which makes reconciliation return `needs_attention`. Duplicate dedupe keys and failed sync evidence fail the gate.

Reconciliation artifacts do not include raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, or un-hashed reviewer identifiers. External status text, URLs, and metadata are treated as untrusted operational input and redacted before persistence.

## Support Event Export Validation

Project support/admin systems should export safe `RagSupportEvent` records before the generic support knowledge flow runs. Project-owned adapter code should implement `RagSupportEventExporter` and test it with `assertRagSupportEventExporterContract()` so raw tickets, raw customer messages, raw diagnostics, source bodies, secrets, and raw reviewer identifiers stay outside the RAG core.

For a copyable project connector skeleton, use `templates/project-support-connector/`. It wraps project-owned loading and mapping code with `createRagProjectSupportEventExporter()` and keeps project-specific support/admin code outside the generic RAG core. This is the shipped connector surface for support/admin knowledge promotion; vendor SDK clients such as Zendesk, Intercom, Jira, Slack, or admin-database clients should live in the project deployment wrapper.

Validate the exported handoff files:

```bash
npm run support:export:validate
node scripts/validate-support-event-export.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-export/latest
```

The validator writes `export.json`, `validation.json`, `export.md`, `events.jsonl`, and `decisions.jsonl` to `.rag/support-export/latest`. A passing validation proves shape, idempotency safety, redaction, approval-gate intent, and reviewer-id hashing. It does not make events answerable knowledge.

## Support Knowledge Flow

After a project exports safe support/admin events, build the support knowledge handoff:

```bash
npm run support:knowledge
node scripts/run-support-knowledge-flow.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-knowledge/latest
```

The runner writes `event-ledger.json`, `candidate-queue.json`, `candidate-queue.md`, `approval-ledger.json`, `approval-ledger.md`, `approved-knowledge.sources.json`, `flow.json`, and `flow.md` to `.rag/support-knowledge/latest`.

The approval decisions file is optional. Without accepted approval decisions, the runner still writes the idempotency ledger and review queue, but it emits no approved source entries. With accepted approvals, `approved-knowledge.sources.json` references `approval-ledger.json` and exact approved artifact ids.

To continue into ingestion, mount or copy the generated source config and set:

```text
RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH=.rag/support-knowledge/latest/approved-knowledge.sources.json
```

This flow does not ingest, chunk, index, or make support knowledge answerable. Production ingestion must still read the referenced approval ledger, verify `approvedArtifacts`, enforce source ids, body hashes, trust floors, access controls, chunking, and index admission.

Support knowledge flow artifacts do not include raw admin ticket payloads, raw customer messages, raw diagnostics, raw generated answers, rendered prompts, source bodies, bearer tokens, API keys, routing keys, full principal claims, or raw reviewer identifiers.

## Support Operator Drill

Run the operator drill when you want one report that connects export validation, support knowledge approval flow, generated approved-source config, and the production-ingestion gate:

```bash
npm run support:drill
node scripts/run-support-operator-drill.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-drill/latest
```

The script writes `drill.json`, `drill.md`, `validation.json`, `export.json`, `events.jsonl`, `decisions.jsonl`, `flow.json`, `approval-ledger.json`, and `approved-knowledge.sources.json` to `.rag/support-drill/latest` when those stages are available.

The CLI drill does not ingest on its own. It proves that safe support events and approved artifacts remain non-answerable until production ingestion admits chunks. Projects can run a full live drill by calling `runRagSupportOperatorDrill()` with a real `ProductionIngestRuntime`; that path records pre/post index counts and only marks retrieval eligibility after new chunks exist.

## Ingestion

Production ingestion is a CLI job, not an unauthenticated HTTP write surface. For profile sources that use `local-files`, point `RAG_LOCAL_FILES_SOURCES_PATH` at a mounted JSON config:

```text
RAG_LOCAL_FILES_SOURCES_PATH=/data/local-files.sources.json
```

See `deploy/local-files.example.json` for the config shape. Source config belongs to deployment because roots, mounted volumes, and source-level access defaults change per project.

For profile sources that use the built-in `approved_knowledge_artifact` adapter, point `RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH` at mounted config that references approval ledger JSON files:

```text
RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH=/data/approved-knowledge.sources.json
```

See `deploy/approved-knowledge-artifacts.example.json` for the config shape. The runtime reads only each ledger's `approvedArtifacts`; it does not ingest raw tickets, raw candidates, unapproved support events, or raw model outputs. Each approved artifact must still match the profile source id and pass body-hash verification, corpus normalization, trust-floor checks, access boundaries, chunking, and index admission.

Run ingestion through the same compiled entrypoint:

```bash
node dist/runtime/production-cli.js ingest \
  --tenant-id tenant_1 \
  --namespace-id generic-docs \
  --user-id ingest_operator \
  --principal-namespace-id generic-docs \
  --role reader \
  --source-id curated_docs \
  --overwrite replace
```

The command writes through `IngestPipeline` only: adapter load, corpus normalization, document store write, chunking, chunk store write, and optional embedding/vector indexing. Its output is a redacted operational summary with counts and warnings; it does not echo document bodies, chunk text, bearer tokens, provider secrets, or principal claims.

Project-specific one-off adapters are registered in code through `adapterExtensions`. For reusable company deployments, use `RAG_COMPANY_MODULE_PATH` plus `RAG_COMPANY_ADAPTER_PACK_EXPORTS` so the compiled CLI can load a trusted company module, validate the pack, and inject only the selected use case's adapters and parsers. The core runtime still rejects unknown adapter IDs, duplicate extension IDs, and attempts to override built-in adapters such as `local-files` or `approved_knowledge_artifact` before indexing begins.

Before registering a custom adapter, run `assertCorpusAdapterContract()` in the project adapter test suite. The contract test loads the adapter against a real profile source, checks warning redaction, and runs returned records through the same normalization rules used by production ingestion.

Visual ingestion is separate from text embeddings. Set `RAG_VISUAL_VECTOR_KIND=json_file`, `memory`, or `hosted` only when trusted parser extensions emit visual assets and the deployment config either provides `RAG_VISUAL_EMBEDDING_*` provider env or the wrapper injects a trusted `VisualEmbeddingAdapter`. Text-only chunks are not fabricated into visual vectors.

## Answer Request

```bash
curl -X POST http://127.0.0.1:8787/answer \
  -H "authorization: Bearer ${RAG_HTTP_AUTH_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{
    "question": "What is the refund policy?",
    "tenantId": "tenant_1",
    "namespaceId": "generic-docs",
    "principal": {
      "userId": "user_1",
      "tenantId": "tenant_1",
      "namespaceIds": ["generic-docs"],
      "teamIds": [],
      "roles": [],
      "tags": []
    }
  }'
```

The service refuses broad implicit access. Each request must pass HTTP bearer auth and provide tenant, namespace, and principal scope.

## Secrets

Use `*_API_KEY_ENV` variables to point at the actual secret variable:

```text
RAG_MODEL_API_KEY_ENV=ANSWER_MODEL_KEY
ANSWER_MODEL_KEY=replace_me
```

The app config records the secret variable name, not the secret value. Do not bake real `.env` files into the image.

HTTP edge auth uses the same pattern:

```text
RAG_HTTP_AUTH_TOKEN_ENV=RAG_HTTP_AUTH_TOKEN
RAG_HTTP_AUTH_TOKEN=replace_me_with_high_entropy_token
```

The loaded app config stores SHA-256 token hashes, not the raw token. Use a high-entropy token from your secret manager. Set `RAG_HTTP_AUTH_MODE=disabled` only for local trusted development.

## Rate Limiting

`/answer` is rate limited before request bodies are parsed or model providers are called:

```text
RAG_HTTP_RATE_LIMIT_MODE=enabled
RAG_HTTP_RATE_LIMIT_WINDOW_MS=60000
RAG_HTTP_RATE_LIMIT_MAX_REQUESTS=60
RAG_HTTP_RATE_LIMIT_MAX_KEYS=10000
```

Valid authenticated calls are keyed by token hash. Missing or invalid auth attempts are keyed by client IP. `RAG_HTTP_CLIENT_IP_HEADER` should only be set behind a trusted reverse proxy that strips untrusted inbound copies of that header.

## Operations

The HTTP server emits one request id per response and one redacted structured access event per request when JSON logging is enabled:

```text
RAG_HTTP_LOG_MODE=json
RAG_HTTP_REQUEST_ID_HEADER=x-request-id
RAG_HTTP_READINESS_PATH=/ready
RAG_HTTP_METRICS_PATH=/metrics
```

- `/health` is liveness.
- `/ready` is readiness and flips to `503` while the server drains.
- `/metrics` returns JSON counters for requests, routes, statuses, auth denials, rate limits, and answer outcomes.
- `SIGINT` and `SIGTERM` trigger graceful CLI shutdown: readiness is disabled, the listener closes, and shutdown events are logged.
- Access logs include request id, method, route, status, duration, outcome, safe trace ids, and safe failure stage names. They do not include raw questions, prompt text, retrieved context, bearer tokens, provider secrets, or principal claims.

## Hosted Vector Backends

Set `RAG_VECTOR_KIND=hosted` and choose one vendor:

```text
RAG_VECTOR_VENDOR=qdrant
RAG_VECTOR_ENDPOINT=http://qdrant:6333
RAG_VECTOR_COLLECTION=rag_points
RAG_VECTOR_API_KEY_ENV=VECTOR_VENDOR_KEY
```

Supported vendor values:

- `pinecone`
- `qdrant`
- `weaviate`
- `pgvector-rpc`

The hosted vector service still returns untrusted pointers. `HostedVectorStore` resolves every match through the local chunk store and access filter before retrieval can use it.

## Visual Vector Storage

Visual vectors use their own store because ColPali-style multi-vector records are not the same shape as text embeddings. For local durable storage:

```text
RAG_VISUAL_VECTOR_KIND=json_file
RAG_VISUAL_VECTOR_PATH=/data/visual-vectors.json
RAG_VISUAL_VECTOR_DIMENSIONS=128
```

For hosted visual storage, visual records are fanned out into patch vectors over the same vendor transports. Remote matches still resolve through the local chunk store and request access filter before local MaxSim aggregation:

```text
RAG_VISUAL_VECTOR_KIND=hosted
RAG_VISUAL_VECTOR_VENDOR=qdrant
RAG_VISUAL_VECTOR_ENDPOINT=http://qdrant:6333
RAG_VISUAL_VECTOR_COLLECTION=rag_visual_points
RAG_VISUAL_VECTOR_NAME=visual
RAG_VISUAL_VECTOR_API_KEY_ENV=VISUAL_VECTOR_VENDOR_KEY
```

The visual embedding provider uses the same provider boundary as text embeddings:

```text
RAG_APP_VISUAL_EMBEDDING_MODE=required
RAG_VISUAL_EMBEDDING_PROVIDER=indexed-visual-embedding
RAG_VISUAL_EMBEDDING_MODEL_NAME=visual-embedding-model
RAG_VISUAL_EMBEDDING_ENDPOINT=https://provider.example.test/v1/visual-embeddings
RAG_VISUAL_EMBEDDING_API_KEY_ENV=VISUAL_EMBEDDING_MODEL_KEY
VISUAL_EMBEDDING_MODEL_KEY=replace_me
RAG_VISUAL_EMBEDDING_DIMENSIONS=128
```

The generic indexed visual preset accepts multi-vector payloads such as `vectors`, `embeddings`, or `embedding` per returned item and maps provider indices or ids back to submitted visual inputs. Provider output is still validated locally: ids cannot be unknown, vectors must be finite and match configured dimensions, provider secrets are redacted, and every visual match resolves through the chunk store and request access filter.

## Advanced Capability Wiring

The production image includes the safe boundaries for advanced RAG features, not heavyweight third-party parsers or connector SDKs. Wire them as follows:

- DeepDoc-style parsing: register a trusted parser/local-file adapter extension in the deployment wrapper. The parser should emit normalized text plus `DocumentLayout` pages, regions, tables, boxes, and visual assets. The core validates layout and still enforces corpus normalization, access, trust, chunking, and citations.
- ColPali-style visual retrieval: set `RAG_VISUAL_VECTOR_KIND` and configure `RAG_APP_VISUAL_EMBEDDING_MODE=required` with `RAG_VISUAL_EMBEDDING_*`, or inject a trusted `VisualEmbeddingAdapter`. Text-only chunks are not converted into visual evidence.
- LightRAG-style query split: the built-in planner can emit original, low-level, and high-level planned queries when profile rewriting and parallel queries are enabled. Use a project `QueryPlanner` injection for LLM entity/theme extraction, HyDE, or graph-aware routing.
- Onyx-style ACLs: each answer request must include tenant, namespace, and principal scope. Project connectors that mirror external ACLs should map those permissions into chunk `accessScope` before ingestion; retrieval still filters before candidates reach context.
- R2R-style two-track API: `/answer` is the single-shot path. Agentic multi-step search should be exposed by a project wrapper that calls the runtime repeatedly or injects a controlled planner/orchestrator while preserving the same access and grounding gates.
- Support knowledge flow: export safe support events, run `support:knowledge`, then point production ingestion at the approved source config. Approval alone does not make support knowledge answerable.

## Grounding Judge Mode

The faithfulness judge is optional and configurable:

```text
RAG_APP_GROUNDING_JUDGE_MODE=disabled
RAG_APP_GROUNDING_JUDGE_MODE=auto
RAG_APP_GROUNDING_JUDGE_MODE=required
```

- `disabled`: deterministic citation validation still runs, but no model-backed faithfulness judge is loaded.
- `auto`: the judge is loaded only when complete `RAG_GROUNDING_JUDGE_*` provider config is present.
- `required`: startup/config loading fails unless the judge provider config is complete.

Configure the provider when using `auto` or `required`:

```text
RAG_GROUNDING_JUDGE_PROVIDER=json-grounding-judge
RAG_GROUNDING_JUDGE_MODEL_NAME=judge-model
RAG_GROUNDING_JUDGE_ENDPOINT=https://provider.example.test/v1/judge
RAG_GROUNDING_JUDGE_API_KEY_ENV=GROUNDING_JUDGE_MODEL_KEY
GROUNDING_JUDGE_MODEL_KEY=replace_me
```

Use `required` for production workflows where answer wording has legal, financial, support, or compliance risk. The judge can only downgrade a valid draft to `validation_failed` or `human_review_required`; it cannot make an invalid draft valid.

## Production Notes

- Terminate TLS at a trusted reverse proxy or load balancer.
- Keep HTTP bearer auth and rate limiting enabled for `/answer`.
- Route production traffic using `/ready`; use `/health` only for process liveness.
- Put real secrets in your deployment secret manager, not in `.env.example`.
- Keep `/data` on encrypted persistent storage when using durable JSON stores.
- Run `npm run deployment:check` and `npm run ci` before publishing an image.
