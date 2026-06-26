# Adaptable RAG

Configurable RAG core for many use cases. The core owns safety, provenance, traceability, citations, and evaluation. Profiles configure domain behavior, allowed sources, output contracts, and escalation/refusal policy.

## License

No license is granted. All rights are reserved unless a license is added later.

## Quick Start

```bash
nvm use
npm ci
npm run check
npm run test
```

Use the generic docs profile for a local first pass:

```bash
npm run build
RAG_APP_PROFILE_PRESET=generic-docs RAG_HTTP_AUTH_MODE=disabled npm run serve
```

Production-oriented drills start from `.env.example`, `deploy/README.md`, and the company deployment runbook in `deploy/company-production-runbook.md`.

## Current Slice

Working in these parts of the system:

```text
0. System Contract
1. Profile Layer
2. Corpus Adapter Layer
3. Document Model + Provenance Layer
4. Index Layer
5. Retrieval Layer
6. Context Builder Layer
7. Answer Layer / Grounding Gate
8. Model Adapter + Generation Orchestrator
9. Real Provider Adapter Boundary
10A. Architecture + Profile Hardening
10. Security + Access Control Layer
10C. Observability Runtime
10D. Profile Runtime Enforcement
10E. Corpus Hardening
10F. Chunking Hardening
10G. Index/Retrieval Hardening
10H. Access/Observability Hardening
10I. Code Quality/CI Hardening
10J. Eval Harness
10K. Real File-Loading Corpus Adapter
10L. Embeddings + Vector Foundation
10M. Hybrid Retrieval
10N. Durable Vector Store + Provider Boundary
10O. Provider Presets + Runtime Assembly
10P. Live Runtime Config + Fetch Transport
10Q. Provider Compatibility Presets
10R. Hosted Vector Store Adapter Boundary
10S. Reranker + Model-Backed Grounding Judge
10T. Rerank/Judge Provider Presets + Live Wiring
10U. Database/SaaS Corpus Adapters
10V. Hosted Vector Vendor Transports
10W. Production Entrypoints + Config/Secrets
10X. Deployment Packaging
10Y. Production Edge Hardening
10Z. Production Operations Layer
11A. Production Ingestion Entrypoint
11B. Project Adapter Extension Boundary
11C. Project Adapter SDK + Contract Tests
12A. Query Planner Layer
12B. RRF Hybrid + Planned-Query Fusion
13A. Layout-Aware Document Model + Parser Adapter Boundary
13B. Parser-Backed Local File Ingestion
13C. Visual Multi-Vector Retrieval Boundary
13D. Visual Ingestion + Durable Visual Store
13E. Visual Provider Adapter Boundary
13F. Provider Startup Self-Test
13G. Hosted Visual Vector Store Boundary
13H. Visual Retrieval Eval Gate + Hosted Visual Failure Drills
14. Eval Reporting + Regression Benchmarking
15. Provider Smoke Packs + Deployment Drills
16. Trace Replay + Incident Forensics
17. Production SLOs + Alerting Rules
18. Alert Delivery Adapters
19. Incident Bundle + Postmortem Export
20. Human Review + Escalation Queue Boundary
21. Review Decision Ledger + Feedback Loop
22. External Review/Ticket Sync Adapter Boundary
23. External Ticket Status Reconciliation + Idempotency Store
24. Support Knowledge Flow + Approved Ingestion Handoff
25. Project Support Event Export Boundary
26. End-to-End Support Operator Drill
27. Project Support Connector Template
11. Observability Layer
```

The current slice includes the contracts, safety core, durable local stores, generic corpus adapters, source connector sync contracts, sync ledgers, sync runners, project adapter SDK contract tests, production ingestion entrypoint, project adapter extension boundary, parser/layout adapter boundary, parser-backed local file ingestion, layout-aware citations, visual multi-vector retrieval, visual ingestion, durable and hosted visual vector storage, visual provider adapter boundary, visual retrieval eval gates, hosted visual failure drills, eval reporting, provider smoke drills, trace replay, incident forensics, SLO alerting, alert delivery adapters, incident bundle/postmortem export, human review queue export, review decision ledger export, external review ticket sync export, external ticket status reconciliation, support event export validation, support knowledge approved-ingestion handoff, support operator drill, project support connector template, query planning, HyDE query expansion, retrieval budget/fusion optimization, structured knowledge-map retrieval, bounded multi-hop relationship traversal, relationship-path evidence, RRF fusion, generic provider presets, a bundled fetch transport, hosted vector-store boundary, hosted vector vendor transport presets, provider-backed reranker and grounding-judge presets, production CLI/HTTP entrypoints, edge auth/rate limiting, operations endpoints/logs/metrics, Docker/Compose packaging, startup self-tests, and runtime assembly helpers that every project-specific parser, provider, external vector store, visual embedding store, reranker, and production deployment must follow.

## Skeleton

```text
src/
  profiles/
    profile.ts                 Profile-level behavior and policy contract
    profile-enforcement.ts     Field-by-field enforced/declarative matrix
    profile-validation.ts      Production guardrails for profile safety
    profile-registry.ts        Startup-time registry that rejects invalid profiles
    examples/
      generic-docs.profile.ts   Minimal reusable profile example
      sample-support.profile.ts
    presets/
      ultimate-default.profile.ts Strict production baseline profile
  corpus/
    adapter.ts                 Interface every corpus adapter must implement
    adapter-registry.ts        Runtime registry for approved corpus adapters
    adapter-contract.ts        SDK test harness for project adapter authors
    corpus-record.ts           Raw-but-normalized records from adapters
    local-files-adapter.ts     Safe local filesystem adapter for project docs
    approved-knowledge-artifact-adapter.ts Human-approved support/review ledger adapter
    structured-record-mapper.ts Shared row/API object to CorpusRecord mapper
    database-corpus-adapter.ts Named-query database row corpus adapter
    saas-corpus-adapter.ts     Paginated SaaS/API object corpus adapter
    normalize.ts               Internal safety gate from CorpusRecord to RagDocument
  sync/
    source-connector.ts        Generic source sync connector contract for upserts/deletes/errors
    sync-ledger.ts             Safe source item ledger, cursor, tombstone, and retry-state contracts
    sync-runner.ts             Compares connector output to previous ledger and emits changed records
  parsing/
    parser.ts                  Project parser adapter contract for text/binary documents
    parser-contract.ts         SDK test harness for parser adapter authors
  ingestion/
    ingest-pipeline.ts         App-facing corpus path: adapter -> normalize -> chunk -> index
  chunking/
    chunk-policy.ts            Chunk size, overlap, locator, and safety policy
    chunker.ts                 Validates chunk policy and converts RagDocument into citable RagChunk objects
    chunk-validation.ts        Validates chunk provenance, exact source range, citation, and hash
    hash.ts                    Stable text hash helper
  shared/
    engine-capabilities.ts     Implemented engine capabilities used for profile honesty
    hash.ts                    Cross-layer stable SHA-256 text hash helper
    stable-hash.ts             Stable object hashing for redacted audit correlation
    provider-boundary.ts       Shared provider HTTP, retry, auth, redaction, and trace primitives
    fetch-provider-transport.ts Fetch-backed ProviderTransport for live HTTP calls
    provider-runtime-config.ts Env/config loader for provider config, secrets, and dimensions
  indexing/
    document-store.ts          Store interface for validated documents
    chunk-store.ts             Store interface for validated chunks
    vector-store.ts            Access-filtered vector storage/search contract and in-memory implementation
    visual-vector-store.ts     Access-filtered multi-vector visual storage/search with late-interaction scoring
    json-file-vector-store.ts  Durable local vector snapshot implementation
    json-file-visual-vector-store.ts Durable local visual-vector snapshot implementation
    hosted-vector-store.ts     Generic async hosted vector-store adapter boundary
    hosted-visual-vector-store.ts Hosted patch-vector visual store with local MaxSim/access checks
    hosted-vector-vendor-transports.ts Pinecone, Qdrant, Weaviate, and pgvector RPC transport presets
    index-types.ts             Shared index filters, stats, and operation results
    index-filter.ts            Deny-by-default read filter validation
    index-validation.ts        Validates documents/chunks before indexing
    in-memory-index.ts         In-memory implementation for local/test use
    json-file-index.ts         Durable local JSON snapshot implementation
  graph/
    graph-store.ts             Knowledge-map internals: entity/relation storage plus KV summaries
    hosted-graph-store.ts      Vendor-neutral hosted knowledge-map adapter with local access checks
    hosted-graph-transport-contract.ts Reusable contract suite for project-owned hosted knowledge-map transports
  query/
    query-types.ts             Query planner contract, planned-query trace, and policy shape
    default-query-planner.ts   Heuristic low-level/high-level planner inspired by LightRAG
    model-assisted-query-planner.ts Optional model-assisted planner with safe fallback
    hyde-query-planner.ts      HyDE query-expansion wrapper with fail-open/fail-closed modes
  retrieval/
    retrieval-types.ts         Retrieval request, candidate, result, rejection, and redacted trace contracts
    retriever.ts               Generic retriever interface with capability reporting
    keyword-retriever.ts       Safe keyword retriever over indexed chunks
    vector-retriever.ts        Safe vector retriever over embedded chunks
    visual-retriever.ts        Safe visual retriever over layout/asset-anchored multi-vector evidence
    hybrid-retriever.ts        Safe keyword+vector merger with RRF/default fusion and dedupe
    graph-augmented-retriever.ts Knowledge-map evidence wrapper that preserves index access checks
    rrf.ts                     Shared reciprocal-rank-fusion utility for hybrid and planned-query fusion
    reranker.ts                Provider-neutral reranker contract and redacted trace
    lightweight-reranker.ts    Deterministic local reranker for safe default rerankMode
    model-reranker.ts          Model-backed reranker adapter boundary
    provider-rerank-adapter.ts Injectable HTTP rerank provider boundary
    json-rerank-preset.ts      Generic JSON rerank request/response preset
    openai-rerank-preset.ts    OpenAI-compatible rerank preset alias
    anthropic-rerank-preset.ts Anthropic Messages rerank preset
    reranking-retriever.ts     Wrapper that reranks existing retriever candidates
  embeddings/
    embedding-types.ts         Provider-neutral embedding adapter contract
    fake-embedding-adapter.ts  Deterministic local embedding adapter for tests
    visual-embedding-types.ts  Provider-neutral visual multi-vector embedding adapter contract
    fake-visual-embedding-adapter.ts Deterministic local visual adapter for tests
    provider-embedding-adapter.ts Injectable HTTP embedding provider boundary
    indexed-embedding-preset.ts Generic indexed embedding request/response preset
    provider-visual-embedding-adapter.ts Injectable HTTP visual embedding provider boundary
    indexed-visual-embedding-preset.ts Generic indexed visual embedding request/response preset
    embedding-indexer.ts       Embeds accepted chunks into a vector store
    visual-embedding-indexer.ts Embeds parser/layout visual assets into a visual vector store
  context/
    context-types.ts           Context block, rejection, evidence summary, and trace contracts
    context-builder.ts         Turns retrieval candidates into safe citable generation context
  answer/
    answer-types.ts            Answer gate, generation contract, draft, validation, and trace contracts
    grounding-gate.ts          Decides whether generation is allowed and validates sourced drafts
    grounding-judge.ts         Model-backed grounding judge adapter boundary
  model/
    model-types.ts             Provider-neutral model adapter, usage, cost, and result contracts
    fake-model-adapter.ts      Deterministic local adapter for tests and offline development
    provider-types.ts          Real-provider HTTP boundary, retry, pricing, and error contracts
    provider-model-adapter.ts  Injectable provider adapter with auth, retry, redaction, and parsing
    json-chat-model-preset.ts  Generic JSON chat request/response preset
    provider-grounding-judge-adapter.ts Injectable HTTP grounding judge provider boundary
    json-grounding-judge-preset.ts      Generic JSON grounding judge preset
    openai-grounding-judge-preset.ts    OpenAI-compatible grounding judge preset alias
    anthropic-grounding-judge-preset.ts Anthropic Messages grounding judge preset
  generation/
    generation-types.ts        End-to-end generation run status, trace, and result contracts
    generation-orchestrator.ts Runs gate -> model adapter -> draft validation -> optional judge
    grounding-judge-factory.ts Creates model-backed grounding judges without runtime importing answer
  budget/
    budget-meter.ts            Reusable retrieval/model/cost/runtime/output budget meter
  runtime/
    alert-webhook-sink.ts       Webhook/Slack/PagerDuty-style SLO alert delivery sink
    runtime-types.ts           Public answer() request/result contract
    retrieval-budget-policy.ts Per-planned-query topK, candidate-pool, fusion-weight, and graph-fanout policy
    rag-answer-runtime.ts      Retrieval -> context -> generation path with one run trace
    rag-agent-runtime.ts       Agentic retry runtime that reuses the safe answer path
    rag-runtime-factory.ts     Validates profile and assembles keyword/vector/hybrid/visual runtime
    live-runtime-config.ts     Builds provider adapters/runtime from env-backed config
    production-app.ts          Startup config, store/provider assembly, safe answer response
    production-ingestion.ts    CLI/runtime ingest path through IngestPipeline and optional text/visual embeddings
    source-delete-propagation.ts Applies source tombstones to documents, chunks, vectors, visuals, and knowledge
    source-sync-workflow.ts   End-to-end connector -> delete propagation -> ingest -> post-index -> ledger coordinator
    production-http-server.ts  /health, /ready, /metrics, and /answer HTTP entrypoint
    production-cli.ts          validate-config, ingest, answer, serve, and graceful shutdown CLI entrypoint
  documents/
    document.ts                 Normalized document contract
    layout.ts                   Page/region/table/visual layout evidence contract
    chunk.ts                    Searchable evidence chunk contract
    provenance.ts               Source lineage contract
    trust-tier.ts               Trust classification contract
  security/
    access-scope.ts             Tenant/namespace/user/team access boundary contract
    access-control.ts           Deny-by-default runtime access evaluator and safe audit helper
  observability/
    trace.ts                    RAG run trace contract
    trace-forensics.ts          Safe trace summarization and replay comparison
    slo.ts                      Generic SLO rule evaluator and redacted alert report renderer
    alert-delivery.ts           Generic SLO alert delivery contracts, dedupe keys, and delivery reports
    review-ticket-sync.ts       Generic review-ticket sync contracts, dedupe keys, and reports
    review-ticket-reconciliation.ts External-ticket status reconciliation and idempotency store
  support-bridge/
    support-event.ts            Safe support/admin event contract and idempotency key builder
    idempotency-ledger.ts       Duplicate/conflict ledger for support knowledge events
    support-event-exporter.ts   Project support event exporter contract and validation harness
    project-support-connector.ts Generic source+mapper factory for project-owned support exporters
    knowledge-candidate-queue.ts Human-approval queue for proposed support knowledge changes
    approval-ledger.ts          Approved knowledge artifact ledger for ingestion handoff
    support-knowledge-flow.ts   Event -> candidate -> approval -> approved-source config runner
  evals/
    eval-types.ts               Golden/adversarial eval case and safe summary contracts
    eval-runner.ts              Profile eval execution over runtime assembly
    eval-report.ts              Benchmark snapshots, regression checks, and HTML report rendering
    eval-replay.ts              Safe trace replay and incident comparison reports
    operational-slo.ts          RAG-specific SLO signals and rules over release artifacts
    incident-bundle.ts          Redacted incident bundle and Markdown postmortem export
    human-review-queue.ts       Redacted human review and escalation queue export
    review-decision-ledger.ts   Hashed reviewer decisions and safe feedback signals
    review-ticket-export.ts     Converts queue/ledger evidence into safe ticket payloads
  runtime/
    support-operator-drill.ts Optional export -> approval -> production-ingestion drill
    review-ticket-webhook-sink.ts Optional live webhook sink for review ticket sync
  architecture.test.ts          Enforces the acyclic source-layer DAG
  index.ts                      Public exports
scripts/
  run-tests-with-guard.mjs      Discovers compiled tests, blocks zero-test passes, enforces coverage floors
  run-evals.mjs                 Runs profile-declared golden/adversarial evals
  run-slo-check.mjs             Converts eval/replay/smoke/metrics artifacts into SLO alerts
  deliver-alerts.mjs            Dry-runs or sends SLO alerts to configured delivery sinks
  build-incident-bundle.mjs     Builds redacted incident.json and postmortem.md from release evidence
  build-review-queue.mjs        Builds redacted human-review queue artifacts from eval/incident evidence
  build-review-ledger.mjs       Builds review decision ledger and feedback artifacts
  sync-review-tickets.mjs       Dry-runs or sends external review-ticket sync payloads
  reconcile-review-tickets.mjs  Builds review-ticket idempotency store and reconciliation report
  validate-support-event-export.mjs Validates project-exported support events before promotion
  run-support-knowledge-flow.mjs Builds support knowledge approval and ingestion handoff artifacts
  run-support-operator-drill.mjs Builds the end-to-end support operator drill report
  run-excel-visual-retrieval-smoke.mjs Checks parser-emitted spreadsheet visuals through visual retrieval
  validate-deployment-assets.mjs Validates Docker, Compose, env, and deployment docs
templates/
  project-support-connector/    Copyable project-owned support exporter skeleton
  company-connector-pack/        Copyable company adapter/source connector pack skeleton
deploy/
  README.md                     Docker startup, secrets, hosted vector, and production notes
.github/workflows/
  ci.yml                        GitHub Actions quality gate
Dockerfile                      Multi-stage production image for the HTTP service
docker-compose.yml              Local production wiring with durable /data volume
.dockerignore                   Keeps local build outputs and env files out of Docker context
.env.example                    Runtime env template with placeholder secrets
eslint.config.js                ESLint configuration
.prettierrc.json                Prettier configuration
.nvmrc / .node-version          Pinned Node major for CI and local tool managers
```

## Design Rule

Profiles can configure behavior, but core code should enforce non-negotiable safety checks:

- provenance is required
- access scope is required
- retrieved evidence must remain citable
- traces must be written for every run
- namespace isolation cannot be disabled by a profile
- untrusted sources cannot silently become trusted

## Production Profile Boundary

Profiles can configure:

- model tier policy by role
- which corpus sources are enabled
- per-source trust floors and optional trust downgrades
- retrieval mode, query rewriting, reranking, and chunk budget
- visual retrieval mode when a visual embedding adapter and visual vector store are configured
- context token/chunk budget
- freshness/versioning behavior
- source preferences
- output mode and structured output contract
- citation rules
- redaction/privacy behavior
- refusal copy
- action permissions
- cost and latency budgets
- security posture
- observability detail
- memory behavior
- escalation rules
- golden and adversarial eval paths

Profiles cannot disable:

- citation requirements
- refusal when evidence is missing
- refusal or escalation when only untrusted evidence exists
- required golden/adversarial eval checks
- access scope/provenance requirements on documents and chunks
- startup validation
- retrieved-text isolation
- raw vector protection
- trace redaction
- layout geometry and parser diagnostics validation

The strict baseline is `ultimateDefaultProfile`. Use it as the default preset when plugging the RAG core into a new app, then narrow or specialize it only when the use case requires it.

Raw `RagProfile` objects are declarations only. Runtime request types require `ValidatedRagProfile`, which is returned by `assertValidProfile` or by `ProfileRegistry`. This makes startup validation a compile-time boundary instead of a convention.

`ProfileRegistry` stores only validated profiles. `ContextBuilder`, `GroundingGate`, `GenerationOrchestrator`, and corpus normalization cannot receive raw profiles.

Profile validation only allows retrieval modes implemented by `RAG_ENGINE_CAPABILITIES`. `keyword`, `vector`, and `hybrid` are implemented. Profiles cannot advertise a retrieval capability the engine cannot serve.

## Advanced RAG Capability Map

The repo carries the production contracts for the seven advanced capabilities below. Some are complete runtime features; others are extension boundaries that need a project parser, provider, connector, or agent wrapper before they are full product features.

| Capability                                   | Current state                                                | What is active now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What a project must add                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAGFlow/DeepDoc-style parsing                | Boundary implemented                                         | `DocumentParser`, `DocumentLayout`, layout validation, table/region/box/visual-asset/relation contracts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | OCR, document-layout-recognition, and table-structure-recognition parser adapters                                                                     |
| ColPali-style visual retrieval               | Provider preset and stores implemented                       | visual embedding contracts, ColPali-style provider preset, relation-expanded visual inputs, visual vector stores, hosted visual fanout, visual retriever, local MaxSim/access checks                                                                                                                                                                                                                                                                                                                                                                                                                                        | a trusted ColPali/PaliGemma-compatible endpoint and parser-emitted visual assets                                                                      |
| LightRAG-style query/knowledge-map retrieval | Durable knowledge-map slice plus hosted boundary implemented | low/high query planning, model-assisted planner boundary, HyDE query-expansion wrapper, retrieval budget/fusion policy, per-branch candidate caps, structured relationship intent, request-scoped entity hints/relation kinds/direction/execution mode, knowledge-map ingestion, proposal approval/resolution, JSON and SQLite knowledge-map stores, hosted store adapter boundary, hosted transport contract tests, cursor pagination, batched import/checkpoints, store benchmark reports, access-filtered bounded relationship traversal, and relationship-path evidence attached to retrieved candidates/context blocks | a configured HyDE generator/model provider, a project-specific hosted knowledge-map transport/cluster deployment, and project-specific SLO thresholds |
| Onyx-style ACL enforcement                   | Core enforcement implemented                                 | tenant, namespace, principal, team, role, tag, access-tag, and index-filter checks before retrieval/context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | source-system permission mirroring from Drive, Slack, Notion, Confluence, Jira, etc.                                                                  |
| R2R-style two-track API                      | Core two-track runtime implemented                           | `RagAnswerRuntime` for single-shot RAG; `RagAgentRuntime` for retry-after-thin-evidence agent runs through the same safety gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | production HTTP/SDK endpoint split and richer tool-calling retrieve/reflect policies                                                                  |
| Faithfulness judge                           | Optional configurable runtime feature                        | deterministic citation validation always runs; model-backed grounding judge can be loaded from env or injected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | set `RAG_APP_GROUNDING_JUDGE_MODE=auto` or `required` and provide `RAG_GROUNDING_JUDGE_*` provider config                                             |
| Support connector framework                  | Shipped for support/admin evidence                           | exported connector factory, copyable template, contract tests, safe events, candidate queue, approval ledger, approved-source config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | project-specific record loaders and source-specific connector packages                                                                                |

Use this map as the implementation boundary: the core owns safety, validation, traces, and runtime assembly; projects own heavyweight parsers, visual models, enterprise connectors, and agent policies.

## Parser + Layout Boundary

Parser adapters are the plug point for production document intelligence systems.

They can be simple text extractors, RAGFlow/DeepDoc-style OCR and layout parsers, Docling-style PDF parsers, or ColPali-style visual-page preprocessors. They do not decide whether parsed material is trusted or indexable.

`DocumentParser` returns:

- normalized text body
- optional `DocumentLayout`
- parser warnings with redacted diagnostics

`DocumentLayout` can describe:

- pages with dimensions and coordinate units
- text/title/paragraph/header/footer/reference/equation regions
- table regions, captions, cells, and table summaries
- figure/page/table-crop/patch-grid visual assets
- layout relations such as `caption_for`, `explains`, `continues_as`, `references`, and `same_section`
- character ranges that must match the normalized text exactly
- page boxes for citation and future visual retrieval

The layout validator rejects:

- missing parser ids or pages
- duplicate page numbers or layout ids
- invalid region kinds, page references, parent/child references, or confidence scores
- boxes outside their page or normalized 0..1 bounds
- table references that do not point at table/table-caption regions
- visual assets with missing media types or invalid pages
- any region text that does not equal `body.slice(characterStart, characterEnd)`

Parser authors should run `assertDocumentParserContract()` in their own tests:

```ts
await assertDocumentParserContract({
  parser: projectPdfParser,
  request: {
    sourceId: "uploaded_policy_pdf",
    sourceKind: "uploaded_file",
    title: "Policy PDF",
    contentType: "application/pdf",
    bytes,
    requestedAt: "2026-06-24T00:00:00.000Z"
  },
  expectations: {
    requireLayout: true
  }
});
```

The contract checks parser id/description, input mode, max bytes, source id, parser id, non-empty body, required layout, capability honesty, warning shape, warning redaction, and layout validity.

### Best Combined Local Parser

The package includes an opt-in local parser router for the common open-source RAG parsing stack:

| File shape                 | Default local route                                |
| -------------------------- | -------------------------------------------------- |
| `.csv`, `.tsv`             | deterministic delimited-table parser               |
| `.xlsx`, `.xlsm`           | OpenPyXL command wrapper                           |
| plain text / JSON / YAML   | plain text parser                                  |
| PDF / DOCX / PPTX / images | Docling first, then PaddleOCR/MinerU command slots |

This is intentionally a router, not a single parser. Structured spreadsheets stay on exact cell parsers; visual/layout-heavy documents go to document-AI parsers. Owners can swap any command parser without changing ingestion or chunking contracts.

```ts
import { createBestCombinedLocalParserRouter } from "adaptable-rag";

const parser = createBestCombinedLocalParserRouter({
  parserId: "best-local-parser"
});
```

The built-in command wrappers are local/free by default:

- `scripts/openpyxl-rag-parser.mjs` calls `scripts/openpyxl_rag_parser.py`
- `scripts/docling-rag-parser.mjs` calls `scripts/docling_rag_parser.py`

Use project-owned Python environments:

```bash
python3 -m venv .rag/docling-venv
.rag/docling-venv/bin/python -m pip install docling openpyxl

export RAG_DOCLING_PYTHON=.rag/docling-venv/bin/python
export RAG_OPENPYXL_PYTHON=.rag/docling-venv/bin/python
```

Docling OCR is off by default for born-digital PDFs. Enable it only when the local OCR stack is configured for scanned documents:

```bash
export RAG_DOCLING_OCR=true
```

This boundary is intentionally separate from corpus adapters:

- parser adapters turn raw files into normalized text/layout
- corpus adapters turn trusted project sources into `CorpusRecord`
- corpus normalization enforces provenance, access scope, freshness, checksum, trust floor, and layout validity
- chunking copies overlapping layout region ids and bounding boxes into chunk citations
- chunking expands validated layout relations so captions, figures, tables, continuations, and explanations can carry related cross-page region evidence into visual indexing

## Profile Runtime Enforcement

Every profile field must be either enforced by validation/runtime code or explicitly listed as declarative/future-facing.

The enforcement matrix is `PROFILE_FIELD_ENFORCEMENT` in `profiles/profile-enforcement.ts`. Tests walk the concrete example and preset profiles and fail if a profile leaf field is missing from that matrix.

Runtime enforcement added in this slice:

- `freshnessPolicy.requireCapturedAt` rejects candidates missing required capturedAt before context
- `freshnessPolicy.maxSourceAgeDays` rejects stale candidate chunks before context
- `securityPolicy.treatRetrievedTextAsUntrustedInstructions` drives source rendering and grounding rules
- `securityPolicy.isolateRetrievedSources` drives source boundary rendering and grounding rules
- `costLatencyBudget.maxRetrievalCalls` is checked before runtime retrieval
- `costLatencyBudget.maxModelCalls`, `maxRuntimeMs`, and `maxEstimatedCostUsd` are checked by `BudgetMeter`
- output token budget checks also go through `BudgetMeter`
- `retrieval.allowQueryRewrite` controls whether the runtime may add low-level/high-level/HyDE planned queries
- `retrieval.allowParallelQueries` controls whether one answer run may execute multiple planned retrieval queries

Declarative fields remain visible in the matrix with an owner and reason, such as future source-tag routing, fallback provider routing, and future memory persistence.

## Architecture Boundary

Production source files must follow the layer DAG enforced by `architecture.test.ts`.

The current DAG allows lower-level contracts to flow upward, but prevents high-level runtime layers from being imported by lower-level storage, retrieval, corpus, profile, or document layers. The test excludes test files and the public export barrel.

## Code Quality / CI Boundary

The package quality gate is intentionally local-first and CI-ready.

The code-quality gate enforces:

- Node is pinned to the Node 24 line for CI and tool managers
- `npm test` builds first, discovers compiled `dist/**/*.test.js` files itself, and fails if zero tests are found
- `npm run test:coverage` uses Node's test coverage output and enforces all-files floors: 80% lines, 75% branches, 85% functions
- `npm run lint` runs ESLint over TypeScript and local scripts
- `npm run format:check` runs Prettier in check mode
- `npm run ci` runs typecheck, lint, format check, deployment asset validation, company deployment validation, company deployment smoke, coverage-gated tests, eval regression, eval trace replay, SLO alert checks, alert-delivery dry-run, incident bundle export, human review queue export, review decision ledger export, review ticket sync dry-run, review ticket reconciliation, and `npm audit --audit-level=moderate`
- `npm run evals` builds and runs every profile's declared golden/adversarial eval files, writes ignored local artifacts to `.rag/eval-runs/latest`, and compares against `profiles/eval-baseline.json`
- `npm run evals:update-baseline` intentionally refreshes `profiles/eval-baseline.json` after accepted eval-set or behavior changes
- `npm run replay:eval` reruns evals and compares current safe traces against `.rag/eval-runs/latest/summary.json`, writing ignored artifacts to `.rag/trace-replay/latest`
- `npm run slo:check` turns eval benchmark, trace replay, optional provider smoke, and optional HTTP metrics artifacts into ignored SLO reports at `.rag/slo/latest`
- `npm run alerts:deliver` dry-runs delivery of `.rag/slo/latest/alerts.json`, writing ignored local artifacts to `.rag/alert-delivery/latest`
- `npm run incident:bundle` turns eval, replay, SLO, and alert-delivery artifacts into ignored incident artifacts at `.rag/incidents/latest`
- `npm run review:queue` turns eval and incident artifacts into ignored human-review queue artifacts at `.rag/human-review/latest`
- `npm run review:ledger` turns optional `.rag/human-review/decisions.jsonl` records into ignored review ledger and feedback artifacts at `.rag/review-ledger/latest`
- `npm run review:sync` turns review queue plus ledger artifacts into ignored external ticket-sync dry-run artifacts at `.rag/review-sync/latest`
- `npm run review:reconcile` turns ticket-sync artifacts plus optional external statuses into an ignored idempotency store at `.rag/review-reconciliation/latest`
- `npm run support:export:validate` validates project-exported support events and optional approval decisions at `.rag/support-export/latest`
- `npm run support:knowledge` turns safe support events plus optional approval decisions into ignored support-knowledge flow artifacts and an approved ingestion source config at `.rag/support-knowledge/latest`
- `npm run support:drill` validates the safe export, builds the support knowledge flow, and writes an operator drill report at `.rag/support-drill/latest`
- `npm run smoke:providers` builds and runs a real-provider deployment smoke pack, writing ignored local artifacts to `.rag/provider-smoke/latest`
- `npm run graph:benchmark` builds a synthetic graph, measures write, lookup, and cursor-page latency for the selected graph store, and writes ignored JSON/Markdown reports to `.rag/graph-benchmark/latest`
- `npm run graph:import -- --batches path/to/graph-batches.jsonl` imports validated graph batches into a selected graph store with stable file-derived import ids, checkpoints, retries, thresholds, and ignored JSON/Markdown reports at `.rag/graph-import/latest`
- eval JSONL can declare `retrievalMode: "visual"` and require visual citations/layout region ids
- eval checks include `layout_relation_recall` and `table_caption_preservation` for cross-page relation and table/caption regressions
- eval JSONL can declare a `knowledgeMap` fixture whose entity/relation evidence resolves through ingested document chunks
- eval checks include `relationship_claim_grounding` with `requiredRelationshipPaths` for cited knowledge-map chain claims
- eval checks include `relationship_claim_not_grounded` with `forbiddenRelationshipPaths` for wrong, uncited, or access-denied knowledge-map chain claims
- eval checks include `extraction_quality` with expected extracted entities/relations, forbidden extracted relations, recall thresholds, and extra-fact limits
- knowledge-map eval fixtures can declare `expectedVisibleEntityIds` and `expectedVisibleRelationIds` to verify ACL-filtered fixture visibility
- GitHub Actions runs `npm ci` and `npm run ci` on pushes, pull requests, and manual dispatch

The current package is git-initialized for normal branch, diff, and future PR workflows.

## Eval Reporting + Regression Boundary

Eval output is a production gate, not only a console message.

The eval runner now produces:

- `summary.json`: full safe run summary with profile, case, trace id, safe trace, status, citation counts, retrieval mode, and failures
- `benchmark.json`: compact regression metrics for pass rate, case count, check coverage, retrieval-mode coverage, and citation counts
- `regression.json`: benchmark comparison result when a baseline is supplied
- `report.html`: local human-readable profile/case report without raw retrieved context text

The checked-in baseline is `profiles/eval-baseline.json`. Normal CI fails if current evals regress below that baseline by default:

- case count cannot decrease
- pass rate cannot decrease
- previously covered eval checks cannot disappear
- visual retrieval coverage cannot decrease
- final and visual citation counts cannot decrease
- existing profiles cannot disappear or lose covered checks

Intentional changes use `npm run evals:update-baseline` after reviewing the generated report.

## Trace Replay + Incident Forensics Boundary

Replay is built around safe traces, not raw prompt capture.

`RagRunTrace` contains run ids, trace ids, profile/namespace ids, question hashes, stage ids, retrieved/rejected chunk ids, citation pointers, safety flags, and event metadata. It does not contain raw user questions, source bodies, rendered context, generated answer text, bearer tokens, API keys, or principal claims.

`npm run replay:eval` loads `.rag/eval-runs/latest/summary.json`, reruns the profile eval suites, and compares baseline cases against current cases. It writes:

- `replay.json`: case-by-case replay comparison, failures, warnings, and trace summaries
- `current-summary.json`: the current safe eval summary used for comparison
- `report.html`: local human-readable incident/replay report

Target one incident by trace id or case id:

```bash
npm run evals
node scripts/run-trace-replay.mjs --eval-summary .rag/eval-runs/latest/summary.json --trace-id eval_trace_case_id --report-dir .rag/trace-replay/latest
node scripts/run-trace-replay.mjs --eval-summary .rag/eval-runs/latest/summary.json --profile-id generic-docs --case-id case_id --report-dir .rag/trace-replay/latest
```

The replay gate fails when a case disappears, pass/fail state changes, status changes, retrieval mode changes, retrieved document ids change, citation counts change, trace event sequence changes, linked run ids break, or safe trace data is missing. This turns incidents into reproducible regression evidence without expanding the data boundary.

## SLO + Alerting Boundary

SLO alerting is the operational gate above evals, trace replay, provider smoke, and HTTP metrics. The generic evaluator lives in `observability/slo.ts`; the RAG-specific signal and rule mapping lives in `evals/operational-slo.ts`.

`npm run slo:check` reads `.rag/eval-runs/latest/benchmark.json` and `.rag/trace-replay/latest/replay.json` by default. It also includes `.rag/provider-smoke/latest/smoke.json` when present, and can include HTTP metrics with `--http-metrics path/to/metrics.json`.

The runner writes:

- `slo.json`: full SLO evaluation report with signals, rule results, and alert counts
- `alerts.json`: redacted alert events for downstream incident tools
- `report.html`: local human-readable SLO report with runbooks

High and critical alerts fail the gate. Warning alerts stay visible but do not fail CI. Alert events include rule id, category, severity, observed value, threshold, and runbook actions. They do not include raw questions, prompts, retrieved context, generated answer text, bearer tokens, API keys, source bodies, or principal claims.

## Alert Delivery Boundary

Alert delivery is separate from SLO evaluation. SLO checks create redacted `SloAlertEvent` records; delivery decides where those records go.

`npm run alerts:deliver` defaults to dry-run mode. It reads `.rag/slo/latest/alerts.json` and writes `.rag/alert-delivery/latest/delivery.json` without sending network requests.

Live delivery uses `scripts/deliver-alerts.mjs`:

```bash
node scripts/deliver-alerts.mjs \
  --alerts .rag/slo/latest/alerts.json \
  --mode live \
  --webhook-url https://alerts.example.test/rag \
  --format generic \
  --webhook-token-env RAG_ALERT_WEBHOOK_TOKEN \
  --report-dir .rag/alert-delivery/latest
```

Supported formats are:

- `generic`: portable JSON webhook payload
- `slack`: Slack incoming-webhook style blocks
- `pagerduty_events_v2`: PagerDuty Events API v2 shape, using `--pagerduty-routing-key-env`

Delivery reports include sink id, mode, status, attempts, dedupe keys, counts, warnings, and redacted errors. They do not include bearer tokens, routing keys, raw questions, prompt text, retrieved context, generated answers, source bodies, or principal claims. Live webhook delivery uses injected provider transport semantics: POST only, timeout, retry on configured retryable statuses, HTTPS except localhost, and secret values redacted from failures.

## Incident Bundle + Postmortem Boundary

The incident bundle is the operational evidence envelope above evals, replay, SLOs, and alert delivery.

`npm run incident:bundle` reads the latest local release evidence and writes:

- `incident.json`: structured status, severity, artifact manifest, metrics, impacted profiles, runbooks, findings, recommended actions, and safe trace summaries
- `postmortem.md`: Markdown incident/postmortem starter with executive summary, impact, detection, findings, runbooks, safe trace evidence, immediate actions, follow-ups, and evidence boundary

The bundle is useful even when everything is healthy because it creates one linked audit artifact for a release gate. On failure, it gives the incident owner the exact reports to inspect without copying unsafe data into chat, tickets, or docs.

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

Incident artifacts include paths, ids, statuses, counts, failures, warnings, SLO runbooks, and safe trace summaries. They do not include raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, or full principal claims.

## Human Review + Escalation Queue Boundary

Human review is the handoff layer above review-required answers, failed runs, eval findings, and incidents.

`npm run review:queue` reads the latest eval summary and incident bundle, then writes:

- `queue.json`: structured queue with item ids, priorities, SLA due times, profile ids, namespace ids, trace ids, destinations, reason codes, artifact paths, and safe trace summaries
- `queue.md`: Markdown triage view for operators or project-specific ticket sync jobs

The queue includes:

- eval cases that return `human_review_required`
- failed eval cases even when the runtime status is not itself a failure
- live `RagAnswerResult` objects supplied by a project wrapper
- non-healthy incident bundles
- refusals only when `includeRefusals` is enabled, so expected unsupported-question refusals do not flood the queue by default

Profile `escalationRules` are now active queue routing metadata. Their ids, descriptions, trigger text, and destinations are copied onto profile-scoped queue items so a project can sync them to support, security, billing, or incident tooling without parsing prompts or answers.

```bash
npm run review:queue
node scripts/build-review-queue.mjs \
  --eval-summary .rag/eval-runs/latest/summary.json \
  --incident .rag/incidents/latest/incident.json \
  --report-dir .rag/human-review/latest
```

Open review items do not fail CI by themselves. They are operational work items: humans approve, revise, reject, route, or file follow-up issues based on the linked safe evidence. The queue does not include raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, or full principal claims.

## Review Decision Ledger + Feedback Loop

The review decision ledger is the audit layer above the human queue.

`npm run review:ledger` reads the latest queue and optional reviewer decisions, then writes:

- `ledger.json`: structured decisions with queue item links, action/status, hashed reviewer ids, safe summaries, reason codes, follow-up actions, and source artifact paths
- `feedback.json`: safe feedback signals for eval candidates, profile policy updates, corpus updates, incident follow-ups, or routing updates
- `ledger.md`: Markdown operations view for release managers or project-specific ticket sync jobs

Reviewer decisions can be supplied as JSONL at `.rag/human-review/decisions.jsonl`:

```json
{
  "queueItemId": "review_case_1",
  "action": "convert_to_eval",
  "reviewerId": "operator@example.test",
  "summary": "Create regression coverage from the linked safe trace.",
  "evalCandidate": {
    "caseId": "refund_escalation_regression",
    "checks": ["citation_required", "escalation_rule_match"]
  }
}
```

Supported actions are `approve`, `revise`, `reject`, `escalate`, `convert_to_eval`, and `dismiss`. Unknown queue item ids are captured in `invalidDecisions` and do not create accepted decision records. Reviewer ids are hashed before storage; projects can also supply `reviewerIdHash` directly when identity hashing happens in an external admin tool.

```bash
npm run review:ledger
node scripts/build-review-ledger.mjs \
  --queue .rag/human-review/latest/queue.json \
  --decisions .rag/human-review/decisions.jsonl \
  --report-dir .rag/review-ledger/latest
```

The ledger does not include raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, or un-hashed reviewer identifiers. Eval feedback candidates are shells only; the raw question and expected answer are filled later in the project's controlled eval authoring workflow.

## External Review/Ticket Sync Adapter Boundary

Review ticket sync is the adapter boundary between local RAG operations evidence and project-owned ticket systems.

`npm run review:sync` reads the latest human review queue and review decision ledger, then writes:

- `tickets.json`: safe ticket payloads for queue items, review decisions, and feedback signals
- `sync.json`: sink delivery report with dry-run/live mode, counts, attempts, dedupe keys, warnings, redacted errors, and evidence boundary
- `sync.md`: Markdown operations summary

The default CI path is dry-run:

```bash
npm run review:sync
node scripts/sync-review-tickets.mjs \
  --queue .rag/human-review/latest/queue.json \
  --ledger .rag/review-ledger/latest/ledger.json \
  --report-dir .rag/review-sync/latest \
  --mode dry-run
```

For live sync, point the runner at a project-owned HTTPS webhook or ticket-sync bridge:

```bash
RAG_REVIEW_SYNC_MODE=live
RAG_REVIEW_SYNC_WEBHOOK_URL=https://tickets.example.test/rag-review
RAG_REVIEW_SYNC_WEBHOOK_TOKEN_ENV=REVIEW_TICKET_WEBHOOK_TOKEN
REVIEW_TICKET_WEBHOOK_TOKEN=replace_me
node scripts/sync-review-tickets.mjs --env-file .env.review-sync
```

The webhook payload is intentionally generic. A project can translate it into Linear, Jira, Zendesk, an admin dashboard, or an internal support queue, but that translation should consume `tickets.json`-style safe fields and idempotency keys, not raw prompts, answers, source bodies, rendered context, secrets, routing keys, full principal claims, or un-hashed reviewer identifiers.

## External Ticket Status Reconciliation + Idempotency Store

Ticket reconciliation closes the loop after external sync.

`npm run review:reconcile` reads the latest ticket payloads and sync report, optionally reads a previous store and external status snapshots, then writes:

- `idempotency-store.json`: durable local map from RAG review ticket dedupe keys to safe payload hashes, external ticket refs, first/last seen timestamps, and reconciliation status
- `reconciliation.json`: report with counts for pending, skipped, synced, failed, closed, stale, duplicate, external refs, and unmatched external statuses
- `reconciliation.md`: Markdown operations summary

The default CI path reconciles the dry-run output:

```bash
npm run review:reconcile
node scripts/reconcile-review-tickets.mjs \
  --tickets .rag/review-sync/latest/tickets.json \
  --sync .rag/review-sync/latest/sync.json \
  --report-dir .rag/review-reconciliation/latest
```

External status snapshots can be supplied as JSONL at `.rag/review-sync/external-statuses.jsonl`:

```json
{
  "dedupeKey": "rag_review_ticket:queue_item:create:review_1:trace_1",
  "externalId": "linear_123",
  "status": "closed",
  "updatedAt": "2026-06-24T00:00:00.000Z",
  "url": "https://linear.example.test/issue/ABC-123"
}
```

The reconciler preserves previous `firstSeenAt` and external refs, detects duplicate dedupe keys, marks closed tickets from external statuses, marks old open statuses as stale, and fails the gate when duplicate records are present. It does not copy raw prompts, answers, source bodies, rendered context, secrets, routing keys, full principal claims, or un-hashed reviewer identifiers.

## Project Support Event Export Boundary

Project support/admin systems integrate by writing safe `RagSupportEvent` JSONL and optional approval-decision JSONL. The core does not fetch raw tickets, customer messages, admin database rows, or project secrets by itself.

Project wrappers should implement `RagSupportEventExporter` and run `assertRagSupportEventExporterContract()` in their own tests. The contract checks exporter identity, support event schema, source-system and event-type enums, payload-hash shape, idempotency conflicts, forbidden secret patterns, warning redaction, and reviewer identity handling for approval decisions.

For a project-owned connector skeleton, copy `templates/project-support-connector/`. It uses `createRagProjectSupportEventExporter()` so the project owns record loading and mapping, while the RAG core still builds safe `RagSupportEvent` objects and contract-tests the export boundary.

This connector framework is the shipped support/admin integration surface. It includes:

- `createRagProjectSupportEventExporter()` for source+mapper connector wrappers
- `templates/project-support-connector/` as the copyable project connector
- `assertRagSupportEventExporterContract()` for connector CI
- `validate-support-event-export.mjs` for exported JSONL handoff validation
- `support:knowledge` for candidate queue, approval ledger, and approved-source config generation
- `support:drill` for an operator-ready end-to-end support handoff report

The framework intentionally does not bundle Zendesk, Intercom, Jira, Slack, or admin-database SDK clients. Those source clients live in the project repo so credentials, raw records, and source-specific permission models do not enter the generic RAG core.

The exported files can be validated without running project adapter code:

```bash
npm run support:export:validate
node scripts/validate-support-event-export.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-export/latest
```

The validator writes:

- `export.json`: bundled safe event export with an idempotency ledger
- `validation.json`: pass/fail status, metrics, and contract issues
- `export.md`: operator-readable export summary
- `events.jsonl` and `decisions.jsonl`: normalized handoff files for the next gate

Approval-decision exports must use `reviewerIdHash`, not raw `reviewerId`. Any proposed knowledge action other than `none` must require approval. Passing this export contract does not make the event true or answerable; it only proves the project adapter emitted safe handoff records.

## Support Knowledge Flow + Approved Ingestion Handoff

The support knowledge flow is the bridge from safe support/admin events into approved knowledge artifacts.

`npm run support:knowledge` reads support events from `.rag/support-knowledge/events.jsonl` and optional approval decisions from `.rag/support-knowledge/decisions.jsonl`, then writes:

- `event-ledger.json`: support event idempotency ledger with duplicate/conflict status and linked approved artifact ids
- `candidate-queue.json` and `candidate-queue.md`: proposed knowledge changes that still require human approval
- `approval-ledger.json` and `approval-ledger.md`: accepted reviewer decisions and approved artifacts
- `approved-knowledge.sources.json`: deployment config that can be mounted through `RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH`
- `flow.json` and `flow.md`: end-to-end summary, metrics, evidence boundary, and next gate

```bash
npm run support:knowledge
node scripts/run-support-knowledge-flow.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-knowledge/latest
```

The events file accepts a JSON array, an object with an `events` array, one event object, or JSONL. Approval decisions use the same shapes with `decisions`.

The runner does not ingest, chunk, index, or make anything answerable. It only emits a source config for approved artifacts. To make approved support knowledge retrievable, point production ingestion at `.rag/support-knowledge/latest/approved-knowledge.sources.json`:

```text
RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH=.rag/support-knowledge/latest/approved-knowledge.sources.json
```

Then run the normal production ingest command for profile sources backed by `approved_knowledge_artifact`.

Support knowledge flow artifacts do not include raw admin ticket payloads, raw customer messages, raw diagnostics, raw generated answers, rendered prompts, source bodies, secrets, routing keys, full principal claims, or raw reviewer identifiers. They include safe event ids, idempotency keys, candidate ids, approval summaries, approved artifact text, source ids, ledger paths, and artifact ids.

## Support Operator Drill

The support operator drill stitches the support handoff together as one auditable gate: support event export validation, support knowledge approval flow, generated approved-source config, and optional production ingestion.

```bash
npm run support:drill
node scripts/run-support-operator-drill.mjs \
  --events .rag/support-knowledge/events.jsonl \
  --decisions .rag/support-knowledge/decisions.jsonl \
  --report-dir .rag/support-drill/latest
```

The script writes `drill.json`, `drill.md`, `validation.json`, `export.json`, `events.jsonl`, `decisions.jsonl`, `flow.json`, `approval-ledger.json`, and `approved-knowledge.sources.json` to `.rag/support-drill/latest` when those stages are available.

The CLI drill intentionally does not ingest by itself. It proves that exported support events and approved artifacts are still not answerable before production ingestion. Projects that want a full live ingestion drill can call `runRagSupportOperatorDrill()` with a real `ProductionIngestRuntime`; the result records index counts before and after ingestion and marks retrieval eligibility only after new chunks are admitted.

## Provider Smoke + Deployment Drill Boundary

Provider smoke is a deployment drill, not a normal no-secret CI step.

`npm run smoke:providers` runs the same production app config that `serve`, `answer`, and `ingest` use, then calls `app.selfTest({ probeProviders: true })`. It writes:

- `smoke.json`: redacted smoke summary, required-provider coverage, failures, and embedded self-test result
- `self-test.json`: the raw redacted startup self-test result
- `report.html`: local human-readable provider smoke report

The default required providers are all configured providers: model always, plus embedding, visual embedding, rerank, and grounding judge when the runtime actually wires them or their mode is `required`. Override that boundary with `RAG_SMOKE_REQUIRED_PROVIDERS=model,embedding,rerank` or `--required-providers model,embedding`.

Use `deploy/provider-smoke.example.env` as the starter env shape for a secret-enabled deployment drill:

```bash
cp deploy/provider-smoke.example.env .env.smoke
OPENAI_API_KEY=... npm run build
OPENAI_API_KEY=... node scripts/run-provider-smoke.mjs --env-file .env.smoke --report-dir .rag/provider-smoke/latest
```

Smoke output includes provider ids, model names, statuses, warnings, and counts. It does not include prompts, context text, bearer tokens, API keys, raw principals, or source bodies.

## Corpus Adapter Boundary

Corpus adapters are allowed to fetch or receive source material, but they do not get to decide whether material is safe to index.

The app-facing corpus entrypoint is `IngestPipeline`. The raw normalizer is intentionally kept out of the public export barrel so ingestion flows through adapter loading, normalization, chunking, and indexing together.

The normalization gate enforces:

- source id must match the profile's configured source
- disabled sources cannot ingest records
- source kind and sensitivity must match known enums
- null or malformed adapter records are rejected without throwing
- checksums are verified against the record body when present
- parser layout is validated against the normalized document body when present
- record namespace and tenant boundaries must match the request
- requesting principal must be allowed for the namespace
- trust tier overrides can downgrade trust but cannot upgrade it
- source trust floors cap records so a source cannot self-promote above its floor
- profile trust policy decides which trust tiers are allowed
- every accepted document has provenance and access scope

## Source Sync Boundary

Source sync is the freshness layer before ingestion. A `SourceConnector` reports source item `upsert`, `delete`, and `error` operations. `SourceSyncRunner` compares those items against a previous `SourceSyncLedger`, emits only changed `CorpusRecord` objects for ingestion, and records tombstones and retryable failures without storing raw source bodies or raw source ACL payloads in the ledger. `propagateSourceDeletes()` then applies tombstones to indexed documents, chunks, text vectors, visual vectors, and evidence-backed knowledge-map facts. `SourceSyncWorkflowRunner` ties those pieces together so a source sync can delete stale indexed data, ingest changed records, optionally refresh text embeddings, layout-relation embeddings, visual embeddings, and knowledge-map facts, then save the new ledger only after downstream indexing finishes cleanly.

This layer does not replace `IngestPipeline`. It decides what changed; ingestion still normalizes, chunks, indexes, and enforces profile/source policy.

The first shipped sync pieces are:

- `SourceConnector`: generic full/delta source contract for company-owned connectors
- `SourceSyncLedger`: safe cursor, item hash, access-scope hash, tombstone, and retry-state artifact
- `InMemorySourceSyncLedgerStore`: local/test ledger store
- `SourceSyncRunner`: idempotent sync runner that skips unchanged items, returns changed records, emits explicit deletes, tombstones missing items on complete full syncs, and preserves retry state for failed items
- `propagateSourceDeletes`: runtime coordinator that turns sync tombstones into store deletes/prunes with safe per-document counts
- `SourceSyncWorkflowRunner`: integrated runtime coordinator for connector sync, delete propagation, changed-record ingestion, optional post-ingest indexing, and downstream-safe ledger saves
- `GraphStore.pruneEvidence`: knowledge-map prune operation that removes evidence anchors and supersedes facts whose source evidence disappeared

The ledger evidence boundary includes source item ids, corpus record ids, connector/source/namespace ids, safe hashes, cursor, status, and counts. It excludes source bodies, raw source ACLs, credentials, bearer tokens, API keys, and full principal claims. Workflow ledger saves are intentionally conservative: connector failure ledgers are saved for retry visibility, but success ledgers are skipped when delete propagation, changed-record ingestion, or configured post-ingest indexing fails, so later delta syncs do not silently skip work that never reached every configured index.

## Ingestion Pipeline Boundary

The ingestion layer is the only public path from adapter output into the index.

`IngestPipeline.ingest()` runs:

- enabled profile source selection
- registered adapter lookup
- adapter load execution
- source id mismatch warnings
- corpus normalization
- document indexing
- document chunking only after document indexing succeeds
- chunk indexing
- accepted document/chunk reporting only for records the stores accepted

The current implementation includes:

- `LocalFilesCorpusAdapter` for project documentation on disk
- `ApprovedKnowledgeArtifactCorpusAdapter` for human-approved support/review ledgers
- `DatabaseCorpusAdapter` for rows returned by project-owned named queries
- `SaasCorpusAdapter` for paginated SaaS/API objects returned by project-owned clients
- `mapStructuredCorpusRecord` for shared object-to-`CorpusRecord` mapping, checksum creation, enum guards, and access-scope defaults

### Project Adapter Extension Boundary

Projects can register additional production corpus adapters in code through `adapterExtensions`. Profiles still declare only adapter IDs and source policy; the project runtime supplies the actual adapter objects:

```ts
const ingestion = createProductionIngestRuntime({
  app,
  adapterExtensions: [
    {
      adapter: projectTicketsAdapter
    }
  ]
});
```

The extension boundary intentionally does not load adapter modules from env variables. A project wrapper imports trusted adapter code, injects it into the runtime, and the runtime registers it only when the selected profile source names that adapter ID.

Guardrails:

- unknown adapter IDs fail before indexing
- duplicate adapter extension IDs fail before indexing
- extensions cannot override built-in adapters such as `local-files` or `approved_knowledge_artifact`
- custom adapter records still pass through `IngestPipeline`, corpus normalization, checksum verification, trust floors, access scope checks, chunking, and store validation
- ingest summaries return counts and warnings, not raw document bodies or chunk text

### Company Deployment Boundary

For multi-company or multi-project installs, keep the core profile presets reusable and put company-specific use cases, namespaces, connector coverage, eval packs, and adapter implementations in a company deployment:

```ts
const company = {
  companyId: "acme",
  companyName: "Acme Co",
  defaultTenantId: "tenant_acme",
  useCases: [
    {
      id: "support",
      kind: "support",
      namespaceId: "acme-support",
      name: "Acme Support",
      purpose: "Answer support policy questions for Acme.",
      baseProfile: genericDocsProfile,
      parserIds: ["acme-support-parser"],
      corpusSources: [
        {
          id: "support_docs",
          adapter: "acme-support-api",
          description: "Approved Acme support docs.",
          enabled: true,
          trustTierFloor: "trusted_internal",
          tags: ["support", "trusted"]
        }
      ],
      evals: {
        goldenSetPath: "profiles/acme/support/golden.jsonl",
        adversarialSetPath: "profiles/acme/support/adversarial.jsonl",
        requiredChecks: genericDocsProfile.evals.requiredChecks
      }
    }
  ],
  connectors: [
    {
      id: "support_api",
      adapterId: "acme-support-api",
      sourceSystem: "acme-api",
      useCaseIds: ["support"],
      contractTestCommand: "npm test -- acme-support-api"
    }
  ]
} satisfies CompanyProfile;
```

`buildCompanyRagProfiles(company)` derives one validated `RagProfile` per use case. `validateCompanyDeployment(company)` and `assertCompanyDeploymentReady(company)` fail closed on missing identity, duplicate namespaces, connector/source mismatches, missing company eval packs, and profile validation errors.

Company-owned adapter code is grouped in a `CompanyAdapterPack`:

```ts
const adapterPack = {
  id: "acme-pack",
  companyId: "acme",
  description: "Acme production connectors.",
  corpusAdapters: [acmeSupportApiAdapter]
} satisfies CompanyAdapterPack;
```

`CompanyDeploymentRegistry` validates the company and its adapter packs at startup, indexes generated profiles by company/use-case/profile/namespace, and rejects duplicate company IDs, duplicate profile IDs, duplicate namespaces, invalid adapter packs, or unready deployments.

The app-facing entrypoint is `createCompanyRag()`:

```ts
const registry = new CompanyDeploymentRegistry([{ company, adapterPacks: [adapterPack] }]);

const rag = createCompanyRag({
  registry,
  company: { companyId: "acme", useCaseId: "support" },
  config: productionConfig,
  transport,
  env
});
```

That resolves the company use case, injects the generated validated profile into `createRag()`, and registers only the integration pieces needed by that selected use case:

- corpus adapters whose IDs are declared by the selected profile sources
- parsers whose IDs are listed by the selected company use case
- source connectors attached to the selected company use case
- permission mappers for those selected connectors' source systems
- connector contract-test commands for those selected connectors

Runtime ingestion and answering still go through the same production pipeline, so company adaptation cannot bypass profile validation, source declarations, ACL checks, trust floors, freshness policy, citation policy, eval metadata, or safe traces.

Validate a company deployment module in CI after build:

```bash
npm run company:validate -- \
  --module dist/company/examples/acme-support.company.js \
  --export acmeSupportCompanyProfile \
  --report-dir .rag/company/acme-support
```

The validator prints a safe summary with company identity, generated profile IDs, namespaces, source IDs, adapter IDs, and readiness issues. It does not load adapters from env variables or print source bodies, connector credentials, API keys, principal claims, or retrieved context.

Add full pack contract execution to the same deployment check by exporting the company adapter pack from the deployment module:

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

The script writes `company-deployment.json` and, when pack contracts run, `company-pack-contracts.json`. The pack report includes adapter, parser, source connector, permission mapper, coverage, issue-code, source-id, mode, count, and ledger summaries; it does not include connector records, parser bodies, warning payloads, source bodies, credentials, or principal claims.

Production startup can load the same compiled company module and adapter pack exports directly:

```bash
RAG_COMPANY_MODULE_PATH=dist/company/examples/acme-support.company.js \
RAG_COMPANY_PROFILE_EXPORT=acmeSupportCompanyProfile \
RAG_COMPANY_ADAPTER_PACK_EXPORTS=acmeSupportAdapterPack \
RAG_COMPANY_USE_CASE_ID=support \
RAG_COMPANY_PACK_CONTRACT_MODE=required \
node dist/runtime/production-cli.js validate-config --run-pack-contracts true
```

When `RAG_COMPANY_MODULE_PATH` is set, the CLI builds a `CompanyDeploymentRegistry`, resolves the selected use case by `RAG_COMPANY_USE_CASE_ID`, `RAG_COMPANY_PROFILE_ID`, or `RAG_COMPANY_NAMESPACE_ID`, injects the generated profile into the production app config, and passes the selected pack's corpus adapters and parsers into production ingestion. `RAG_COMPANY_PACK_CONTRACT_MODE=required` or `--run-pack-contracts true` fails startup before serving if the pack contract gate fails.

For company connectors, run source sync through the same selected company module:

```bash
node dist/runtime/production-cli.js sync \
  --mode delta \
  --tenant-id tenant_acme \
  --namespace-id acme-support \
  --user-id sync_operator \
  --principal-namespace-id acme-support \
  --role support \
  --source-id support_docs
```

`sync --mode delta` pulls only changed source items using the saved source-sync ledger cursor. `sync --mode full` asks the connector for the full current source listing and, when the connector returns `complete=true`, tombstones missing previous items unless `--delete-missing false` is supplied. Sync output is a redacted operational summary with counts, statuses, warning codes, and ledger-save state; it does not print connector records, document bodies, chunks, cursors, source ACL payloads, credentials, or principal claims.

Run the repeatable company deployment smoke before promoting a company module:

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

The smoke runs the same compiled module through three gates: `validate-config --run-pack-contracts true`, `sync --mode delta`, and `validate-config --self-test true`. It writes `.rag/company-smoke/latest/smoke.json` with gate status, counts, warnings, and failures only. It does not include connector records, source bodies, chunk text, cursor values, credentials, provider payloads, or principal claims. For real provider probes during a controlled deployment check, add `--probe-providers`.

For the Postgres/pgvector production target, start from `deploy/company-production.example.env` and follow `deploy/company-production-runbook.md`. That path keeps documents/chunks, text vectors, ingestion jobs, and source-sync ledgers in Postgres and uses the company smoke as the promotion gate before `serve`. For an actual local pgvector drill, start `deploy/postgres/docker-compose.pgvector.yml`, export `RAG_DATABASE_URL`, and run `npm run company:smoke:postgres -- --local-provider --reset-schema --probe-providers`. The same storage gate is available in GitHub Actions as `Company Postgres Smoke`, with a pgvector service container and uploaded smoke artifacts.

For a copyable company integration skeleton, use `templates/company-connector-pack/`. It exports a `CompanyProfile`, `CompanyAdapterPack`, corpus adapter, source connector, permission mapper, starter eval JSONL, and contract test. The company replaces the source client and native ACL projection while keeping the same validation and deployment command shape, including delta cursor handoff, complete full-sync fixtures, tombstone-safe deletes, and redacted ACL fingerprints.

Run registered company packs through the company contract gate before accepting a company deployment:

```ts
await assertCompanyPackContractTests({
  registry,
  company: { companyId: "acme", useCaseId: "support" },
  requestedBy: ingestPrincipal,
  requestedAt: "2026-06-24T00:00:00.000Z"
});
```

The runner resolves the selected company/use-case profile, validates every selected corpus adapter against its declared sources, validates every selected parser against pack-owned parser fixtures, executes each declared `SourceConnector` against its bound source ids in delta and full mode, carries the delta ledger into the full sync, validates registered permission mappers against the company tenant/namespace boundary, and surfaces adapter-pack coverage warnings. Use `runCompanyPackContractTests()` when CI needs a structured report instead of a thrown `CompanyPackContractError`. The lower-level `runCompanyConnectorContractTests()` remains available for connector-only checks.

### Adapter SDK Contract Tests

Adapter authors should run `assertCorpusAdapterContract()` in their own test suite before registering an adapter with production ingestion:

```ts
await assertCorpusAdapterContract({
  adapter: projectTicketsAdapter,
  profile,
  source: profile.corpusSources[0],
  requestedBy: ingestPrincipal,
  runId: "tickets_contract",
  requestedAt: "2026-06-24T00:00:00.000Z"
});
```

The contract helper checks:

- adapter id, description, and profile source adapter match
- adapter `load()` returns a source id matching the requested source
- warnings have source ids, stable codes, messages, and no obvious secret diagnostics
- returned records pass corpus normalization with checksum, enum, provenance, trust-floor, freshness, tenant, namespace, and principal-boundary checks
- the fixture loads at least one record and accepts at least one document by default

Use `validateCorpusAdapterContract()` when a test needs structured issues instead of a thrown error. Negative fixtures can set `expectations.minLoadedRecords`, `expectations.minAcceptedDocuments`, and `expectations.maxRejectedRecords` explicitly.

### Local Files Adapter

`LocalFilesCorpusAdapter` is the production local-disk adapter behind the default `local-files` adapter id.

Profiles still only declare source IDs and safety policy. File locations are operational config supplied when the app starts:

```ts
const adapter = new LocalFilesCorpusAdapter({
  sources: [
    {
      sourceId: "curated_docs",
      rootDir: "/absolute/path/to/project/docs",
      includeExtensions: [".md", ".txt"],
      accessScope: {
        roles: ["support"],
        tags: ["curated", "docs"]
      }
    }
  ]
});
```

The adapter:

- resolves all files under the configured root
- skips hidden paths, common build/dependency folders, symlinks, oversized files, binary-looking files, empty files, and unsupported extensions
- rejects explicit paths outside the source root
- derives stable document IDs from source ID and relative path
- extracts Markdown H1 titles when present
- can call a trusted `DocumentParser` when the source config names `parserId`
- passes parser output back as a normal `CorpusRecord`, including optional layout
- redacts parser warning/failure diagnostics before returning adapter warnings
- adds `capturedAt`, `checksum`, relative path, source kind, trust tier, sensitivity, and access scope to every record
- defaults access tenant/namespace from the ingest request and source access tags from the profile source tags
- leaves final safety decisions to `IngestPipeline` and corpus normalization

Parser-backed local source example:

```ts
const adapter = new LocalFilesCorpusAdapter({
  parsers: [projectPdfParser],
  sources: [
    {
      sourceId: "curated_docs",
      rootDir: "/absolute/path/to/project/docs",
      includeExtensions: [".pdf"],
      parserId: projectPdfParser.id,
      parserRequireLayout: true
    }
  ]
});
```

Parser-backed local files still flow through:

- source root and extension allowlists
- max file byte limits
- parser input-mode and content-type checks
- parser source/parser id checks
- checksum creation from parsed body
- corpus normalization layout validation
- normal chunking and layout-aware citation propagation

### Database Adapter

`DatabaseCorpusAdapter` is the generic database boundary behind the default `database` adapter id.

The adapter does not build SQL or open database connections. A project supplies a `DatabaseCorpusClient` that executes a named, prepared query and returns row objects:

```ts
const adapter = new DatabaseCorpusAdapter({
  client: databaseClient,
  sources: [
    {
      sourceId: "database_docs",
      queryName: "rag_support_policies",
      parameters: { active: true },
      maxRows: 1000,
      trustTier: "trusted_internal",
      mapping: {
        id: "id",
        title: "title",
        body: "body",
        capturedAt: "updated_at",
        accessScope: {
          teamIds: "team_ids",
          roles: "roles",
          tags: "tags"
        }
      }
    }
  ]
});
```

The database adapter:

- only calls configured named queries; it does not interpolate user input into query text
- passes tenant, run id, request time, parameters, and max row cap to the injected client
- caps returned rows even if a client ignores `maxRows`
- maps scalar row fields into stable document ids, title, body, provenance, metadata, and access scope
- computes checksums from the mapped body instead of trusting upstream checksums
- redacts likely connection-string, token, password, secret, and API-key values from adapter warnings
- leaves final source id, tenant, namespace, freshness, checksum, trust floor, and profile-policy enforcement to `IngestPipeline`

### SaaS/API Adapter

`SaasCorpusAdapter` is the generic paginated SaaS/API boundary behind the default `saas-api` adapter id.

The adapter does not store API keys or hardcode one vendor. A project supplies a `SaasCorpusClient` that fetches pages and returns objects plus an optional cursor:

```ts
const adapter = new SaasCorpusAdapter({
  client: helpdeskClient,
  sources: [
    {
      sourceId: "support_tickets",
      endpointId: "helpdesk_tickets",
      pageSize: 100,
      maxPages: 20,
      maxRecords: 1000,
      trustTier: "verified_partner",
      mapping: {
        id: "id",
        title: "subject",
        body: "text",
        capturedAt: "updated_at",
        accessScope: {
          userIds: "assignee_ids",
          tags: "labels"
        }
      }
    }
  ]
});
```

The SaaS adapter:

- keeps provider-specific auth, retries, and API details inside the injected client
- passes endpoint id, cursor, page size, tenant, run id, request time, and parameters to the client
- stops repeated cursors to prevent pagination loops
- enforces max page and max record limits
- maps objects through the same structured mapper as database rows
- computes checksums locally and redacts sensitive failure details in warnings
- lets ingestion reject cross-tenant, cross-namespace, stale, malformed, or over-trusted records before indexing

## Document + Chunk Boundary

Chunking is the step between safe documents and future retrieval.

The chunker enforces:

- chunks copy namespace, access scope, and provenance from the source document
- every chunk gets a stable id and text hash
- every chunk gets an exact citation pointer
- every chunk records its character range
- every chunk's text exactly equals `document.body.slice(characterStart, characterEnd)`
- layout-aware chunks copy overlapping layout region ids, page numbers, and bounding boxes into citations
- `preserveWhitespace: false` trims chunk edges by moving ranges, not by mutating chunk text after range selection
- invalid policies throw `ChunkingPolicyError` before chunking
- policies that would exceed `maxChunksPerDocument` throw instead of truncating source text
- line and paragraph locator strategies emit real `line(s) X-Y` or `paragraph(s) X-Y` locators
- non-whitespace source characters are covered by generated chunks in round-trip tests
- suspicious text is flagged but not silently trusted or executed
- chunk validation can reject orphaned, oversized, uncited, invented-layout, or mismatched chunks

## Index Boundary

The index stores safe documents and chunks so retrieval can use them later. Index reads are treated as access-controlled reads, not raw storage access.

The index enforces:

- documents must validate before storage
- chunks must belong to an already-indexed document
- chunks must validate against their parent document
- every document/chunk read requires tenant, namespace, and requesting principal scope
- invalid or missing read filters fail closed without leaking existence
- `hasDocument` and `hasChunk` require the same `IndexFilter` as `get`, `find`, and `list`
- source, trust tier, source kind, access tag, and safety flag filters are available
- access tag filters require all requested tags, not any one matching tag
- duplicate documents/chunks reject by default unless replacement is explicit
- index implementations expose capability flags for durability and vector/hybrid support

## Embedding + Vector Boundary

Embeddings are an execution detail behind `EmbeddingAdapter`; profiles do not embed provider keys, model secrets, or vector-store connection details.

The vector foundation includes:

- `EmbeddingAdapter` for provider-neutral text embedding
- `FakeEmbeddingAdapter` for deterministic local tests and offline development
- `ProviderEmbeddingAdapter` for real embedding providers through injected transport and secrets
- `EmbeddingIndexer` for embedding already-accepted chunks
- `LayoutRelationIndexer` for embedding validated layout relations as synthetic relation evidence vectors anchored to accepted chunks
- `VisualEmbeddingAdapter` for provider-neutral visual and page/patch multi-vector embedding
- `ProviderVisualEmbeddingAdapter` for real visual embedding providers through the same HTTP/auth/retry/redaction boundary
- `createIndexedVisualEmbeddingAdapter` for generic indexed visual providers that return one or more vectors per visual input
- `VisualEmbeddingIndexer` for embedding accepted parser/layout visual assets into a visual vector store, including text from validated related layout regions
- `VectorStore` for access-filtered vector search
- `VisualVectorStore` for access-filtered multi-vector visual search
- `InMemoryVectorStore` for local/test use
- `JsonFileVectorStore` for durable local vector snapshots with validation on reload
- `InMemoryVisualVectorStore` and `JsonFileVisualVectorStore` for visual vector storage
- `HostedVectorStore` for async external vector services behind a safe transport boundary
- `HostedVisualVectorStore` for hosted visual patch-vector fanout with local visual-record aggregation
- hosted vector transport presets for Pinecone, Qdrant, Weaviate, and pgvector RPC/PostgREST deployments
- `VectorRetriever` for vector retrieval through the same `IndexFilter` boundary as keyword retrieval
- `HybridRetriever` for safe keyword+vector reciprocal-rank fusion and chunk dedupe

The vector path enforces:

- vectors are created only from chunks that already passed ingestion, normalization, chunking, and indexing
- layout relation vectors are created only from validated layout relations and still point at accepted chunks, so retrieval resolves through the same chunk store and access filters
- visual vectors are created only from chunks with trusted parser/layout visual assets
- visual inputs include chunk text plus validated related caption/explanation/continuation region text when layout relations connect them
- provider API keys enter through injected secret providers and are redacted from failures
- provider responses must return finite vectors with the configured dimensions
- visual provider responses must map back to submitted input ids or provider indices; unknown ids are rejected
- vector search resolves every vector back through the chunk store with the caller's `IndexFilter`
- visual search resolves every visual vector candidate back through the same chunk store and `IndexFilter`
- durable vector snapshots are validated before reads are served and written with atomic temp-file replacement
- hosted vector results are treated as untrusted pointers until they resolve through the local chunk store
- hosted vector queries send tenant/namespace/vector/candidate controls, but not principal claims or raw access scopes
- hosted vector matches must still match local chunk tenant, namespace, document id, text hash, and dimensions
- hosted visual patch matches must also carry visual record, patch, and optional layout metadata before local MaxSim aggregation
- denied chunks, missing chunks, stale vectors, and dimension mismatches are not returned as candidates
- query text and raw vector values are not written to retrieval traces
- hybrid retrieval composes safe child retrievers; it does not bypass index or vector-store access checks

Current implementations:

- `InMemoryRagIndex`: local/test implementation, not durable
- `JsonFileRagIndex`: durable local JSON snapshot implementation with atomic writes and validation on reload
- `InMemoryVectorStore`: local/test vector implementation, not durable
- `JsonFileVectorStore`: durable local vector JSON snapshot implementation with atomic writes and validation on reload
- `InMemoryVisualVectorStore`: local/test multi-vector visual implementation, not durable
- `JsonFileVisualVectorStore`: durable local visual vector JSON snapshot implementation with atomic writes and validation on reload
- `HostedVectorStore`: generic async hosted vector-store adapter boundary backed by an injected transport
- `HostedVisualVectorStore`: hosted visual patch-vector store backed by the same vendor transports, with local access checks and visual-record grouping
- `PineconeHostedVectorTransport`: Pinecone upsert/query/delete mapping with namespace and metadata filters
- `QdrantHostedVectorTransport`: Qdrant points upsert/query/delete mapping with payload filters and optional named vectors
- `WeaviateHostedVectorTransport`: Weaviate batch object, GraphQL vector query, and batch delete mapping
- `PgVectorRpcHostedVectorTransport`: PostgREST table upsert/delete plus RPC vector-match mapping for pgvector deployments

`JsonFileRagIndex`, `JsonFileVectorStore`, and `JsonFileVisualVectorStore` are durable boundary implementations for local apps, demos, and CI. `HostedVectorStore` and `HostedVisualVectorStore` are the production boundaries for external vector services. Vendor transports translate RAG vector operations into provider HTTP calls, but they do not own access control. Every hosted match still resolves through the local chunk store and the caller's `IndexFilter`.

Hosted vector transports use injected fetch and secret providers. Profiles can select retrieval behavior, but profiles do not contain API keys, endpoints, table names, collection names, or raw provider credentials.

## Security + Access Control Boundary

The security layer is the runtime decision point for tenant and RBAC-style evidence access.

The access-control gate enforces:

- invalid principals are denied
- resources without tenant and namespace scope are denied
- principal tenant must match the requested tenant
- principal namespace grants must include the requested namespace
- scoped user, team, role, and tag restrictions are enforced
- required scope tags must all be present on the principal
- `findDocuments`, `findChunks`, `getDocument`, `getChunk`, `listDocuments`, and `listChunks` all require an `IndexFilter`
- `accessDecisionAudit` returns a redacted denial/allow audit record with reason, counts, and hashes, not raw user/team/role/tag claims

Retrieval and direct store reads use the same `IndexFilter` shape: `namespaceId`, `tenantId`, and `principal` are mandatory.

## Query Planning Boundary

Query planning is the safe rewrite layer before retrieval. It does not access documents, build prompts, or call a model by default.

The default planner follows the LightRAG-style split between:

- low-level keywords: entity-like names, identifiers, versions, dates, and exact objects
- high-level keywords: thematic terms used to broaden semantic or keyword recall

The query-planning path enforces:

- every answer run starts with the original user question as a planned query
- profile `retrieval.allowQueryRewrite` must be true before rewritten low-level/high-level queries are accepted
- profile `retrieval.allowParallelQueries` must be true before multiple planned queries are executed
- injected project planners cannot bypass those profile flags
- planned query text, extracted keywords, and raw question text are not written to run traces
- run traces store query-plan id, planned-query hashes, low-level keyword hashes, and high-level keyword hashes
- graph-intent traces store route, direction, execution mode, relation-kind hashes, and entity-hint hashes without raw entity names
- multiple planned retrieval results are fused with reciprocal rank fusion before context assembly
- retrieval-call budgets are checked against the number of planned queries before any retrieval call starts
- `DefaultRetrievalBudgetPolicy` assigns per-branch `topK`, candidate-pool limits, fusion weights, and graph fanout controls after query planning
- graph expansion is request-scoped, so non-graph branches can explicitly disable graph fanout even when the injected retriever supports graph search
- graph-required branches can run in `graph_first` mode with bounded multi-hop traversal, while ordinary branches can keep graph as one-hop expansion evidence
- retrieval budget traces redact raw graph entity hints into counts and hashes

`HydeQueryPlanner` can wrap any `QueryPlanner` and add one hypothetical-document planned query when rewrite and parallel-query policy allow it. If the query budget is already full, it only replaces the lowest-weight non-original, non-graph query; it never removes the original question or graph route. HyDE generation is fail-open by default, with `failOpen: false` available when a caller wants generation failure to block planning.

The current implementation includes `DefaultQueryPlanner`, `ModelAssistedQueryPlanner`, `HydeQueryPlanner`, and `DefaultRetrievalBudgetPolicy`, with `QueryPlanner` and `RetrievalBudgetPolicy` available as project-specific extension points.

## Knowledge Map Backends

A knowledge map is the system's fact memory: entities, relationships, summaries, and the source chunks that support those facts. Internally the lower-level contracts still use the word `Graph` because this is the standard data-structure name for connected facts, but the plug-and-play API exposes it as `createRag({ knowledge: ... })` for setup and `createRag(...).knowledge` at runtime.

Knowledge-map facts use the `GraphStore` interface, so ingestion, approval, entity resolution, relationship querying, and relationship-aware retrieval do not depend on one storage implementation.

Available proposal knowledge-map stores:

- `InMemoryGraphStore`: fastest for tests and throwaway local runs, but the knowledge map disappears when the process exits.
- `JsonFileGraphStore`: durable local JSON snapshot for small corpora and debugging.
- `SqliteGraphStore`: durable SQLite-backed graph store with indexed entity names, relation kinds, adjacency lookups, fact statuses, access requirements, evidence anchors, and cursor pagination.
- `HostedGraphStore`: vendor-neutral adapter for a remote or clustered graph backend. It implements the same `GraphStore` contract through an injected `HostedGraphStoreTransport`, sends only a safe tenant/namespace/query filter to the transport, and locally re-checks every returned entity/relation with the caller's `IndexFilter` before results leave the adapter.

Runtime assembly defaults to `InMemoryGraphStore` when knowledge-map retrieval is configured without a store. Passing `graphStorePath` still creates a JSON graph file for backward compatibility. To use SQLite, set `graphStoreKind: "sqlite"` and provide `graphStorePath`.

To use a hosted backend, construct `new HostedGraphStore({ transport })` with a project-owned transport for Neo4j, Neptune, a graph service, or another clustered database, then pass it as the runtime `graphStore`. The core package does not choose the vendor; it owns the contract and the final local access check. Remote results are treated as candidates, not trusted answers.

Project-owned hosted transports should run `assertHostedGraphTransportContract({ transport })` in their own test suite before production use. The contract writes a fixture graph, checks entity name/id lookup, adjacency lookup, relation-kind and approval-status filtering, tenant/namespace isolation, cursor paging, status updates, relation endpoint rewrites, and the `HostedGraphStore` no-principal/no-access-leak wrapper behavior.

For large knowledge-map scans, prefer `pageEntities` and `pageRelations` over repeated `find...` calls. Page cursors are opaque tokens ordered by stable fact keys, so callers can walk large entity or relation sets without offset scans.

For large knowledge-map writes, prefer `importGraphBatches()` over one giant `addExtractionBatch()` call. The local plug-and-play API exposes this as `createRag(...).knowledge.importBatches(...)`; `createRag({ graph: ... })` and `createRag(...).graph.importBatches(...)` remain as backward-compatible technical aliases. It accepts sync or async streams of valid `GraphExtractionBatch` records, retries transient write failures, records unresolved failed batch ids, writes resumable checkpoints through `JsonFileGraphBatchImportCheckpointStore`, and returns `succeeded`, `partial`, or `failed` with safe metrics. `chunkGraphExtractionBatch()` can split one validated source batch into smaller valid chunks while preserving the rule that every relation chunk includes its endpoint entities.

Use `npm run graph:import -- --batches path/to/graph-batches.jsonl` to run the same importer from files. The input can be newline-delimited `GraphExtractionBatch` records, a JSON array, a single JSON batch object, or `{ "batches": [...] }`. The command defaults to SQLite and writes `.rag/graph-import/latest/import.json`, `.rag/graph-import/latest/report.md`, `.rag/graph-import/latest/<import-id>.checkpoint.json`, and `.rag/graph-import/latest/graph.sqlite`. When `--import-id` is omitted, the CLI derives a stable id from the batch file content so rerunning the same import resumes cleanly instead of colliding with a stale checkpoint. It also accepts `--store memory|json|sqlite`, `--sqlite-path`, `--json-path`, `--checkpoint-path`, `--max-attempts`, `--retry-delay-ms`, `--continue-on-error`, and threshold flags such as `--max-failed-batches`, `--max-failure-ratio`, and `--max-write-p95-ms`.

Use `npm run graph:benchmark` before trusting a graph store for production-sized workloads. The default run uses SQLite and writes:

- `.rag/graph-benchmark/latest/benchmark.json`: machine-readable parameters, timings, thresholds, and violations
- `.rag/graph-benchmark/latest/report.md`: human-readable status and timing summary
- `.rag/graph-benchmark/latest/graph.sqlite`: the durable SQLite graph database used by the default benchmark run

The benchmark accepts `--store memory|sqlite`, `--entity-count`, `--relation-count`, `--page-size`, `--sample-count`, `--sqlite-path`, and threshold flags such as `--max-entity-lookup-p95-ms` and `--max-relation-page-total-ms`. Threshold failures set a nonzero exit code after reports are written, which makes it usable as a CI gate. This is a local-store load check, not a hosted distributed graph database replacement; a project with millions of long-lived entities should still validate owner-specific data shape, hardware, concurrency, and backup requirements.

## Retrieval Boundary

Retrieval finds candidate chunks from the safe index. It does not build prompts or generate answers.

The retrievers enforce:

- retrieval must include a namespace, tenant, and requesting principal
- retrieval tenant must match the requesting principal tenant
- requesting principal must be granted the requested namespace before candidate lookup
- explicit mode mismatches are rejected by each retriever
- retrieval uses index filters for namespace, tenant, trust, source, access tag, and safety flags
- candidates preserve chunk citation and provenance
- scores, matched terms, reasons, rejected candidates, and traces are returned for auditability
- `topK` limits returned candidates after scoring
- candidate-pool limits are explicit and audited
- answer runtime can send different `topK` and candidate-pool limits to each planned query branch
- knowledge-map retrieval accepts request-scoped entity hints, relation kinds, direction, execution mode, entity limits, neighbor limits, max depth, and max visited entities
- knowledge-map retrieval filters every hop by relation kind and incoming/outgoing direction before resolving chunks through the safe chunk store
- relationship traversal defaults to one hop, can opt into bounded multi-hop traversal, and rejects depths above the built-in safe cap
- relationship candidates can carry path evidence with seed entity, target entity, ordered relation edges, relation ids/types, and edge evidence chunk ids
- relationship-path evidence survives RRF/planned-query fusion, hybrid fusion, reranking, context building, and model-backed grounding judge input
- retrieval trace does not include raw chunk text
- retrieval trace does not include raw query text, normalized query text, search terms, full principal claims, access tags, or source filters
- retrieval trace uses query hashes, search-term hashes, principal hash, tenant/namespace ids, and filter counts for correlation
- retrievers advertise capabilities, and `RagAnswerRuntime.answer()` refuses before retrieval if the profile mode is not supported by the injected retriever
- hybrid retrieval uses reciprocal rank fusion by default for keyword/vector child results, dedupes by chunk id, and returns one ranked result set
- hybrid retrieval keeps score normalization available as an explicit compatibility mode
- retrieval traces record fusion strategy and child retrieval ids without raw query text
- reranking only reorders candidates already returned by a safe retriever
- model reranking cannot introduce new chunk ids, and invalid/unknown model scores are rejected
- model rerank profiles fail runtime assembly unless a reranker is configured
- rerank traces include ids, counts, provider/model identity, and warning codes, not raw query or chunk text

The current implementations are `KeywordRetriever`, `VectorRetriever`, `HybridRetriever`, `RerankingRetriever`, `LightweightReranker`, `ModelBackedReranker`, and the shared RRF utility. `RAG_ENGINE_CAPABILITIES` is the shared source of truth used by profile validation.

## Context Builder Boundary

The context builder turns retrieval candidates into the evidence package that a future generator can use.

The context builder enforces:

- profile namespace must match retrieval namespace
- chunks must have exact citations before entering context
- source kinds must be allowed by the profile citation policy
- trust tiers must be allowed by the profile trust policy
- freshness policy rejects stale or metadata-incomplete source chunks
- strict prompt-injection flags are rejected
- secret-like chunks are rejected
- personal data is redacted before generation when configured
- chunk and token budgets are enforced before generation
- duplicate chunks are removed
- security policy controls retrieved-text warnings and source isolation boundaries
- relationship-path evidence is rendered beside the normal chunk citation when a candidate came from knowledge-map traversal
- context traces include ids, counts, budgets, and rejection codes, not raw retrieved text

The current implementation is `ContextBuilder`, with `renderContextForGeneration` available for creating isolated source blocks for a future answer-generation step.

## Answer / Grounding Boundary

The answer layer is the gate between safe context and a future model adapter.

The grounding gate enforces:

- profile id and namespace must match the context package
- generation is refused when evidence is missing or citation thresholds are not met
- human review is required when profile action policy or evidence trust requires it
- generation input contains only approved, isolated context blocks
- relationship-path evidence from approved context blocks is available to model-backed grounding judges
- the generation contract lists allowed citation chunk ids
- drafts must include required citations
- drafts cannot cite chunks outside the approved context
- cited relationship-path evidence is checked edge by edge for continuous paths, matching depth, valid endpoints, and missing edge evidence
- drafts must include evidence summaries when the output contract requires them
- drafts cannot request actions the profile does not allow
- actions that require approval are surfaced as warnings
- optional model-backed grounding judges run only after deterministic draft validation passes
- grounding judges can downgrade answers to `validation_failed` or `human_review_required`, never upgrade invalid drafts
- grounding judge traces include ids, verdicts, counts, provider/model identity, latency, and warning codes, not raw answer text or context text
- answer traces include ids, counts, status, and refusal codes, not raw context text

The current implementations are `GroundingGate` and `ModelBackedGroundingJudge`. The gate prepares generation input and validates sourced answer drafts; the judge boundary lets projects plug in a model-backed groundedness evaluator after deterministic validation.

## Model + Generation Boundary

The model layer is the provider-neutral socket for answer generation. The generation orchestrator is the safe runtime path around that socket.

The model adapter contract requires:

- structured `SourcedAnswerDraft` output
- provider and model identity
- token usage
- cost estimate
- latency
- success/failure status
- no direct access to index internals

The generation orchestrator enforces:

- the grounding gate runs before any model call
- refused requests do not call the model
- model failures return `model_failed`
- thrown adapter errors are converted into failed model results
- generated drafts are validated before success
- optional grounding judges run after deterministic validation and before success status
- unsupported judge verdicts return `validation_failed`
- uncertain or failed judge verdicts return `human_review_required`
- invalid drafts return `validation_failed`
- valid drafts that require approval return `human_review_required`
- model warnings return `human_review_required`
- model call count, model latency, cumulative estimated cost, and draft output size are checked through `BudgetMeter`
- model-backed judge calls are also checked through `BudgetMeter`
- generation traces include ids, status, usage, cost, latency, and validation counts, not raw context text
- generation traces include the model request id and optional judge id for audit correlation

The current implementation is `GenerationOrchestrator`, with `FakeModelAdapter` for deterministic local testing, `ModelBackedGroundingJudge` for post-validation groundedness checks, and provider-backed adapters available through the provider boundary.

## Real Provider Adapter Boundary

The provider boundary is the production wrapper shape for real LLM providers without hardcoding one provider or calling live APIs in tests.

The provider adapter boundary enforces:

- provider config validates before runtime
- endpoints must use HTTPS unless targeting localhost
- API keys enter through an injected secret provider
- request bodies are built by an explicit provider-specific function
- responses are parsed by an explicit provider-specific function
- auth headers, timeout, and request id are set at the boundary
- retry policy is explicit and capped
- rate limits, timeouts, auth errors, provider errors, network errors, and invalid responses are mapped consistently
- secrets are redacted from provider error messages
- token usage is accepted from the provider or estimated when absent
- cost is estimated from provider pricing config
- provider adapters still satisfy the same `ModelAdapter` contract used by `GenerationOrchestrator`

The current implementation includes `ProviderModelAdapter`, `ProviderEmbeddingAdapter`, `ProviderVisualEmbeddingAdapter`, `ProviderRerankAdapter`, `ProviderGroundingJudgeAdapter`, `FetchProviderTransport`, generic JSON-chat/indexed-embedding/indexed-visual-embedding/rerank/grounding-judge presets, OpenAI-compatible presets, and Anthropic Messages presets.

## Provider Presets + Runtime Assembly

Provider presets are the plug-in boundary between the generic RAG skeleton and a project's chosen model or embedding service.

The preset layer includes both generic shapes and provider compatibility wrappers:

- `createJsonChatModelAdapter` wraps `ProviderModelAdapter` for chat-style providers that accept `messages` and return JSON sourced-answer drafts
- `createIndexedEmbeddingAdapter` wraps `ProviderEmbeddingAdapter` for embedding providers that accept an input array and return indexed vectors
- `createIndexedVisualEmbeddingAdapter` wraps `ProviderVisualEmbeddingAdapter` for visual providers that return indexed single-vector or multi-vector payloads
- `createJsonRerankAdapter` wraps `ProviderRerankAdapter` for chat-style providers that return JSON candidate scores
- `createJsonGroundingJudgeAdapter` wraps `ProviderGroundingJudgeAdapter` for chat-style providers that return JSON verdicts and issue lists
- `createOpenAICompatibleChatModelAdapter` wraps the JSON chat preset for OpenAI-compatible chat completion shapes
- `createOpenAICompatibleEmbeddingAdapter` wraps indexed embeddings and can include the configured vector dimensions in the request body
- `createOpenAICompatibleRerankAdapter` and `createOpenAICompatibleGroundingJudgeAdapter` wrap the generic JSON presets for OpenAI-compatible chat response shapes
- `createAnthropicMessagesModelAdapter`, `createAnthropicRerankAdapter`, and `createAnthropicGroundingJudgeAdapter` build Anthropic Messages request bodies and use `x-api-key` plus `anthropic-version` headers
- all presets require injected `ProviderTransport` and `ProviderAdapterSecrets`
- no preset stores API keys, reads environment variables directly, or bypasses provider redaction/retry/error mapping

Runtime assembly is the app-facing plug-and-play entrypoint:

```ts
const rag = assembleRagRuntime({
  profile: ultimateDefaultProfile,
  chunkStore,
  vectorStore,
  embeddingAdapter,
  model,
  now: () => new Date().toISOString()
});

const result = await rag.answer({
  question: "What does the policy say?",
  filter
});
```

`assembleRagRuntime()` enforces:

- raw profiles are validated before runtime creation
- keyword profiles receive `KeywordRetriever`
- vector profiles require `embeddingAdapter` and `vectorStore`
- hybrid profiles require vector components and compose `KeywordRetriever` plus `VectorRetriever`
- visual profiles require `visualEmbeddingAdapter` and `visualVectorStore`
- callers cannot accidentally omit the validated profile or model on each `answer()` call because the assembled runtime owns them
- every answer still flows through `RagAnswerRuntime`, so linked traces, budget checks, context safety, grounding, citation validation, and access controls remain active

### Public Answer Citation Shape

Callers should display citations from resolved context citations, not from free-form model text. The runtime exposes those in two places:

- `result.answerCitations` on `RagAnswerResult`
- `result.generation.resolvedCitations` on `GenerationRunResult`

`ProductionRagApp.answer()` returns the same resolved list as top-level `citations`.

```ts
const result = await rag.answer({
  question: "What does the Revenue by Quarter chart show?",
  filter
});

for (const citation of result.answerCitations) {
  const asset = citation.visualAsset;
  const label =
    asset?.sheetName && asset.anchorCell
      ? `${asset.title ?? asset.id}, ${asset.sheetName}!${asset.anchorCell}`
      : citation.locator;

  console.log({
    title: citation.title,
    chunkId: citation.chunkId,
    locator: citation.locator,
    visual: label
  });
}
```

Example visual citation:

```json
{
  "sourceId": "curated_docs",
  "chunkId": "curated_docs_formulas_merged_hidden_chunk_1",
  "title": "formulas_merged_hidden.xlsx",
  "locator": "chars 0-173",
  "visualAssetId": "sheet_1_chart_1",
  "visualAsset": {
    "id": "sheet_1_chart_1",
    "kind": "figure",
    "mediaType": "image/svg+xml",
    "pageNumber": 1,
    "assetType": "chart",
    "title": "Revenue by Quarter",
    "chartType": "BarChart",
    "sheetName": "Model",
    "anchorCell": "R2C5",
    "artifactKind": "generated_chart_svg"
  },
  "pageNumber": 1,
  "layoutRegionIds": ["sheet_1_title", "sheet_1_table_region"]
}
```

This citation object is derived from accepted retrieval context after draft validation. A model may return only `citationChunkIds`; the runtime resolves those ids back to canonical context citations. Visual asset metadata is sanitized and intentionally does not expose parser `file://` URIs, local paths, checksums, provider keys, raw page images, or source bodies.

## Live Runtime Config + Fetch Transport

The live wiring layer turns operational config into provider adapters without putting secrets in profiles.

The fetch transport:

- implements `ProviderTransport`
- sends JSON `POST` bodies
- uses `AbortController` for request timeouts
- returns parsed JSON bodies or raw text for non-JSON responses
- records latency for provider traces and retry accounting
- leaves HTTP status mapping, retry, redaction, and cost handling inside the provider adapters

The env loader reads provider config from namespaced environment variables:

```text
RAG_MODEL_PROVIDER=json-chat
RAG_MODEL_MODEL_NAME=answer-model
RAG_MODEL_ENDPOINT=https://provider.example.test/v1/chat
RAG_MODEL_API_KEY_ENV=ANSWER_MODEL_KEY
ANSWER_MODEL_KEY=...

RAG_EMBEDDING_PROVIDER=indexed-embedding
RAG_EMBEDDING_MODEL_NAME=embedding-model
RAG_EMBEDDING_ENDPOINT=https://provider.example.test/v1/embeddings
RAG_EMBEDDING_API_KEY_ENV=EMBEDDING_MODEL_KEY
EMBEDDING_MODEL_KEY=...
RAG_EMBEDDING_DIMENSIONS=1536

RAG_VISUAL_EMBEDDING_PROVIDER=indexed-visual-embedding
RAG_VISUAL_EMBEDDING_MODEL_NAME=visual-embedding-model
RAG_VISUAL_EMBEDDING_ENDPOINT=https://provider.example.test/v1/visual-embeddings
RAG_VISUAL_EMBEDDING_API_KEY_ENV=VISUAL_EMBEDDING_MODEL_KEY
VISUAL_EMBEDDING_MODEL_KEY=...
RAG_VISUAL_EMBEDDING_DIMENSIONS=128

RAG_RERANK_PROVIDER=json-rerank
RAG_RERANK_MODEL_NAME=rerank-model
RAG_RERANK_ENDPOINT=https://provider.example.test/v1/rerank
RAG_RERANK_API_KEY_ENV=RERANK_MODEL_KEY
RERANK_MODEL_KEY=...

RAG_GROUNDING_JUDGE_PROVIDER=json-grounding-judge
RAG_GROUNDING_JUDGE_MODEL_NAME=judge-model
RAG_GROUNDING_JUDGE_ENDPOINT=https://provider.example.test/v1/judge
RAG_GROUNDING_JUDGE_API_KEY_ENV=GROUNDING_JUDGE_MODEL_KEY
GROUNDING_JUDGE_MODEL_KEY=...
```

Provider selection values recognized by `assembleLiveRagRuntimeFromEnv()`:

- model: `json-chat`, `openai`, `openai-compatible`, `anthropic`, `claude`
- embedding: `indexed-embedding`, `openai`, `openai-compatible`
- visual embedding: `indexed-visual-embedding` or another provider name using the same indexed visual response shape
- rerank: `json-rerank`, `openai`, `openai-compatible`, `anthropic`, `claude`
- grounding judge: `json-grounding-judge`, `openai`, `openai-compatible`, `anthropic`, `claude`

Anthropic-specific optional fields:

- `RAG_MODEL_ANTHROPIC_VERSION`
- `RAG_MODEL_ANTHROPIC_BETA`
- `RAG_RERANK_ANTHROPIC_VERSION`
- `RAG_RERANK_ANTHROPIC_BETA`
- `RAG_GROUNDING_JUDGE_ANTHROPIC_VERSION`
- `RAG_GROUNDING_JUDGE_ANTHROPIC_BETA`

Optional per-provider env fields:

- `{PREFIX}_ID`
- `{PREFIX}_TIMEOUT_MS`
- `{PREFIX}_MAX_RETRIES`
- `{PREFIX}_BACKOFF_MS`
- `{PREFIX}_RETRY_STATUS_CODES`
- `{PREFIX}_PROMPT_USD_PER_1K_TOKENS`
- `{PREFIX}_COMPLETION_USD_PER_1K_TOKENS`

Secrets are exposed only through `ProviderAdapterSecrets.apiKeyProvider`. The loaded `ProviderBoundaryConfig` contains provider id, model name, endpoint, retry, timeout, and pricing, but not raw API key values.

Example:

```ts
const rag = assembleLiveRagRuntimeFromEnv({
  profile: ultimateDefaultProfile,
  chunkStore,
  vectorStore,
  env: process.env,
  embedding: "required"
});

const result = await rag.answer({
  question: "What does the policy say?",
  filter
});
```

For tests or custom networking, pass either `transport` or a `fetch` implementation. Passing both is rejected to avoid ambiguous runtime behavior.

## Production Entrypoints + Config

`ProductionRagApp` is the operational shell around the reusable core:

- loads a preset or JSON profile and validates it before startup
- creates memory or durable JSON index storage
- creates configured vector storage: none, memory, durable JSON, or hosted vector stores
- creates configured visual vector storage: none, memory, durable JSON, or hosted visual patch-vector stores
- creates provider adapters from env-backed config, including optional visual embedding adapters
- accepts answer requests through one normalized `answer()` method
- returns a safe response with the answer, citations, evidence summary, warnings, and trace, but not raw retrieved context text

The app config may name secret environment variables, but it does not store secret values. Provider secrets still enter through provider-specific secret providers and are redacted by the provider boundaries.

Common startup env:

```text
RAG_APP_PROFILE_PRESET=generic-docs
RAG_INDEX_KIND=json_file
RAG_INDEX_PATH=.rag/index.json

RAG_VECTOR_KIND=hosted
RAG_VECTOR_VENDOR=qdrant
RAG_VECTOR_ENDPOINT=http://localhost:6333
RAG_VECTOR_COLLECTION=rag_points
RAG_VECTOR_API_KEY_ENV=VECTOR_VENDOR_KEY

RAG_VISUAL_VECTOR_KIND=json_file
RAG_VISUAL_VECTOR_PATH=.rag/visual-vectors.json
RAG_VISUAL_VECTOR_DIMENSIONS=128
# Or use hosted visual patch-vector storage:
# RAG_VISUAL_VECTOR_KIND=hosted
# RAG_VISUAL_VECTOR_VENDOR=qdrant
# RAG_VISUAL_VECTOR_ENDPOINT=http://localhost:6333
# RAG_VISUAL_VECTOR_COLLECTION=rag_visual_points
# RAG_VISUAL_VECTOR_NAME=visual
# RAG_VISUAL_VECTOR_API_KEY_ENV=VISUAL_VECTOR_VENDOR_KEY
RAG_APP_VISUAL_EMBEDDING_MODE=required
RAG_VISUAL_EMBEDDING_PROVIDER=indexed-visual-embedding
RAG_VISUAL_EMBEDDING_MODEL_NAME=visual-embedding-model
RAG_VISUAL_EMBEDDING_ENDPOINT=https://provider.example.test/v1/visual-embeddings
RAG_VISUAL_EMBEDDING_API_KEY_ENV=VISUAL_EMBEDDING_MODEL_KEY
VISUAL_EMBEDDING_MODEL_KEY=...
RAG_VISUAL_EMBEDDING_DIMENSIONS=128

RAG_HTTP_HOST=127.0.0.1
RAG_HTTP_PORT=8787
RAG_HTTP_MAX_BODY_BYTES=131072
RAG_HTTP_AUTH_MODE=required
RAG_HTTP_AUTH_TOKEN_ENV=RAG_HTTP_AUTH_TOKEN
RAG_HTTP_AUTH_TOKEN=replace_me_with_high_entropy_token
RAG_HTTP_RATE_LIMIT_MODE=enabled
RAG_HTTP_RATE_LIMIT_WINDOW_MS=60000
RAG_HTTP_RATE_LIMIT_MAX_REQUESTS=60
RAG_HTTP_LOG_MODE=json
RAG_HTTP_REQUEST_ID_HEADER=x-request-id
RAG_HTTP_READINESS_PATH=/ready
RAG_HTTP_METRICS_PATH=/metrics
```

CLI:

```bash
npm run build
npm run start -- validate-config
npm run start -- validate-config --self-test true
npm run start -- validate-config --self-test true --probe-providers true
node scripts/run-provider-smoke.mjs --env-file .env.smoke --report-dir .rag/provider-smoke/latest
npm run start -- sync --mode delta --tenant-id tenant_1 --namespace-id generic-docs --user-id sync_operator --principal-namespace-id generic-docs
npm run start -- ingest --tenant-id tenant_1 --namespace-id generic-docs --user-id user_1 --principal-namespace-id generic-docs --role reader --source-id curated_docs --overwrite replace
npm run start -- answer --question "What is the refund policy?" --tenant-id tenant_1 --namespace-id generic-docs --user-id user_1 --principal-namespace-id generic-docs
npm run serve
```

`validate-config` is a cheap static health summary. `validate-config --self-test true` runs startup capability checks: profile mode support, required vector/visual components, fixed dimension compatibility, model reranker wiring, and grounding judge wiring. `--probe-providers true` additionally sends small synthetic requests through configured model, embedding, visual embedding, rerank, and grounding-judge providers. `run-provider-smoke.mjs` wraps those probes in a repeatable deployment drill with durable JSON/HTML reports and required-provider gates. Probe output is redacted and reports provider/model identity, statuses, warnings, and counts, not prompt text, context text, bearer tokens, API keys, or raw principal claims.

Production ingestion uses `RAG_LOCAL_FILES_SOURCES_PATH` for profile sources backed by `local-files`. The source config stays outside the profile because file roots, mounted volumes, and adapter secrets are deployment concerns:

```text
RAG_LOCAL_FILES_SOURCES_PATH=/data/local-files.sources.json
```

For profile sources backed by `approved_knowledge_artifact`, point `RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH` at deployment config that references one or more support/review approval ledger JSON files:

```text
RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH=/data/approved-knowledge.sources.json
```

That config loads only each ledger's `approvedArtifacts`. It does not load raw tickets, raw candidates, raw model outputs, or unapproved support events. The approved artifact still has to match the selected profile source, pass body-hash verification, corpus normalization, trust-floor checks, access scope checks, chunking, and index admission.

`ingest` always writes through `IngestPipeline`; it loads enabled selected sources, normalizes records, chunks accepted documents, writes document/chunk stores, and indexes text embeddings only when both a vector store and embedding adapter are configured. When text embeddings run, validated layout relations are also embedded as synthetic relation vectors anchored to accepted chunks. Visual embedding indexing is separate: it only runs when a visual vector store and trusted `VisualEmbeddingAdapter` are configured, either by env-backed `RAG_VISUAL_EMBEDDING_*` provider config or by direct project injection. Only chunks tied to parser/layout visual assets become visual vectors. The command returns counts and operational warnings, not document bodies, chunk text, relation text, bearer tokens, or provider secrets.

For parser-backed local files, the JSON source config may name `parserId` and `parserRequireLayout`, but the actual parser object must be injected from trusted project code:

```ts
const ingestion = createProductionIngestRuntime({
  app,
  config,
  parserExtensions: [
    {
      parser: projectPdfParser
    }
  ]
});
```

The built-in local parser router can also be registered from env:

```bash
export RAG_LOCAL_PARSER_PRESET=best_combined
export RAG_LOCAL_PARSER_ID=best-local-parser
export RAG_DOCLING_PYTHON=.rag/docling-venv/bin/python
export RAG_OPENPYXL_PYTHON=.rag/docling-venv/bin/python
```

Then a local-files source can point at that single parser id:

```json
{
  "sources": [
    {
      "sourceId": "curated_docs",
      "rootDir": "/data/docs",
      "recursive": true,
      "includeExtensions": [".pdf", ".docx", ".xlsx", ".csv", ".png"],
      "parserId": "best-local-parser",
      "parserRequireLayout": true,
      "sourceKind": "local_file",
      "trustTier": "trusted_internal",
      "sensitivity": "internal",
      "accessScope": {
        "tenantId": "tenant_1",
        "namespaceId": "default",
        "roles": ["admin"],
        "tags": ["curated"]
      }
    }
  ]
}
```

Supported `RAG_LOCAL_PARSER_PRESET` values are `best_combined`, `balanced`, `plain_text_first`, `ocr_heavy`, `table_heavy`, `structure_heavy`, and `visual_heavy`.

If a selected local-files source names a parser that was not injected or registered from env, production ingestion fails before filesystem reads. This keeps deployment config declarative while preventing arbitrary env-loaded code execution.

For one-off custom corpus adapters, wrap the production runtime in project code and pass `adapterExtensions` to `createProductionIngestRuntime()` or `runProductionRagCli()`. For company deployments, prefer a compiled `RAG_COMPANY_MODULE_PATH` that exports a `CompanyProfile` and `CompanyAdapterPack`; the CLI validates the pack and injects only the selected use case's adapters and parsers.

HTTP:

```text
GET  /health
GET  /ready
GET  /metrics
POST /answer
```

HTTP `/answer` requires bearer auth plus a principal with explicit tenant and namespace grants. The entrypoint does not synthesize broad access claims for convenience.

The HTTP edge enforces:

- `RAG_HTTP_AUTH_MODE=required` by default for env-loaded production config
- bearer tokens referenced by env name and stored in config as SHA-256 hashes, not raw values
- fixed-window `/answer` rate limiting before request bodies are parsed or model providers are called
- valid calls keyed by token hash, and missing/invalid auth attempts keyed by client IP
- optional `RAG_HTTP_CLIENT_IP_HEADER` only for trusted reverse-proxy deployments

The HTTP operations layer provides:

- `x-request-id` propagation or generation on every response
- redacted JSON access logs when `RAG_HTTP_LOG_MODE=json`
- liveness at `/health`, readiness at `/ready`, and JSON counters at `/metrics`
- graceful CLI shutdown on `SIGINT` and `SIGTERM`; readiness flips false before the listener closes
- access log events for auth denials, rate limits, request errors, and failed answer statuses without raw questions, body text, bearer tokens, or principal claims

## Deployment Packaging

The Docker package runs the same production CLI entrypoint:

```text
node dist/runtime/production-cli.js serve
```

Local production run:

```bash
cp .env.example .env
docker compose --env-file .env up --build
curl http://127.0.0.1:8787/ready
```

Packaging guarantees:

- multi-stage Node 24 image builds TypeScript before runtime
- final image runs as the non-root `rag` user
- compose uses a persistent `/data` volume for durable JSON stores
- compose enables a read-only root filesystem, drops Linux capabilities, and sets `no-new-privileges`
- `.dockerignore` excludes local build output, `node_modules`, `.rag`, and real env files
- `/answer` has bearer auth and rate limiting enabled by default in `.env.example`
- Docker healthchecks use readiness, not liveness, so draining services stop receiving traffic
- `npm run deployment:check` validates the packaging contract in CI

Use `deploy/README.md` for the full startup, hosted-vector, and production-hardening notes.

## Observability Runtime Boundary

The runtime layer is the public answer path for apps that want a complete RAG answer flow.

`RagAnswerRuntime.answer()` runs:

- retrieval
- context building
- grounding gate
- model generation
- draft validation
- run-level trace assembly

The run trace enforces:

- exactly one `RagRunTrace` is returned by each `answer()` call
- every trace event carries the same `runId` and `traceId`
- retrieval, context, answer, generation, and model request ids are linked when those stages exist
- success, refusal, model failure, retrieval failure, context failure, and unexpected generation failure all return a trace
- trace payloads use hashes, ids, counts, statuses, source ids, trust tiers, safety flags, and citation pointers
- trace payloads do not include raw user questions, retrieved chunk text, rendered context, generated answer text, provider failure text, or secrets
- access and retrieval audit helpers are safe to log because they use hashes and counts instead of raw principal claims or query text

The current implementation is `RagAnswerRuntime`, which composes a `Retriever`, `ContextBuilder`, and `GenerationRunner`. `assembleRagRuntime()` is the higher-level factory for projects that want the skeleton to select and wire retrievers from profile config.

Still not implemented:

- vendor-specific database/SaaS client packages such as pg, Supabase, Zendesk, Notion, Google Drive, or Slack clients
- deeper hosted vector operations such as index/collection/schema creation, migrations, bulk import jobs, and vendor-specific SDK clients
- compatibility presets for additional providers beyond generic JSON, OpenAI-compatible, and Anthropic Messages
- TLS termination, Kubernetes/Helm manifests, and cloud-specific deployment modules
