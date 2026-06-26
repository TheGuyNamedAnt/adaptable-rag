import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashText } from "../chunking/hash.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID } from "../corpus/approved-knowledge-artifact-adapter.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { DocumentLayout } from "../documents/layout.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { FakeVisualEmbeddingAdapter } from "../embeddings/fake-visual-embedding-adapter.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { InMemoryVisualVectorStore } from "../indexing/visual-vector-store.js";
import type { DocumentParser, DocumentParseResult } from "../parsing/parser.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { buildRagSupportKnowledgeApprovalLedger } from "../support-bridge/approval-ledger.js";
import { buildRagSupportEventIdempotencyLedger } from "../support-bridge/idempotency-ledger.js";
import { buildRagSupportKnowledgeCandidateQueue } from "../support-bridge/knowledge-candidate-queue.js";
import { buildRagSupportEvent } from "../support-bridge/support-event.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import type { ProductionRagApp, ProductionRagAnswerResponse } from "./production-app.js";
import {
  InMemoryIngestionCheckpointStore,
  InMemoryIngestionJobStore,
  InMemoryIngestionProgressStore
} from "./ingestion-job.js";
import {
  createProductionIngestRuntime,
  IngestionJobRunner,
  loadProductionIngestionConfigFromEnv,
  type ProductionIngestionConfig
} from "./production-ingestion.js";

const profile = assertValidProfile(genericDocsProfile);
const principal = makePrincipal({
  tenantId: "tenant_1",
  namespaceIds: [profile.namespaceId],
  roles: ["admin"],
  tags: ["curated"]
});
const APPROVED_PROFILE_ID = "approved-artifact-profile";
const APPROVED_NAMESPACE_ID = "approved-artifact-namespace";
const APPROVED_SOURCE_ID = "approved_knowledge_approved-artifact-profile";

class StaticProjectAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description = "Static project adapter for production extension tests.";
  readonly records: readonly CorpusRecord[];
  loadCalls = 0;
  lastRequest: CorpusLoadRequest | undefined;

  constructor(id: string, records: readonly CorpusRecord[]) {
    this.id = id;
    this.records = records;
  }

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    this.loadCalls += 1;
    this.lastRequest = request;
    return {
      sourceId: request.source.id,
      records: this.records,
      warnings: []
    };
  }
}

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly responses: readonly ProviderHttpResponse[];

  constructor(responses: readonly ProviderHttpResponse[]) {
    this.responses = responses;
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) {
      throw new Error("No mock provider response configured.");
    }
    return response;
  }
}

test("loads local-files ingestion config from an env path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  const configPath = path.join(tempDir, "local-sources.json");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId: "curated_docs",
          rootDir: "docs",
          recursive: true,
          sourceKind: "local_file",
          trustTier: "trusted_internal",
          sensitivity: "internal",
          accessScope: {
            tenantId: "tenant_1",
            namespaceId: profile.namespaceId,
            roles: ["admin"]
          },
          metadata: {
            owner: "docs"
          }
        }
      ]
    }),
    "utf8"
  );

  const config = loadProductionIngestionConfigFromEnv({
    env: {
      RAG_LOCAL_FILES_SOURCES_PATH: configPath
    },
    cwd: "/"
  });

  assert.equal(config.localFiles.sources[0]?.sourceId, "curated_docs");
  assert.equal(config.localFiles.sources[0]?.rootDir, docsDir);
  assert.deepEqual(config.localFiles.sources[0]?.accessScope?.roles, ["admin"]);
});

test("defaults ingestion config when no local-files env path is provided", () => {
  const config = loadProductionIngestionConfigFromEnv({
    env: {},
    cwd: "/"
  });

  assert.deepEqual(config.localFiles.sources, []);
  assert.deepEqual(config.approvedKnowledgeArtifacts?.sources, []);
});

test("loads approved knowledge artifact ingestion config from approval ledger paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-approved-"));
  const ledger = approvedKnowledgeLedger();
  const artifact = ledger.approvedArtifacts[0];
  assert.ok(artifact);
  const ledgerPath = path.join(tempDir, "approval-ledger.json");
  const configPath = path.join(tempDir, "approved-knowledge.sources.json");
  await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId: APPROVED_SOURCE_ID,
          ledgerPaths: ["approval-ledger.json"],
          artifactIds: [artifact.artifactId],
          pathPrefix: "support-approved",
          metadata: {
            connector: "support-bridge"
          }
        }
      ]
    }),
    "utf8"
  );

  const config = loadProductionIngestionConfigFromEnv({
    env: {
      RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH: configPath
    },
    cwd: "/"
  });

  assert.equal(config.localFiles.sources.length, 0);
  assert.equal(config.approvedKnowledgeArtifacts?.sources[0]?.sourceId, APPROVED_SOURCE_ID);
  assert.equal(
    config.approvedKnowledgeArtifacts?.sources[0]?.artifacts[0]?.artifactId,
    artifact.artifactId
  );
  assert.equal(config.approvedKnowledgeArtifacts?.sources[0]?.pathPrefix, "support-approved");
  assert.equal(
    config.approvedKnowledgeArtifacts?.sources[0]?.metadata?.["connector"],
    "support-bridge"
  );
});

test("rejects invalid local-files source config before filesystem reads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const configPath = path.join(tempDir, "local-sources.json");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId: "curated_docs",
          rootDir: ".",
          sourceKind: "webhook"
        }
      ]
    }),
    "utf8"
  );

  assert.throws(
    () =>
      loadProductionIngestionConfigFromEnv({
        env: {
          RAG_LOCAL_FILES_SOURCES_PATH: configPath
        },
        cwd: tempDir
      }),
    /source kind/u
  );
});

test("rejects duplicate local-files source ids in production config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const configPath = path.join(tempDir, "local-sources.json");
  await writeFile(
    configPath,
    JSON.stringify([
      {
        sourceId: "curated_docs",
        rootDir: "."
      },
      {
        sourceId: "curated_docs",
        rootDir: "."
      }
    ]),
    "utf8"
  );

  assert.throws(
    () =>
      loadProductionIngestionConfigFromEnv({
        env: {
          RAG_LOCAL_FILES_SOURCES_PATH: configPath
        },
        cwd: tempDir
      }),
    /Duplicate/u
  );
});

test("ingests local files through the production runtime and indexes vectors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(
    path.join(docsDir, "policy.md"),
    "Production ingest policy body that must not be echoed in the ingest summary.",
    "utf8"
  );
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions: 64,
    now: () => FIXED_NOW
  });
  const app = fakeApp({
    index,
    vectorStore,
    embeddingAdapter: new FakeEmbeddingAdapter({ dimensions: 64 })
  });
  const jobStore = new InMemoryIngestionJobStore();
  const checkpointStore = new InMemoryIngestionCheckpointStore();
  const progressStore = new InMemoryIngestionProgressStore();
  const ingestion = createProductionIngestRuntime({
    app,
    config: localFilesConfig(docsDir),
    jobStore,
    checkpointStore,
    progressStore,
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    runId: "ingest_prod_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "completed");
  assert.equal(result.runId, "ingest_prod_test");
  assert.deepEqual(result.loadedSourceIds, ["curated_docs"]);
  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(result.vector?.status, "indexed");
  assert.equal(result.vector?.status === "indexed" ? result.vector.vectorCount : 0, 1);
  assert.equal(index.stats().documentCount, 1);
  assert.equal(index.stats().chunkCount, 1);
  assert.equal(JSON.stringify(result).includes("Production ingest policy body"), false);

  const job = await jobStore.get("ingest_prod_test");
  assert.equal(job?.status, "completed");
  assert.equal(job?.stage, "completed");
  assert.deepEqual(job?.sourceIds, ["curated_docs"]);
  assert.deepEqual(job?.counts, result.counts);
  assert.equal(
    (await checkpointStore.list("ingest_prod_test")).some(
      (checkpoint) => checkpoint.stage === "indexing"
    ),
    true
  );
  assert.deepEqual(
    (await progressStore.listSources("ingest_prod_test")).map((source) => source.status),
    ["completed"]
  );
  assert.deepEqual(
    (await progressStore.listDocuments("ingest_prod_test")).map((document) => document.status),
    ["accepted"]
  );

  const retry = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    runId: "ingest_prod_test",
    requestedAt: FIXED_NOW
  });
  assert.equal(retry.status, "completed");
  assert.deepEqual((await jobStore.get("ingest_prod_test"))?.counts, retry.counts);
});

test("IngestionJobRunner runs a production ingestion job directly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-runner-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "runner.md"), "Runner policy content.", "utf8");
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const jobStore = new InMemoryIngestionJobStore();
  const checkpointStore = new InMemoryIngestionCheckpointStore();
  const progressStore = new InMemoryIngestionProgressStore();
  const runner = new IngestionJobRunner({
    app: fakeApp({ index }),
    config: localFilesConfig(docsDir),
    jobStore,
    checkpointStore,
    progressStore,
    now: () => FIXED_NOW
  });

  const result = await runner.run({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    runId: "ingest_runner_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "completed");
  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal((await jobStore.get("ingest_runner_test"))?.status, "completed");
  assert.equal(
    (await checkpointStore.list("ingest_runner_test")).some(
      (checkpoint) => checkpoint.stage === "indexing"
    ),
    true
  );
  assert.deepEqual(
    (await progressStore.listDocuments("ingest_runner_test")).map((document) => document.status),
    ["accepted"]
  );
});

test("production ingestion indexes layout relation vectors when embeddings are configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "ownership.pdf"), new Uint8Array([37, 80, 68, 70]));
  const parsedBody =
    "Figure 1: Ownership chart\n\nThe page two explanation says Parent LLC owns Child LLC.";
  const parser = fixtureParser({
    body: parsedBody,
    layout: relationLayoutForParsedBody(parsedBody)
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const embeddingAdapter = new FakeEmbeddingAdapter({ dimensions: 64 });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions: embeddingAdapter.dimensions,
    now: () => FIXED_NOW
  });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      index,
      vectorStore,
      embeddingAdapter
    }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".pdf"],
      parserId: parser.id,
      parserRequireLayout: true
    }),
    parserExtensions: [{ parser }],
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.vector?.status, "indexed");
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(result.vector?.status === "indexed" ? result.vector.indexedVectorCount : 0, 1);
  assert.equal(result.vector?.status === "indexed" ? result.vector.candidateRelationCount : 0, 2);
  assert.equal(
    result.vector?.status === "indexed" ? result.vector.indexedRelationVectorCount : 0,
    2
  );
  assert.equal(result.vector?.status === "indexed" ? result.vector.vectorCount : 0, 3);
  assert.equal(JSON.stringify(result).includes("Parent LLC owns Child LLC"), false);
});

test("production ingestion uses trusted parser extensions for parser-backed local files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "visual-policy.pdf"), new Uint8Array([37, 80, 68, 70]));
  const parsedBody = "Visual Policy\n\nVisual policy evidence has a page box.";
  const parser = fixtureParser({
    body: parsedBody,
    layout: layoutForParsedBody(parsedBody)
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({ index }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".pdf"],
      parserId: parser.id,
      parserRequireLayout: true
    }),
    parserExtensions: [{ parser }],
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: profile.namespaceId,
      principal
    })
  );

  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(result.counts.recordsRejected, 0);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]?.chunk.citation.layoutRegionIds, ["region_title", "region_body"]);
  assert.equal(chunks[0]?.chunk.citation.boundingBoxes?.length, 2);
  assert.equal(JSON.stringify(result).includes(parsedBody), false);
});

test("production ingestion can register the DeepDoc parser from env", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "ownership.pdf"), new Uint8Array([37, 80, 68, 70]));
  const parsedBody = "Ownership Table\n\nParent LLC | Child LLC";
  const transport = new MockProviderTransport([
    {
      status: 200,
      headers: {},
      body: {
        body: parsedBody,
        layout: layoutForParsedBody(parsedBody, "deepdoc-json")
      },
      latencyMs: 10
    }
  ]);
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({ index }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".pdf"],
      parserId: "deepdoc-json",
      parserRequireLayout: true
    }),
    env: {
      RAG_PARSER_ID: "deepdoc-json",
      RAG_PARSER_PROVIDER: "deepdoc-json",
      RAG_PARSER_MODEL_NAME: "layout-model",
      RAG_PARSER_ENDPOINT: "https://provider.example.invalid/v1/layout",
      RAG_PARSER_API_KEY: "parser-secret"
    },
    parserTransport: transport,
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: profile.namespaceId,
      principal
    })
  );

  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(result.counts.recordsRejected, 0);
  assert.equal(result.counts.adapterWarnings, 0);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer parser-secret");
  assert.equal(chunks[0]?.chunk.citation.layoutRegionIds?.includes("region_title"), true);
  assert.equal(JSON.stringify(result).includes(parsedBody), false);
});

test("production ingestion can register the best combined local parser from env", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "financials.csv"), "Region,Revenue\nNA,120\nEU,90", "utf8");
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({ index }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".csv"],
      parserId: "best-local-parser",
      parserRequireLayout: true
    }),
    env: {
      RAG_LOCAL_PARSER_PRESET: "best_combined"
    },
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: profile.namespaceId,
      principal
    })
  );

  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.recordsRejected, 0);
  assert.equal(result.counts.adapterWarnings, 0);
  assert.equal(result.counts.parserQualityWarnings, 0);
  assert.equal(result.parserQuality.tracedDocumentCount, 1);
  assert.equal(result.parserQuality.averageSelectedScore, 100);
  assert.equal(result.parserQuality.warningCount, 0);
  assert.equal(result.parserQuality.readiness.status, "insufficient");
  assert.equal(result.warnings.parserQuality.length, 0);
  assert.equal(chunks[0]?.chunk.text.includes("NA | 120"), true);
  assert.equal(chunks[0]?.chunk.metadata?.["parserId"], "best-local-parser");
});

test("production ingestion auto-selects local parsers by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "financials.csv"), "Region,Revenue\nNA,120\nEU,90", "utf8");
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({ index }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".csv"]
    }),
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: profile.namespaceId,
      principal
    })
  );

  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.recordsRejected, 0);
  assert.equal(result.counts.adapterWarnings, 0);
  assert.equal(chunks[0]?.chunk.text.includes("NA | 120"), true);
  assert.equal(chunks[0]?.chunk.metadata?.["parserId"], "best-local-parser");
  assert.equal(
    chunks[0]?.chunk.metadata?.["parserRouterSelectedParserId"],
    "delimited-table-parser"
  );
});

test("production ingestion indexes parser-backed visual vectors when configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "visual-policy.pdf"), new Uint8Array([37, 80, 68, 70]));
  const parsedBody = "Visual Policy\n\nVisual policy evidence has a page screenshot.";
  const parser = fixtureParser({
    body: parsedBody,
    layout: layoutForParsedBody(parsedBody)
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const visualEmbeddingAdapter = new FakeVisualEmbeddingAdapter({ dimensions: 16 });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: visualEmbeddingAdapter.dimensions,
    now: () => FIXED_NOW
  });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      index,
      visualEmbeddingAdapter,
      visualVectorStore
    }),
    config: localFilesConfig(docsDir, {
      includeExtensions: [".pdf"],
      parserId: parser.id,
      parserRequireLayout: true
    }),
    parserExtensions: [{ parser }],
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.visualVector?.status, "indexed");
  assert.equal(
    result.visualVector?.status === "indexed" ? result.visualVector.indexedVisualVectorCount : 0,
    1
  );
  assert.equal(
    result.visualVector?.status === "indexed" ? result.visualVector.visualVectorCount : 0,
    1
  );
  assert.equal(result.warnings.visualEmbedding.length, 0);
  assert.equal(JSON.stringify(result).includes(parsedBody), false);
});

test("reports vector skip reasons when embedding is not configured or no chunks are accepted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  await writeFile(path.join(docsDir, "policy.md"), "Vector skip policy body.", "utf8");
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions: 64,
    now: () => FIXED_NOW
  });
  const withoutEmbedding = createProductionIngestRuntime({
    app: fakeApp({
      index,
      vectorStore
    }),
    config: localFilesConfig(docsDir),
    now: () => FIXED_NOW
  });

  const missingEmbeddingResult = await withoutEmbedding.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  assert.equal(missingEmbeddingResult.vector?.status, "skipped");
  assert.equal(
    missingEmbeddingResult.vector?.status === "skipped"
      ? missingEmbeddingResult.vector.reason
      : undefined,
    "embedding_adapter_not_configured"
  );
  assert.equal(
    missingEmbeddingResult.visualVector?.status === "skipped"
      ? missingEmbeddingResult.visualVector.reason
      : undefined,
    "visual_vector_store_not_configured"
  );

  const emptyDir = path.join(tempDir, "empty-docs");
  await mkdir(emptyDir);
  await writeFile(path.join(emptyDir, "empty.md"), "", "utf8");
  const emptyIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const emptyVectorStore = new InMemoryVectorStore({
    chunkStore: emptyIndex,
    dimensions: 64,
    now: () => FIXED_NOW
  });
  const noChunksRuntime = createProductionIngestRuntime({
    app: fakeApp({
      index: emptyIndex,
      vectorStore: emptyVectorStore,
      embeddingAdapter: new FakeEmbeddingAdapter({ dimensions: 64 })
    }),
    config: localFilesConfig(emptyDir),
    now: () => FIXED_NOW
  });

  const noChunksResult = await noChunksRuntime.ingest({
    tenantId: "tenant_1",
    namespaceId: profile.namespaceId,
    principal,
    sourceIds: ["curated_docs"],
    overwriteMode: "replace",
    requestedAt: FIXED_NOW
  });

  assert.equal(noChunksResult.counts.documentsAccepted, 0);
  assert.equal(
    noChunksResult.vector?.status === "skipped" ? noChunksResult.vector.reason : undefined,
    "no_chunks"
  );
});

test("ingests registered project adapters through the production extension boundary", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const projectProfile = profileWithProjectAdapter();
  const projectPrincipal = {
    ...principal,
    namespaceIds: [projectProfile.namespaceId],
    tags: ["project"]
  };
  const adapter = new StaticProjectAdapter("custom-api", [
    projectRecord({
      sourceId: "custom_docs",
      body: "Project adapter body that must not be echoed from ingest summaries.",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: projectProfile.namespaceId,
        tags: ["project"]
      }
    })
  ]);
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      index,
      profileOverride: projectProfile
    }),
    adapterExtensions: [{ adapter }],
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: projectProfile.namespaceId,
    principal: projectPrincipal,
    sourceIds: ["custom_docs"],
    requestedAt: FIXED_NOW
  });

  assert.equal(adapter.loadCalls, 1);
  assert.equal(adapter.lastRequest?.source.adapter, "custom-api");
  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(index.stats().documentCount, 1);
  assert.equal(JSON.stringify(result).includes("Project adapter body"), false);
});

test("ingests approved knowledge ledgers through the production runtime", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-approved-"));
  const ledger = approvedKnowledgeLedger();
  const artifact = ledger.approvedArtifacts[0];
  assert.ok(artifact);
  const ledgerPath = path.join(tempDir, "approval-ledger.json");
  const configPath = path.join(tempDir, "approved-knowledge.sources.json");
  await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      sources: [
        {
          sourceId: APPROVED_SOURCE_ID,
          ledgerPath: "approval-ledger.json"
        }
      ]
    }),
    "utf8"
  );
  const approvedProfile = approvedArtifactProfile();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const config = loadProductionIngestionConfigFromEnv({
    env: {
      RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH: configPath
    },
    cwd: "/"
  });
  const approvedPrincipal = makePrincipal({
    tenantId: "tenant_1",
    namespaceIds: [approvedProfile.namespaceId],
    tags: ["approved-knowledge", "known_issue_candidate", "customer_safe"]
  });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      index,
      profileOverride: approvedProfile
    }),
    config,
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: approvedProfile.namespaceId,
    principal: approvedPrincipal,
    sourceIds: [APPROVED_SOURCE_ID],
    overwriteMode: "replace",
    runId: "approved_knowledge_ingest_test",
    requestedAt: FIXED_NOW
  });
  const chunks = index.findChunks(
    makeIndexFilter({
      tenantId: "tenant_1",
      namespaceId: approvedProfile.namespaceId,
      principal: approvedPrincipal
    })
  );

  assert.equal(result.runId, "approved_knowledge_ingest_test");
  assert.deepEqual(result.loadedSourceIds, [APPROVED_SOURCE_ID]);
  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(result.counts.chunksAccepted, 1);
  assert.equal(result.counts.recordsRejected, 0);
  assert.equal(result.counts.adapterWarnings, 0);
  assert.equal(result.counts.normalizationIssues, 0);
  assert.equal(index.stats().documentCount, 1);
  assert.equal(index.stats().chunkCount, 1);
  assert.equal(chunks.length, 1);
  assert.equal(JSON.stringify(result).includes(artifact.body), false);
});

test("project adapter output still passes corpus normalization before indexing", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const projectProfile = profileWithProjectAdapter();
  const adapter = new StaticProjectAdapter("custom-api", [
    projectRecord({
      sourceId: "custom_docs",
      accessScope: {
        tenantId: "tenant_2",
        namespaceId: projectProfile.namespaceId,
        tags: ["project"]
      }
    })
  ]);
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      index,
      profileOverride: projectProfile
    }),
    adapterExtensions: [{ adapter }],
    now: () => FIXED_NOW
  });

  const result = await ingestion.ingest({
    tenantId: "tenant_1",
    namespaceId: projectProfile.namespaceId,
    principal: {
      ...principal,
      namespaceIds: [projectProfile.namespaceId],
      tags: ["project"]
    },
    sourceIds: ["custom_docs"],
    requestedAt: FIXED_NOW
  });

  assert.equal(result.counts.documentsAccepted, 0);
  assert.equal(result.counts.recordsRejected, 1);
  assert.equal(result.counts.normalizationIssues > 0, true);
  assert.equal(index.stats().documentCount, 0);
});

test("fails fast when selected local-files sources have no production config", async () => {
  const ingestion = createProductionIngestRuntime({
    app: fakeApp(),
    config: {
      localFiles: {
        sources: []
      }
    },
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        principal,
        sourceIds: ["curated_docs"],
        requestedAt: FIXED_NOW
      }),
    /missing config/u
  );
});

test("fails fast when selected approved knowledge sources have no production config", async () => {
  const approvedProfile = approvedArtifactProfile();
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      profileOverride: approvedProfile
    }),
    config: {
      localFiles: {
        sources: []
      },
      approvedKnowledgeArtifacts: {
        sources: []
      }
    },
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: approvedProfile.namespaceId,
        principal: makePrincipal({
          tenantId: "tenant_1",
          namespaceIds: [approvedProfile.namespaceId]
        }),
        sourceIds: [APPROVED_SOURCE_ID],
        requestedAt: FIXED_NOW
      }),
    /approved knowledge source ids/u
  );
});

test("fails fast when project adapters are missing, duplicated, or override built-ins", async () => {
  const projectProfile = profileWithProjectAdapter();

  await assert.rejects(
    () =>
      createProductionIngestRuntime({
        app: fakeApp({
          profileOverride: projectProfile
        }),
        now: () => FIXED_NOW
      }).ingest({
        tenantId: "tenant_1",
        namespaceId: projectProfile.namespaceId,
        principal: {
          ...principal,
          namespaceIds: [projectProfile.namespaceId]
        },
        sourceIds: ["custom_docs"],
        requestedAt: FIXED_NOW
      }),
    /not registered/u
  );

  assert.throws(
    () =>
      createProductionIngestRuntime({
        app: fakeApp(),
        adapterExtensions: [
          { adapter: new StaticProjectAdapter("custom-api", []) },
          { adapter: new StaticProjectAdapter("custom-api", []) }
        ]
      }),
    /Duplicate adapter extension/u
  );

  assert.throws(
    () =>
      createProductionIngestRuntime({
        app: fakeApp(),
        adapterExtensions: [{ adapter: new StaticProjectAdapter("local-files", []) }]
      }),
    /cannot override/u
  );
});

test("fails fast when parser-backed production sources lack trusted parser extensions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-production-ingest-"));
  const docsDir = path.join(tempDir, "docs");
  await mkdir(docsDir);
  const parser = fixtureParser({
    body: "Parsed body.",
    layout: layoutForParsedBody("Parsed body.")
  });

  await assert.rejects(
    () =>
      createProductionIngestRuntime({
        app: fakeApp(),
        config: localFilesConfig(docsDir, {
          includeExtensions: [".pdf"],
          parserId: parser.id,
          parserRequireLayout: true
        }),
        now: () => FIXED_NOW
      }).ingest({
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        principal,
        sourceIds: ["curated_docs"],
        requestedAt: FIXED_NOW
      }),
    /parser ids/u
  );

  assert.throws(
    () =>
      createProductionIngestRuntime({
        app: fakeApp(),
        parserExtensions: [{ parser }, { parser }]
      }),
    /Duplicate parser extension/u
  );
});

test("rejects unsafe production ingest requests before loading adapters", async () => {
  const ingestion = createProductionIngestRuntime({
    app: fakeApp(),
    config: localFilesConfig(process.cwd()),
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        principal: {
          ...principal,
          tenantId: "tenant_2"
        },
        sourceIds: ["curated_docs"],
        requestedAt: FIXED_NOW
      }),
    /must match/u
  );

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        principal,
        sourceIds: ["missing_source"],
        requestedAt: FIXED_NOW
      }),
    /Unknown or disabled/u
  );

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: profile.namespaceId,
        principal,
        sourceIds: ["curated_docs"],
        overwriteMode: "merge" as "replace",
        requestedAt: FIXED_NOW
      }),
    /overwriteMode/u
  );
});

test("fails fast for corpus adapters not supported by the production entrypoint", async () => {
  const unsupportedProfile = assertValidProfile({
    ...genericDocsProfile,
    corpusSources: [
      {
        ...genericDocsProfile.corpusSources[0]!,
        adapter: "database"
      }
    ]
  });
  const ingestion = createProductionIngestRuntime({
    app: fakeApp({
      profileOverride: unsupportedProfile
    }),
    config: localFilesConfig(process.cwd()),
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      ingestion.ingest({
        tenantId: "tenant_1",
        namespaceId: unsupportedProfile.namespaceId,
        principal: {
          ...principal,
          namespaceIds: [unsupportedProfile.namespaceId]
        },
        requestedAt: FIXED_NOW
      }),
    /not registered/u
  );
});

function localFilesConfig(
  rootDir: string,
  overrides: Partial<ProductionIngestionConfig["localFiles"]["sources"][number]> = {}
): ProductionIngestionConfig {
  return {
    localFiles: {
      sources: [
        {
          sourceId: "curated_docs",
          rootDir,
          recursive: true,
          includeExtensions: [".md"],
          sourceKind: "local_file",
          trustTier: "trusted_internal",
          sensitivity: "internal",
          accessScope: {
            tenantId: "tenant_1",
            namespaceId: profile.namespaceId,
            roles: ["admin"],
            tags: ["curated"]
          },
          ...overrides
        }
      ]
    }
  };
}

function fixtureParser(options: {
  readonly body: string;
  readonly layout?: DocumentLayout;
}): DocumentParser {
  return {
    id: "fixture-pdf-parser",
    description: "Fixture PDF parser for production ingestion tests.",
    version: "1.0.0",
    capabilities: {
      inputMode: "binary",
      emitsLayout: options.layout !== undefined,
      emitsTables: false,
      emitsVisualAssets: (options.layout?.visualAssets?.length ?? 0) > 0,
      supportedContentTypes: ["application/pdf"]
    },
    async parse(request): Promise<DocumentParseResult> {
      assert.ok(request.bytes);
      return {
        sourceId: request.sourceId,
        parserId: "fixture-pdf-parser",
        parserVersion: "1.0.0",
        document: {
          body: options.body,
          ...(options.layout ? { layout: options.layout } : {})
        },
        warnings: []
      };
    }
  };
}

function layoutForParsedBody(body: string, parserId = "fixture-pdf-parser"): DocumentLayout {
  const titleEnd = body.includes("\n\n") ? body.indexOf("\n\n") : body.length;
  const bodyStart = titleEnd === body.length ? 0 : titleEnd + 2;
  return {
    parserId,
    parserVersion: "1.0.0",
    strategy: "ocr_layout",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "region_title",
        kind: "title",
        pageNumber: 1,
        text: body.slice(0, titleEnd),
        characterStart: 0,
        characterEnd: titleEnd,
        box: {
          pageNumber: 1,
          x: 40,
          y: 40,
          width: 300,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_body",
        kind: "paragraph",
        pageNumber: 1,
        text: body.slice(bodyStart),
        characterStart: bodyStart,
        characterEnd: body.length,
        box: {
          pageNumber: 1,
          x: 40,
          y: 90,
          width: 400,
          height: 80,
          unit: "point"
        }
      }
    ],
    visualAssets: [
      {
        id: "page_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/rag-fixture-page-1.png"
      }
    ]
  };
}

function relationLayoutForParsedBody(body: string): DocumentLayout {
  const caption = "Figure 1: Ownership chart";
  const explanation = "The page two explanation says Parent LLC owns Child LLC.";
  const explanationStart = body.indexOf(explanation);

  return {
    parserId: "fixture-pdf-parser",
    parserVersion: "1.0.0",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      },
      {
        pageNumber: 2,
        width: 600,
        height: 800,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "region_caption",
        kind: "figure_caption",
        pageNumber: 1,
        text: caption,
        characterStart: 0,
        characterEnd: caption.length,
        box: {
          pageNumber: 1,
          x: 40,
          y: 500,
          width: 360,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_figure",
        kind: "figure",
        pageNumber: 1,
        box: {
          pageNumber: 1,
          x: 40,
          y: 120,
          width: 420,
          height: 360,
          unit: "point"
        }
      },
      {
        id: "region_explanation",
        kind: "paragraph",
        pageNumber: 2,
        text: explanation,
        characterStart: explanationStart,
        characterEnd: explanationStart + explanation.length,
        box: {
          pageNumber: 2,
          x: 40,
          y: 90,
          width: 420,
          height: 80,
          unit: "point"
        }
      }
    ],
    relations: [
      {
        id: "relation_caption_for_figure",
        kind: "caption_for",
        fromRegionId: "region_caption",
        toRegionId: "region_figure"
      },
      {
        id: "relation_explains_figure",
        kind: "explains",
        fromRegionId: "region_explanation",
        toRegionId: "region_figure"
      }
    ],
    visualAssets: [
      {
        id: "page_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/page-1.png"
      }
    ]
  };
}

function profileWithProjectAdapter(): typeof profile {
  return assertValidProfile({
    ...genericDocsProfile,
    corpusSources: [
      {
        id: "custom_docs",
        adapter: "custom-api",
        description: "Project-owned API adapter source.",
        enabled: true,
        trustTierFloor: "trusted_internal",
        tags: ["project"]
      }
    ]
  });
}

function approvedArtifactProfile(): ValidatedRagProfile {
  return assertValidProfile({
    ...genericDocsProfile,
    id: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
    corpusSources: [
      {
        id: APPROVED_SOURCE_ID,
        adapter: APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
        description: "Human-approved support knowledge artifacts.",
        enabled: true,
        trustTierFloor: "generated_or_derived",
        tags: ["approved-knowledge"]
      }
    ],
    trustPolicy: {
      ...genericDocsProfile.trustPolicy,
      allowedTrustTiers: [
        ...genericDocsProfile.trustPolicy.allowedTrustTiers,
        "generated_or_derived"
      ],
      minimumAnswerTrustTier: "generated_or_derived"
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: [
        ...genericDocsProfile.citationPolicy.allowedSourceKindsForCitations,
        "derived_summary"
      ]
    },
    evals: {
      goldenSetPath: "profiles/approved-artifact/evals/golden.jsonl",
      adversarialSetPath: "profiles/approved-artifact/evals/adversarial.jsonl",
      requiredChecks: genericDocsProfile.evals.requiredChecks
    }
  });
}

function approvedKnowledgeLedger() {
  const event = buildRagSupportEvent({
    eventId: "support_event_known_issue",
    sourceSystem: "admin_support",
    sourceEventId: "ticket_123:known_issue_signal",
    sourceTicketId: "ticket_123",
    runId: "run_ticket_123",
    traceId: "trace_ticket_123",
    profileId: APPROVED_PROFILE_ID,
    namespaceId: APPROVED_NAMESPACE_ID,
    eventType: "known_issue_candidate_created",
    occurredAt: FIXED_NOW,
    summary: "Support ticket indicates a possible known issue.",
    evidenceRefs: [
      {
        refId: "artifact_ticket_123",
        kind: "ticket",
        sourceSystem: "admin_support",
        artifactPath: "support/artifacts/ticket_123.json",
        ticketId: "ticket_123",
        runId: "run_ticket_123",
        traceId: "trace_ticket_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a known issue candidate from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: FIXED_NOW,
    events: [event]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: FIXED_NOW,
    events: [event],
    ledger
  });
  const candidate = queue.candidates[0];
  assert.ok(candidate);

  return buildRagSupportKnowledgeApprovalLedger({
    generatedAt: FIXED_NOW,
    queue,
    decisions: [
      {
        decisionId: "approval_decision_1",
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "reviewer_1",
        summary: "Approved known issue wording for production ingestion.",
        approvedTitle: "Blocking failure known issue",
        approvedBody:
          "Approved production knowledge says the blocking failure is known and engineering is investigating a fix. Support can tell customers that updates will be shared after the fix is confirmed.",
        visibility: "customer_safe",
        reasonCodes: ["confirmed_by_engineering"]
      }
    ]
  });
}

function projectRecord(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  const body = overrides.body ?? "Project adapter record.";

  return {
    id: overrides.id ?? "project_doc",
    sourceId: overrides.sourceId ?? "custom_docs",
    sourceKind: overrides.sourceKind ?? "api_response",
    title: overrides.title ?? "Project Adapter Doc",
    body,
    trustTier: overrides.trustTier ?? "trusted_internal",
    sensitivity: overrides.sensitivity ?? "internal",
    accessScope: overrides.accessScope ?? {
      tenantId: "tenant_1",
      namespaceId: profile.namespaceId,
      tags: ["project"]
    },
    capturedAt: overrides.capturedAt ?? FIXED_NOW,
    checksum: overrides.checksum ?? hashText(body),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}

function fakeApp(
  options: {
    readonly index?: InMemoryRagIndex;
    readonly vectorStore?: InMemoryVectorStore;
    readonly embeddingAdapter?: FakeEmbeddingAdapter;
    readonly visualVectorStore?: InMemoryVisualVectorStore;
    readonly visualEmbeddingAdapter?: FakeVisualEmbeddingAdapter;
    readonly profileOverride?: ValidatedRagProfile;
  } = {}
): ProductionRagApp {
  const index = options.index ?? new InMemoryRagIndex({ now: () => FIXED_NOW });
  const appProfile = options.profileOverride ?? profile;

  return {
    config: {} as ProductionRagApp["config"],
    profile: appProfile,
    chunkStore: index,
    ...(options.vectorStore === undefined ? {} : { vectorStore: options.vectorStore }),
    ...(options.visualVectorStore === undefined
      ? {}
      : { visualVectorStore: options.visualVectorStore }),
    ...(options.visualEmbeddingAdapter === undefined
      ? {}
      : { visualEmbeddingAdapter: options.visualEmbeddingAdapter }),
    runtime: {
      providerAdapters: {
        ...(options.embeddingAdapter === undefined
          ? {}
          : { embeddingAdapter: options.embeddingAdapter })
      }
    } as unknown as ProductionRagApp["runtime"],
    answer: async (): Promise<ProductionRagAnswerResponse> =>
      ({
        status: "refused",
        trace: {}
      }) as ProductionRagAnswerResponse,
    health: () => ({
      status: "ready",
      profileId: appProfile.id,
      namespaceId: appProfile.namespaceId,
      retrievalMode: appProfile.retrieval.mode,
      index: {
        storageKind: "memory",
        durable: false,
        documentCount: index.stats().documentCount,
        chunkCount: index.stats().chunkCount
      },
      providers: {
        model: {
          id: "fake",
          provider: "fake",
          modelName: "fake"
        }
      }
    }),
    selfTest: async () => ({
      status: "passed",
      checkedAt: FIXED_NOW,
      profileId: appProfile.id,
      namespaceId: appProfile.namespaceId,
      retrievalMode: appProfile.retrieval.mode,
      probeProviders: false,
      checkCount: 0,
      failedCount: 0,
      skippedCount: 0,
      checks: []
    })
  };
}
