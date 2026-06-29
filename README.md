# Adaptable RAG

Configurable, profile-driven RAG core for apps that need provenance, access boundaries,
grounded answers, evals, and production checks.

Adaptable RAG is intentionally not a chatbot demo. It is a reusable engine for building
domain-specific RAG systems where each project brings its own data sources, parsers,
providers, and deployment policy while the core owns safety, citations, traces, and
runtime validation.

## Quick Start

```bash
nvm use
npm ci
npm run check
npm run test
```

Run the admin console. This starts the local RAG HTTP service on `8787` and the
admin UI on `8788` together:

```bash
npm --prefix admin install
npm run admin:dev
```

If you intentionally want only the UI because the RAG HTTP service is already running
elsewhere, use:

```bash
npm run admin:dev -- --external-rag
```

The admin console is a redacted operational UI for `/health`, `/ready`, `/metrics`,
Postgres-backed ingestion jobs, source health, Answer Lab, durable trace history,
citations, rejected evidence, graph import and benchmark reports, parser/document-QA
benchmarks, parser quality, ingestion integrity, provider smoke, embedding migration,
and vector cleanup artifacts. It lives in `admin/` so the core RAG package stays
portable.

## What It Provides

- Profile contracts for domain policy, retrieval behavior, citations, refusal rules, and eval metadata.
- Corpus, parser, source-sync, support-event, and company-connector adapter boundaries.
- Document, chunk, provenance, trust, freshness, layout, and ACL validation before indexing.
- Keyword, vector, hybrid, visual-vector, and knowledge-map retrieval paths.
- Grounded answer orchestration with citation checks, budget checks, safe traces, and optional model-backed judges.
- Provider presets for model, embedding, visual embedding, reranking, grounding judge, and hosted vector stores.
- Plug-and-play adapter and vector-store contracts for safe provider, chunker, and vector DB swaps.
- Production CLI and HTTP entrypoints with config loading, auth, rate limits, health, readiness, metrics, and self-tests.
- Operational gates for CI, evals, trace replay, SLO checks, alert dry-runs, incident bundles, and human review exports.

## Core Boundary

For the component-swap contracts and 10M-chunk readiness model, see
[Plug-and-Play RAG Architecture](docs/rag-plug-and-play-architecture.md).

For snapshot-backed stores, old vector generations can be inspected with:

```bash
node scripts/run-vector-generation-cleanup.mjs \
  --snapshot .rag/vectors.json \
  --keep-config-hashes <current-embedding-config-hash> \
  --output .rag/vector-cleanup/plan.json
```

Profiles can configure behavior, but the core enforces the non-negotiable parts:

- provenance is required
- access scope is required
- retrieved evidence must remain citable
- missing evidence causes refusal instead of fabrication
- namespace isolation cannot be disabled by a profile
- raw source text, prompts, credentials, and principal claims stay out of safe traces

## Minimal API Shape

The public package exports `createRag()` for local assembly and production helpers for
CLI/HTTP deployment. A typical app wires a profile, corpus adapter, index, retriever,
and model adapter, then calls the answer API.

```ts
import { createRag, genericDocsProfile } from "adaptable-rag";

const rag = createRag({
  profile: genericDocsProfile
  // provide project adapters, stores, retrievers, and model/provider config
});

const result = await rag.answer({
  question: "What does the policy say?",
  principal: {
    tenantId: "tenant_1",
    userId: "user_1",
    namespaceIds: ["generic-docs"],
    roles: ["reader"]
  }
});
```

For runnable examples, start with the local profile preset above or the company connector
template in `templates/company-connector-pack/`.

## Repository Map

```text
src/profiles/      Profile contracts, validation, registry, and presets
src/corpus/        Corpus adapter SDK, local files, database, SaaS, and approved knowledge inputs
src/parsing/       Parser adapter contracts for text, layout, tables, and visual assets
src/ingestion/     Adapter -> normalize -> chunk -> index pipeline
src/indexing/      Document/chunk stores plus keyword, vector, visual, and graph boundaries
src/retrieval/     Keyword, vector, hybrid, visual, graph, and reranking retrieval
src/context/       Safe citable context construction
src/answer/        Grounding gate and answer validation
src/model/         Provider-neutral model and grounding judge adapters
src/runtime/       Production app, CLI, HTTP server, sync, ingest, and runtime assembly
src/evals/         Eval runner, reports, replay, SLOs, incidents, and review queues
admin/             Optional Next.js admin console for redacted operations inspection
templates/         Copyable project/company integration skeletons
deploy/            Docker, env, provider, Postgres, and production runbooks
docs/              Longer architecture and reference documentation
```

## Common Commands

```bash
npm run check            # TypeScript
npm run lint             # ESLint
npm run format:check     # Prettier check
npm run test             # Build and run tests
npm run test:coverage    # Coverage-gated tests
npm run admin:dev        # Run local RAG HTTP service on 8787 plus admin UI on 8788
npm run admin:dev:ui     # Run only the admin UI
npm run admin:smoke      # Start both services, verify readiness, then stop
npm run admin:start      # Production-start RAG HTTP plus admin UI
npm run admin:check      # Type-check the admin console
npm run admin:build      # Production-build the admin console
npm run smoke:providers  # Provider probe report for the admin Quality Ops page
npm run graph:benchmark  # Graph store benchmark report for the admin Graph page
npm run evals            # Profile evals and regression report
npm run ci               # Full local quality gate used by GitHub Actions
```

Company deployment checks:

```bash
npm run company:validate
npm run company:smoke
npm run company:smoke:postgres
node dist/runtime/production-cli.js inspect-ingestion-jobs --limit 20
node dist/runtime/production-cli.js inspect-ingestion-job --job-id company_sync_20260624 --document-status failed
node dist/runtime/production-cli.js inspect-eval-failure --summary .rag/eval-runs/latest/summary.json
```

## Documentation

- [Docs index](docs/README.md)
- [Full reference](docs/full-reference.md)
- [Parser and document QA benchmarks](docs/parser-benchmarks.md)
- [Deployment guide](deploy/README.md)
- [Company production runbook](deploy/company-production-runbook.md)
- [Company connector template](templates/company-connector-pack/)

## Status

The repository is public, but the package is still marked `"private": true` in
`package.json`; it is published as source code, not as an npm package.

## License

No license is granted. All rights are reserved unless a license is added later.
