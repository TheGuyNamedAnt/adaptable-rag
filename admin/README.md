# Adaptable RAG Admin

Optional Next.js admin console for operating and inspecting an Adaptable RAG deployment.

The UI intentionally shows redacted operational data only: ids, hashes, statuses, counts,
safe warning codes, safe errors, provider names, and citation pointers. It does not expose
raw source bodies, prompts, retrieved context, credentials, bearer tokens, or full principal
claims.

## Run

From the repo root, start the whole local admin stack:

```bash
npm --prefix admin install
npm run admin:dev
```

This starts both services:

- RAG HTTP: `http://127.0.0.1:8787`
- Admin UI: `http://127.0.0.1:8788`

If the RAG HTTP service is already managed elsewhere, keep it external:

```bash
npm run admin:dev -- --external-rag
```

Open `http://127.0.0.1:8788`.

## Configuration

```text
RAG_ADMIN_RAG_BASE_URL=http://127.0.0.1:8787
RAG_ADMIN_RAG_AUTH_TOKEN_ENV=RAG_HTTP_AUTH_TOKEN
RAG_ADMIN_REPO_ROOT=/absolute/path/to/adaptable-rag
RAG_ADMIN_CLI_PATH=/absolute/path/to/adaptable-rag/dist/runtime/production-cli.js
RAG_ADMIN_TRACE_HISTORY_KIND=auto
RAG_ADMIN_TRACE_POSTGRES_URL_ENV=RAG_DATABASE_URL
RAG_ADMIN_TRACE_POSTGRES_SCHEMA=rag_core
RAG_ADMIN_TRACE_HISTORY_DIR=/absolute/path/to/adaptable-rag/.rag/admin-traces
RAG_ADMIN_TIMEOUT_MS=12000
```

The overview page uses `RAG_ADMIN_RAG_BASE_URL` to call `/health`, `/ready`, and
`/metrics`. Answer Lab proxies to `/answer`; when HTTP auth is enabled, point
`RAG_ADMIN_RAG_AUTH_TOKEN_ENV` at the server-side env variable containing the bearer token.
Successful Answer Lab runs append redacted durable trace artifacts. In production, set
`RAG_ADMIN_TRACE_HISTORY_KIND=postgres`, point `RAG_ADMIN_TRACE_POSTGRES_URL_ENV` at the
database secret env, and apply `deploy/postgres/004_admin_trace_history.sql`. Local dev can
use the JSONL fallback at `RAG_ADMIN_TRACE_HISTORY_DIR`. Generated answer text and evidence
summary text are not persisted in either store.
Ingestion and source-health pages use the compiled production CLI, so run `npm run build`
in the repo root first when using `npm run admin:dev:ui` directly. The normal
`npm run admin:dev` stack command builds the core before it starts services.

## Current Screens

- Overview: runtime status, profile/namespace, storage posture, providers, HTTP counters,
  and recent ingestion jobs.
- Ingestion: job list with status/stage filters and safe count summaries.
- Ingestion detail: source progress, checkpoints, document statuses, chunk counts, and
  failure stage/phase.
- Sources: per-source health for a selected ingestion job.
- Answer Lab: scoped tenant/namespace/principal answer requests.
- Retrieval Trace: durable answer run history, adaptive retrieval strategy, context metrics,
  and event timeline.
- Citation Inspector: final citation pointers, source ids, chunk ids, page/locator metadata,
  and safe citation IDs.
- Rejected Evidence: rejected chunk ids, rejection codes, and exact rejection stage when present
  in safe trace events.

## Next Screens

- Graph
- Evals
- Replay/SLO/Incident pages
- Profiles, Connectors, Storage, Providers, and guarded Admin Ops actions
