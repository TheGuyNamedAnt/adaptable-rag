import assert from "node:assert/strict";
import test from "node:test";

import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import {
  FakeVisualEmbeddingAdapter,
  visualVectorsForText
} from "../embeddings/fake-visual-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import type { RagChunk } from "../documents/chunk.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import {
  InMemoryVisualVectorStore,
  type VisualChunkVector
} from "../indexing/visual-vector-store.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile, RetrievalMode } from "../profiles/profile.js";
import {
  FIXED_NOW,
  makeChunks,
  makeDocument,
  makeIndexFilter,
  makeIndexedFixture
} from "../test-support/fixtures.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "../graph/graph-extractor.js";
import type { GraphExtractionBatch } from "../graph/graph-types.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import { assembleRagRuntime } from "./rag-runtime-factory.js";

function profileForMode(mode: RetrievalMode): RagProfile {
  return {
    ...genericDocsProfile,
    namespaceId: "test-namespace",
    retrieval: {
      ...genericDocsProfile.retrieval,
      mode
    }
  };
}

test("runtime factory validates raw profiles and assembles keyword answer flow", async () => {
  const { index } = makeIndexedFixture();
  const assembled = assembleRagRuntime({
    profile: profileForMode("keyword"),
    chunkStore: index,
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });

  const result = await assembled.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(assembled.profile.namespaceId, "test-namespace");
  assert.equal(result.status, "succeeded");
  assert.equal(result.retrieval.trace.mode, "keyword");
  assert.equal(result.retrieval.rerank?.mode, "lightweight");
  assert.equal(typeof result.retrieval.trace.rerankId, "string");
  assert.equal(result.retrieval.trace.adaptiveStrategy?.initialStrategy, "keyword_only");
  assert.equal(result.retrieval.trace.adaptiveStrategy?.finalDecision, "answerable");
  assert.equal(result.trace.profileId, "generic-docs");
});

test("runtime factory rejects invalid raw profiles before creating a runtime", () => {
  const { index } = makeIndexedFixture();
  const invalidProfile = {
    ...profileForMode("keyword"),
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      minimumCitationsForAnswer: 0
    }
  };

  assert.throws(
    () =>
      assembleRagRuntime({
        profile: invalidProfile,
        chunkStore: index,
        model: new FakeModelAdapter({ now: () => FIXED_NOW })
      }),
    /Invalid RAG profile/
  );
});

test("runtime factory requires vector components for vector profiles", () => {
  const { index } = makeIndexedFixture();

  assert.throws(
    () =>
      assembleRagRuntime({
        profile: profileForMode("vector"),
        chunkStore: index,
        model: new FakeModelAdapter({ now: () => FIXED_NOW })
      }),
    /requires embeddingAdapter and vectorStore/
  );
});

test("runtime factory requires visual components for visual profiles", () => {
  const { index } = makeIndexedFixture();

  assert.throws(
    () =>
      assembleRagRuntime({
        profile: profileForMode("visual"),
        chunkStore: index,
        model: new FakeModelAdapter({ now: () => FIXED_NOW })
      }),
    /requires visualEmbeddingAdapter and visualVectorStore/
  );
});

test("runtime factory requires a configured reranker for model rerank profiles", () => {
  const { index } = makeIndexedFixture();
  const modelRerankProfile: RagProfile = {
    ...profileForMode("keyword"),
    retrieval: {
      ...profileForMode("keyword").retrieval,
      rerankMode: "model"
    }
  };

  assert.throws(
    () =>
      assembleRagRuntime({
        profile: modelRerankProfile,
        chunkStore: index,
        model: new FakeModelAdapter({ now: () => FIXED_NOW })
      }),
    /requires a configured model-backed reranker/
  );
});

test("runtime factory assembles visual retrieval from visual components", async () => {
  const { index, chunks } = makeIndexedFixture();
  const visualEmbeddingAdapter = new FakeVisualEmbeddingAdapter({ dimensions: 16 });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: visualEmbeddingAdapter.dimensions,
    now: () => FIXED_NOW
  });
  visualVectorStore.addVisualChunkVectors(
    chunks.map((chunk) => visualVectorForChunk(chunk, visualEmbeddingAdapter.dimensions))
  );

  const assembled = assembleRagRuntime({
    profile: profileForMode("visual"),
    chunkStore: index,
    visualEmbeddingAdapter,
    visualVectorStore,
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });
  const result = await assembled.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.retrieval.trace.mode, "visual");
  assert.equal(assembled.retriever.capabilities.supportsVisualSearch, true);
  assert.equal(assembled.visualEmbeddingAdapter, visualEmbeddingAdapter);
  assert.equal(assembled.visualVectorStore, visualVectorStore);
});

test("runtime factory assembles hybrid retrieval from keyword and vector components", async () => {
  const { index, chunks } = makeIndexedFixture();
  const dimensions = 16;
  const embeddingAdapter = new FakeEmbeddingAdapter({ dimensions });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions,
    now: () => FIXED_NOW
  });
  await new EmbeddingIndexer({
    adapter: embeddingAdapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });

  const assembled = assembleRagRuntime({
    profile: profileForMode("hybrid"),
    chunkStore: index,
    embeddingAdapter,
    vectorStore,
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    now: () => FIXED_NOW
  });
  const result = await assembled.answer({
    question: "What is the refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.retrieval.trace.mode, "hybrid");
  assert.equal(assembled.retriever.capabilities.supportsHybridSearch, true);
  assert.equal(assembled.embeddingAdapter, embeddingAdapter);
  assert.equal(assembled.vectorStore, vectorStore);
});

test("runtime factory can assemble graph-capable answer and agent APIs", async () => {
  const { index } = makeIndexedFixture();
  const assembled = assembleRagRuntime({
    profile: profileForMode("keyword"),
    chunkStore: index,
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    graph: {
      ontology: ownershipGraphOntology
    },
    now: () => FIXED_NOW
  });

  const answer = await assembled.answer({
    question: "Who owns refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });
  const agent = await assembled.agent({
    question: "Who owns refund policy?",
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW,
    maxSteps: 1
  });

  assert.equal(assembled.retriever.capabilities.supportsGraphSearch, true);
  assert.equal(answer.status, "succeeded");
  assert.equal(agent.status, "succeeded");
});

test("runtime factory exposes graph ingestion, approval, and entity resolution helpers", async () => {
  const { index } = makeIndexedFixture();
  const document = makeDocument({
    id: "doc_factory_graph",
    body: "Parent LLC owns Child LLC. Parent, L.L.C. owns Child LLC."
  });
  const chunks = makeChunks(document);
  const assembled = assembleRagRuntime({
    profile: profileForMode("keyword"),
    chunkStore: index,
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    graph: {
      ontology: ownershipGraphOntology,
      extractor: fakeGraphExtractor(),
      autoApprove: true,
      autoResolveEntities: true
    },
    now: () => FIXED_NOW
  });

  const result = await assembled.ingestGraph?.({
    documents: [document],
    chunks,
    approvalFilter: makeIndexFilter(),
    ingestionId: "factory_graph_ingestion",
    requestedAt: FIXED_NOW
  });

  assert.equal(result?.status, "succeeded");
  assert.equal(result.approval?.approvedCount, 5);
  assert.deepEqual(
    assembled.graphStore
      ?.findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => [relation.id, relation.sourceEntityId, relation.status]),
    [
      ["relation_owns", "entity_parent", "approved"],
      ["relation_duplicate_owns", "entity_parent", "approved"]
    ]
  );
});

function visualVectorForChunk(chunk: RagChunk, dimensions: number): VisualChunkVector {
  return {
    id: `visual_${chunk.id}`,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    tenantId: chunk.accessScope.tenantId,
    namespaceId: chunk.namespaceId,
    textHash: chunk.textHash,
    embeddingModel: "test-visual",
    dimensions,
    vectors: visualVectorsForText(chunk.text, dimensions),
    embeddedAt: FIXED_NOW
  };
}

function fakeGraphExtractor(): GraphExtractor {
  return {
    id: "factory-fake-graph-extractor",
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
      extractionId: request.extractionId ?? "factory_extract",
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
    confidence: 0.92,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };
  const baseRelation = {
    namespaceId: request.profile.namespaceId,
    relationKind: "owns" as const,
    targetEntityId: "entity_child",
    factStrength: "explicit_fact" as const,
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "not_checked" as const,
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: request.extractionId ?? "factory_batch",
    namespaceId: request.profile.namespaceId,
    ontology: request.ontology,
    entities: [
      {
        ...baseEntity,
        id: "entity_parent",
        name: "Parent LLC",
        normalizedName: "parent llc",
        confidence: 0.95
      },
      {
        ...baseEntity,
        id: "entity_parent_duplicate",
        name: "Parent, L.L.C.",
        normalizedName: "parent l l c"
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
        id: "relation_owns",
        sourceEntityId: "entity_parent"
      },
      {
        ...baseRelation,
        id: "relation_duplicate_owns",
        sourceEntityId: "entity_parent_duplicate"
      }
    ],
    createdAt: FIXED_NOW
  };
}
