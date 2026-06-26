import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { GraphAugmentedRetriever } from "../retrieval/graph-augmented-retriever.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { ProposalBackedRagGraphStore } from "./proposal-graph-adapter.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

test("proposal-backed graph store exposes approved access-visible facts for LightRAG retrieval", async () => {
  const { index, documents, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_parent",
      body: "Parent LLC is described in the ownership memo."
    }),
    makeDocument({
      id: "doc_child",
      body: "Child LLC owns the operating subsidiary."
    }),
    makeDocument({
      id: "doc_private",
      body: "Private board-only ownership memo.",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        tags: ["board_only"]
      }
    })
  ]);
  const proposalStore = new InMemoryGraphStore();
  proposalStore.addExtractionBatch(makeBatch(documents, chunksByDocument));
  const graphStore = new ProposalBackedRagGraphStore(proposalStore);
  const retriever = new GraphAugmentedRetriever({
    baseRetriever: new KeywordRetriever({ chunkStore: index, now: () => FIXED_NOW }),
    graphStore,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "Parent ownership",
    filter: makeIndexFilter(),
    topK: 5,
    mode: "keyword",
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_parent"),
    true
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_child"),
    true
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.chunk.documentId === "doc_private"),
    false
  );
  assert.equal(result.trace.fusionStrategy, "graph_one_hop");
});

test("proposal-backed graph store does not expose proposed relations or denied entities", () => {
  const deniedPrincipal = makePrincipal({ tags: ["support"] });
  const { documents, chunksByDocument } = makeIndex([
    makeDocument({
      id: "doc_parent",
      body: "Parent LLC is described in the ownership memo."
    }),
    makeDocument({
      id: "doc_child",
      body: "Child LLC owns the operating subsidiary."
    }),
    makeDocument({
      id: "doc_private",
      body: "Private Holdings LLC is board-only.",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        tags: ["board_only"]
      }
    })
  ]);
  const proposalStore = new InMemoryGraphStore();
  proposalStore.addExtractionBatch(makeBatch(documents, chunksByDocument));
  const graphStore = new ProposalBackedRagGraphStore(proposalStore);
  const filter = makeIndexFilter({ principal: deniedPrincipal });

  assert.deepEqual(
    graphStore.findEntities(["private"], 5, filter).map((match) => match.entity.id),
    []
  );
  assert.deepEqual(
    graphStore
      .getOneHopNeighbors("entity_parent", 5, filter)
      .map((neighbor) => neighbor.relationship.id),
    ["relation_owns"]
  );
});

function makeIndex(documents: readonly RagDocument[]): {
  readonly index: InMemoryRagIndex;
  readonly documents: readonly RagDocument[];
  readonly chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>;
} {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunksByDocument = new Map<string, readonly { readonly id: string }[]>();

  for (const document of documents) {
    const chunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, chunks);
    chunksByDocument.set(document.id, chunks);
  }

  return { index, documents, chunksByDocument };
}

function makeBatch(
  documents: readonly RagDocument[],
  chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>
): GraphExtractionBatch {
  const documentById = new Map(documents.map((document) => [document.id, document] as const));
  const parentAnchor = makeAnchor(documentById, chunksByDocument, "doc_parent");
  const childAnchor = makeAnchor(documentById, chunksByDocument, "doc_child");
  const privateAnchor = makeAnchor(documentById, chunksByDocument, "doc_private");

  return {
    id: "batch_adapter",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        id: "entity_parent",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Parent LLC",
        normalizedName: "parent",
        confidence: 0.95,
        trustTier: "trusted_internal",
        accessScope: documentById.get("doc_parent")?.accessScope ?? privateAnchor.accessScope,
        evidence: [parentAnchor.anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_child",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child",
        confidence: 0.92,
        trustTier: "trusted_internal",
        accessScope: documentById.get("doc_child")?.accessScope ?? privateAnchor.accessScope,
        evidence: [childAnchor.anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_private",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Private Holdings LLC",
        normalizedName: "private holdings",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: privateAnchor.accessScope,
        evidence: [privateAnchor.anchor],
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_owns",
        namespaceId: "test-namespace",
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.91,
        trustTier: "trusted_internal",
        accessScope: childAnchor.accessScope,
        evidence: [childAnchor.anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "relation_private",
        namespaceId: "test-namespace",
        relationKind: "controls",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_private",
        factStrength: "explicit_fact",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: privateAnchor.accessScope,
        evidence: [privateAnchor.anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "relation_proposed",
        namespaceId: "test-namespace",
        relationKind: "manages",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.8,
        trustTier: "trusted_internal",
        accessScope: childAnchor.accessScope,
        evidence: [childAnchor.anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "not_checked",
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}

function makeAnchor(
  documentById: ReadonlyMap<string, RagDocument>,
  chunksByDocument: ReadonlyMap<string, readonly { readonly id: string }[]>,
  documentId: string
) {
  const document = documentById.get(documentId);
  const chunkId = chunksByDocument.get(documentId)?.[0]?.id;
  if (!document || !chunkId) {
    throw new Error(`Missing fixture document or chunk for ${documentId}.`);
  }

  return {
    accessScope: document.accessScope,
    anchor: {
      chunkId,
      documentId,
      sourceId: document.provenance.sourceId,
      citation: {
        sourceId: document.provenance.sourceId,
        documentId,
        chunkId,
        title: document.title
      }
    }
  };
}
