import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RagChunk } from "../documents/chunk.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "../graph/graph-extractor.js";
import type { GraphExtractionBatch } from "../graph/graph-types.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import {
  FIXED_NOW,
  TEST_PRINCIPAL,
  makeChunks,
  makeDocument,
  makeIndexedFixture,
  makePrincipal
} from "../test-support/fixtures.js";
import type { ProductionRagAppConfig } from "./production-app.js";
import { createRag } from "./create-rag.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly responses: ProviderHttpResponse[];

  constructor(responses: readonly ProviderHttpResponse[]) {
    this.responses = [...responses];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No mock response configured.");
    }

    return response;
  }
}

test("createRag exposes one local plug-and-play API for answer, agent, ingest, and health", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-create-api-"));
  await writeFile(path.join(tempDir, "guide.md"), "Refund requests require review.", "utf8");
  const fixture = makeIndexedFixture();
  const firstChunk = fixture.chunks[0];
  assert.ok(firstChunk);
  const transport = new MockProviderTransport([
    providerAnswer(firstChunk.id),
    providerAnswer(firstChunk.id)
  ]);
  const rag = createRag({
    config: productionConfig(),
    chunkStore: fixture.index,
    transport,
    env: providerEnv(),
    now: () => FIXED_NOW,
    ingestion: {
      config: {
        localFiles: {
          sources: [
            {
              sourceId: "curated_docs",
              rootDir: tempDir,
              files: ["guide.md"],
              sourceKind: "local_file",
              trustTier: "trusted_internal",
              sensitivity: "internal",
              accessScope: {
                tenantId: TEST_PRINCIPAL.tenantId,
                namespaceId: "test-namespace",
                tags: ["support"]
              }
            }
          ]
        },
        approvedKnowledgeArtifacts: { sources: [] }
      }
    }
  });

  const request = {
    question: "How are refund requests handled?",
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL
  };
  const query = await rag.query(request);
  const inspectStats = rag.inspect.stats();
  const inspectedDocument = rag.inspect.document({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    documentId: fixture.document.id
  });
  const inspectedChunk = rag.inspect.chunk({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    chunkId: firstChunk.id
  });
  const deniedChunk = rag.inspect.chunk({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: makePrincipal({ roles: ["viewer"], tags: ["external"], teamIds: ["other_team"] }),
    chunkId: firstChunk.id
  });
  const inspectedTrace = rag.inspect.trace(query.trace);
  const answer = await rag.answer(request);
  const agent = await rag.agent({ ...request, maxSteps: 1 });
  const ingest = await rag.ingest({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL
  });
  const health = rag.health();

  assert.equal(query.status, "query_succeeded");
  assert.equal(query.retrieval.candidates.length > 0, true);
  assert.equal(query.context.blocks.length > 0, true);
  assert.equal(query.trace.status, "query_succeeded");
  assert.equal(inspectStats.chunkCount, fixture.chunks.length);
  assert.equal(inspectedDocument?.document.id, fixture.document.id);
  assert.equal(inspectedChunk?.chunk.id, firstChunk.id);
  assert.equal(deniedChunk, undefined);
  assert.equal(inspectedTrace.status, "query_succeeded");
  assert.deepEqual(inspectedTrace.retrievedChunkIds, query.trace.retrievedChunkIds);
  assert.equal(answer.status, "succeeded");
  assert.deepEqual(answer.citationChunkIds, [firstChunk.id]);
  assert.equal(agent.status, "succeeded");
  assert.equal(agent.steps.length, 1);
  assert.equal(ingest.status, "completed");
  assert.equal(ingest.counts.documentsAccepted, 1);
  assert.equal(health.status, "ready");
  assert.equal(health.index.chunkCount, fixture.chunks.length + ingest.counts.chunksAccepted);
  assert.equal(transport.requests.length, 2);
});

test("createRag ingest can run knowledge-map ingestion over newly accepted documents and chunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rag-create-api-graph-"));
  await writeFile(path.join(tempDir, "ownership.md"), "Parent LLC owns Child LLC.", "utf8");
  const transport = new MockProviderTransport([]);
  const rag = createRag({
    config: productionConfig(),
    transport,
    env: providerEnv(),
    now: () => FIXED_NOW,
    knowledge: {
      ontology: ownershipGraphOntology,
      extractor: fakeGraphExtractor(),
      autoApprove: true
    },
    ingestion: {
      config: {
        localFiles: {
          sources: [
            {
              sourceId: "curated_docs",
              rootDir: tempDir,
              files: ["ownership.md"],
              sourceKind: "local_file",
              trustTier: "trusted_internal",
              sensitivity: "internal",
              accessScope: {
                tenantId: TEST_PRINCIPAL.tenantId,
                namespaceId: "test-namespace",
                tags: ["support"]
              }
            }
          ]
        },
        approvedKnowledgeArtifacts: { sources: [] }
      }
    }
  });

  const result = await rag.ingest({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    knowledge: { enabled: true }
  });
  const importedChunk = makeChunks(
    makeDocument({
      id: "doc_imported_graph",
      title: "Imported graph fixture",
      body: "Imported Parent LLC controls Imported Child LLC."
    })
  )[0];
  assert.ok(importedChunk);
  const knowledgeQuery = rag.knowledge.query({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    entityId: "entity_parent",
    relationKinds: ["owns"]
  });
  const firstEntityPage = rag.knowledge.pageEntities({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    limit: 1
  });
  assert.equal(typeof firstEntityPage.nextCursor, "string");
  const nextEntityCursor = firstEntityPage.nextCursor;
  assert.ok(nextEntityCursor);
  const secondEntityPage = rag.knowledge.pageEntities({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    limit: 1,
    cursor: nextEntityCursor
  });
  const relationPage = rag.knowledge.pageRelations({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    relationKinds: ["owns"],
    limit: 1
  });
  const importResult = await rag.knowledge.importBatches({
    batches: [makeImportedGraphBatch(importedChunk)],
    importId: "create_rag_graph_import",
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });
  const importedKnowledgeQuery = rag.knowledge.query({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: TEST_PRINCIPAL,
    entityName: "Imported Parent",
    relationKinds: ["controls"]
  });
  const deniedKnowledgeQuery = rag.knowledge.query({
    tenantId: TEST_PRINCIPAL.tenantId,
    namespaceId: "test-namespace",
    principal: makePrincipal({ roles: ["viewer"], tags: ["external"], teamIds: ["other_team"] }),
    entityName: "Parent",
    relationKinds: ["owns"]
  });

  assert.equal(result.status, "completed");
  assert.equal(result.counts.documentsAccepted, 1);
  assert.equal(rag.graph, rag.knowledge);
  assert.equal(result.knowledge, result.graph);
  assert.equal(result.knowledge?.status, "succeeded");
  assert.equal(result.graph?.status, "succeeded");
  assert.equal(result.graph.trace.entityCount, 2);
  assert.equal(result.graph.trace.relationCount, 1);
  assert.equal(result.graph.approval?.approvedCount, 3);
  assert.equal(importResult.status, "succeeded");
  assert.equal(importResult.metrics.completedBatchCount, 1);
  assert.deepEqual(
    knowledgeQuery.entities.map((entity) => entity.name),
    ["Parent LLC"]
  );
  assert.deepEqual(
    knowledgeQuery.relations.map((relation) => relation.id),
    ["relation_parent_owns_child"]
  );
  assert.deepEqual(
    firstEntityPage.entities.map((entity) => entity.id),
    ["entity_child"]
  );
  assert.equal(firstEntityPage.trace.hasNextPage, true);
  assert.deepEqual(
    secondEntityPage.entities.map((entity) => entity.id),
    ["entity_parent"]
  );
  assert.equal(secondEntityPage.trace.hasNextPage, false);
  assert.deepEqual(
    relationPage.relations.map((relation) => relation.id),
    ["relation_parent_owns_child"]
  );
  assert.deepEqual(
    importedKnowledgeQuery.entities.map((entity) => entity.name),
    ["Imported Parent LLC"]
  );
  assert.deepEqual(
    importedKnowledgeQuery.relations.map((relation) => relation.id),
    ["relation_imported_controls_child"]
  );
  assert.equal(relationPage.trace.hasNextPage, false);
  assert.equal(deniedKnowledgeQuery.entities.length, 0);
  assert.equal(deniedKnowledgeQuery.relations.length, 0);
});

function makeImportedGraphBatch(chunk: RagChunk): GraphExtractionBatch {
  const anchor = {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
  const baseEntity = {
    namespaceId: chunk.namespaceId,
    kind: "legal_entity" as const,
    confidence: 0.96,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "approved" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "create_rag_graph_import_batch",
    namespaceId: chunk.namespaceId,
    ontology: ownershipGraphOntology,
    createdAt: FIXED_NOW,
    entities: [
      {
        ...baseEntity,
        id: "entity_imported_parent",
        name: "Imported Parent LLC",
        normalizedName: "imported parent"
      },
      {
        ...baseEntity,
        id: "entity_imported_child",
        name: "Imported Child LLC",
        normalizedName: "imported child"
      }
    ],
    relations: [
      {
        id: "relation_imported_controls_child",
        namespaceId: chunk.namespaceId,
        relationKind: "controls" as const,
        sourceEntityId: "entity_imported_parent",
        targetEntityId: "entity_imported_child",
        factStrength: "explicit_fact" as const,
        confidence: 0.95,
        trustTier: "trusted_internal" as const,
        accessScope: chunk.accessScope,
        evidence: [anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported" as const,
        status: "approved" as const,
        createdAt: FIXED_NOW
      }
    ]
  };
}

function providerEnv(): Readonly<Record<string, string>> {
  return {
    RAG_MODEL_PROVIDER: "json-chat",
    RAG_MODEL_MODEL_NAME: "answer-model",
    RAG_MODEL_ENDPOINT: "https://provider.example.test/v1/chat",
    RAG_MODEL_API_KEY: "model-secret"
  };
}

function providerAnswer(chunkId: string): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body: {
      output_text: JSON.stringify({
        answer: "Refund requests require review.",
        citationChunkIds: [chunkId],
        evidenceSummary: "The cited chunk says refund requests require review.",
        confidence: "high"
      })
    },
    latencyMs: 1
  };
}

function productionConfig(): ProductionRagAppConfig {
  return {
    profile: {
      ...genericDocsProfile,
      namespaceId: "test-namespace"
    },
    storage: {
      index: { kind: "memory" },
      vector: { kind: "none" },
      visualVector: { kind: "none" }
    },
    providers: {
      modelPrefix: "RAG_MODEL",
      embeddingPrefix: "RAG_EMBEDDING",
      visualEmbeddingPrefix: "RAG_VISUAL_EMBEDDING",
      rerankPrefix: "RAG_RERANK",
      groundingJudgePrefix: "RAG_GROUNDING_JUDGE",
      embeddingMode: "disabled",
      visualEmbeddingMode: "disabled",
      rerankProviderMode: "disabled",
      groundingJudgeProviderMode: "disabled"
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 65536,
      auth: {
        mode: "disabled",
        headerName: "authorization",
        tokenSha256s: []
      },
      rateLimit: {
        mode: "disabled",
        windowMs: 60_000,
        maxRequests: 60,
        maxKeys: 100
      },
      operations: {
        logMode: "disabled",
        requestIdHeader: "x-request-id",
        readinessPath: "/ready",
        metricsPath: "/metrics"
      }
    }
  };
}

function fakeGraphExtractor(): GraphExtractor {
  return {
    id: "create-rag-fake-graph-extractor",
    supportedOntologyIds: [ownershipGraphOntology.id],
    async extract(request) {
      const batch = makeGraphBatch(request);
      return successGraphResult(request, batch);
    }
  };
}

function successGraphResult(
  request: GraphExtractionRequest,
  batch: GraphExtractionBatch
): GraphExtractionResult {
  return {
    status: "succeeded",
    batch,
    validationIssues: [],
    trace: buildGraphExtractionTrace({
      request,
      extractionId: request.extractionId ?? "create_rag_extract",
      startedAt: request.requestedAt ?? FIXED_NOW,
      finishedAt: FIXED_NOW,
      status: "succeeded",
      entityCount: batch.entities.length,
      relationCount: batch.relations.length
    })
  };
}

function makeGraphBatch(request: GraphExtractionRequest): GraphExtractionBatch {
  const chunk = request.chunks[0];
  if (!chunk) {
    throw new Error("Fixture requires a chunk.");
  }
  const anchor = {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    quoteHash: chunk.textHash,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
  const baseEntity = {
    namespaceId: request.profile.namespaceId,
    kind: "legal_entity" as const,
    confidence: 0.94,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };
  const baseRelation = {
    namespaceId: request.profile.namespaceId,
    relationKind: "owns" as const,
    sourceEntityId: "entity_parent",
    targetEntityId: "entity_child",
    factStrength: "explicit_fact" as const,
    confidence: 0.93,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "not_checked" as const,
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: request.extractionId ?? "create_rag_extract",
    namespaceId: request.profile.namespaceId,
    ontology: request.ontology,
    createdAt: FIXED_NOW,
    entities: [
      {
        ...baseEntity,
        id: "entity_parent",
        name: "Parent LLC",
        normalizedName: "parent"
      },
      {
        ...baseEntity,
        id: "entity_child",
        name: "Child LLC",
        normalizedName: "child"
      }
    ],
    relations: [
      {
        ...baseRelation,
        id: "relation_parent_owns_child"
      }
    ]
  };
}
