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

Run the local HTTP service with the generic docs profile:

```bash
npm run build
RAG_APP_PROFILE_PRESET=generic-docs RAG_HTTP_AUTH_MODE=disabled npm run serve
```

## What It Provides

- Profile contracts for domain policy, retrieval behavior, citations, refusal rules, and eval metadata.
- Corpus, parser, source-sync, support-event, and company-connector adapter boundaries.
- Document, chunk, provenance, trust, freshness, layout, and ACL validation before indexing.
- Keyword, vector, hybrid, visual-vector, and knowledge-map retrieval paths.
- Grounded answer orchestration with citation checks, budget checks, safe traces, and optional model-backed judges.
- Provider presets for model, embedding, visual embedding, reranking, grounding judge, and hosted vector stores.
- Production CLI and HTTP entrypoints with config loading, auth, rate limits, health, readiness, metrics, and self-tests.
- Operational gates for CI, evals, trace replay, SLO checks, alert dry-runs, incident bundles, and human review exports.

## Core Boundary

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
npm run evals            # Profile evals and regression report
npm run ci               # Full local quality gate used by GitHub Actions
```

Company deployment checks:

```bash
npm run company:validate
npm run company:smoke
npm run company:smoke:postgres
```

## Documentation

- [Docs index](docs/README.md)
- [Full reference](docs/full-reference.md)
- [Deployment guide](deploy/README.md)
- [Company production runbook](deploy/company-production-runbook.md)
- [Company connector template](templates/company-connector-pack/)

## Status

The repository is public, but the package is still marked `"private": true` in
`package.json`; it is published as source code, not as an npm package.

## License

No license is granted. All rights are reserved unless a license is added later.
