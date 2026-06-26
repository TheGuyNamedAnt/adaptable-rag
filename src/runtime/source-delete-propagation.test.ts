import assert from "node:assert/strict";
import test from "node:test";

import type { RagChunk } from "../documents/chunk.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "../graph/graph-types.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore, type ChunkVector } from "../indexing/vector-store.js";
import {
  InMemoryVisualVectorStore,
  type VisualChunkVector
} from "../indexing/visual-vector-store.js";
import {
  FIXED_NOW,
  makeChunks,
  makeDocument,
  makeIndexFilter,
  TEST_PRINCIPAL
} from "../test-support/fixtures.js";
import { propagateSourceDeletes } from "./source-delete-propagation.js";

test("source delete propagation removes document, chunks, vectors, visual vectors, and knowledge evidence", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_delete_me",
    body: "Parent LLC owns Child LLC. This page is deleted by the source connector."
  });
  const chunks = makeChunks(document);
  index.addDocument(document);
  index.addChunks(document.id, chunks);
  const vectorStore = new InMemoryVectorStore({ chunkStore: index, dimensions: 3 });
  vectorStore.addChunkVectors(chunks.map((chunk) => vectorForChunk(chunk)));
  const visualVectorStore = new InMemoryVisualVectorStore({ chunkStore: index, dimensions: 3 });
  const firstChunk = chunks[0];
  assert.ok(firstChunk);
  visualVectorStore.addVisualChunkVectors([visualVectorForChunk(firstChunk)]);
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(knowledgeBatch(firstChunk));

  const result = await propagateSourceDeletes({
    deleted: [
      {
        sourceItemId: "source_item_deleted",
        recordId: document.id,
        deletedAt: FIXED_NOW
      }
    ],
    filter: makeIndexFilter(),
    documentStore: index,
    chunkStore: index,
    vectorStore,
    visualVectorStore,
    graphStore,
    propagationId: "delete_doc_delete_me",
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.metrics.deletedDocumentCount, 1);
  assert.equal(result.metrics.deletedChunkCount, chunks.length);
  assert.equal(result.metrics.deletedVectorCount, chunks.length);
  assert.equal(result.metrics.deletedVisualVectorCount, 1);
  assert.equal(result.metrics.prunedKnowledgeEntityCount, 2);
  assert.equal(result.metrics.prunedKnowledgeRelationCount, 1);
  assert.equal(result.metrics.prunedKnowledgeEvidenceAnchorCount, 3);
  assert.equal(index.hasDocument(document.id, makeIndexFilter()), false);
  assert.equal(index.findChunks(makeIndexFilter({ documentIds: [document.id] })).length, 0);
  assert.equal(vectorStore.vectorCount(), 0);
  assert.equal(visualVectorStore.visualVectorCount(), 0);
  assert.deepEqual(
    graphStore
      .snapshot()
      .entities.map((entity) => [entity.id, entity.status, entity.evidence.length]),
    [
      ["entity_child", "superseded", 0],
      ["entity_parent", "superseded", 0]
    ]
  );
  assert.deepEqual(
    graphStore
      .snapshot()
      .relations.map((relation) => [relation.id, relation.status, relation.evidence.length]),
    [["rel_parent_owns_child", "superseded", 0]]
  );
});

test("knowledge prune keeps facts with remaining evidence from other documents", () => {
  const graphStore = new InMemoryGraphStore();
  const deletedChunk = makeChunks(makeDocument({ id: "doc_deleted" }))[0];
  const retainedChunk = makeChunks(makeDocument({ id: "doc_retained" }))[0];
  assert.ok(deletedChunk);
  assert.ok(retainedChunk);
  graphStore.addExtractionBatch(
    knowledgeBatch(deletedChunk, {
      relationEvidence: [evidenceAnchor(deletedChunk), evidenceAnchor(retainedChunk)]
    })
  );

  const result = graphStore.pruneEvidence({
    filter: makeIndexFilter(),
    documentIds: ["doc_deleted"]
  });
  const relation = graphStore.snapshot().relations[0];

  assert.equal(result.accepted, true);
  assert.equal(result.removedEvidenceAnchorCount, 3);
  assert.equal(relation?.status, "approved");
  assert.deepEqual(
    relation?.evidence.map((anchor) => anchor.documentId),
    ["doc_retained"]
  );
});

test("source delete propagation skips tombstones without record ids", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });

  const result = await propagateSourceDeletes({
    deleted: [{ sourceItemId: "source_item_without_record", deletedAt: FIXED_NOW }],
    filter: makeIndexFilter(),
    documentStore: index,
    chunkStore: index,
    propagationId: "missing_record_delete",
    requestedAt: FIXED_NOW,
    now: () => FIXED_NOW
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.metrics.skippedDeleteCount, 1);
  assert.equal(result.errors[0]?.code, "missing_record_id");
});

function vectorForChunk(chunk: RagChunk): ChunkVector {
  return {
    id: `vector_${chunk.id}`,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    tenantId: chunk.accessScope.tenantId,
    namespaceId: chunk.namespaceId,
    textHash: chunk.textHash,
    embeddingModel: "test",
    dimensions: 3,
    vector: [1, 0, 0],
    embeddedAt: FIXED_NOW
  };
}

function visualVectorForChunk(chunk: RagChunk): VisualChunkVector {
  return {
    id: `visual_${chunk.id}`,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    tenantId: chunk.accessScope.tenantId,
    namespaceId: chunk.namespaceId,
    textHash: chunk.textHash,
    embeddingModel: "test-visual",
    dimensions: 3,
    vectors: [[1, 0, 0]],
    embeddedAt: FIXED_NOW
  };
}

function knowledgeBatch(
  chunk: RagChunk,
  options: {
    readonly relationEvidence?: GraphRelationProposal["evidence"];
  } = {}
): GraphExtractionBatch {
  return {
    id: `batch_${chunk.documentId}`,
    namespaceId: chunk.namespaceId,
    ontology: ownershipGraphOntology,
    entities: [
      entity("entity_child", "Child LLC", evidenceAnchor(chunk)),
      entity("entity_parent", "Parent LLC", evidenceAnchor(chunk))
    ],
    relations: [
      {
        id: "rel_parent_owns_child",
        namespaceId: chunk.namespaceId,
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.95,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: options.relationEvidence ?? [evidenceAnchor(chunk)],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}

function entity(
  id: string,
  name: string,
  anchor: GraphEntityProposal["evidence"][number]
): GraphEntityProposal {
  return {
    id,
    namespaceId: "test-namespace",
    kind: "legal_entity",
    name,
    normalizedName: name.toLowerCase(),
    confidence: 0.95,
    trustTier: "trusted_internal",
    accessScope: {
      tenantId: TEST_PRINCIPAL.tenantId,
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [anchor],
    status: "approved",
    createdAt: FIXED_NOW
  };
}

function evidenceAnchor(
  chunk: RagChunk
): GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number] {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceId: chunk.provenance.sourceId,
    citation: chunk.citation,
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd
  };
}
