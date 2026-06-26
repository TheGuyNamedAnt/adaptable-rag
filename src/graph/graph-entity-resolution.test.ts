import assert from "node:assert/strict";
import test from "node:test";

import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GraphEntityResolutionRunner, normalizeEntityName } from "./graph-entity-resolution.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";
import { ProposalBackedRagGraphStore } from "./proposal-graph-adapter.js";

test("normalizes common legal suffixes for entity resolution", () => {
  assert.equal(normalizeEntityName("ACME, L.L.C."), "acme");
  assert.equal(normalizeEntityName("Acme Limited Liability Company"), "acme");
  assert.equal(normalizeEntityName("Acme Holdings GmbH"), "acme holdings");
});

test("entity resolution supersedes duplicate entities and rewires relation endpoints", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  const runner = new GraphEntityResolutionRunner({
    graphStore,
    now: () => FIXED_NOW
  });

  const result = runner.resolve({
    filter: makeIndexFilter(),
    runId: "resolution_1",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.rewiredRelationCount, 1);
  assert.deepEqual(result.decisions[0]?.duplicateEntityIds, ["entity_acme_duplicate"]);
  assert.deepEqual(
    graphStore
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => [relation.id, relation.sourceEntityId, relation.targetEntityId]),
    [["relation_duplicate_owns_child", "entity_acme", "entity_child"]]
  );
});

test("proposal-backed retrieval graph hides superseded duplicate entities", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  new GraphEntityResolutionRunner({ graphStore, now: () => FIXED_NOW }).resolve({
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });
  const retrievalGraph = new ProposalBackedRagGraphStore(graphStore);

  assert.deepEqual(
    retrievalGraph.findEntities(["acme"], 10, makeIndexFilter()).map((match) => match.entity.id),
    ["entity_acme"]
  );
});

function makeBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_resolution",
    title: "Resolution memo",
    body: "Acme LLC owns Child LLC. ACME, L.L.C. is the same company."
  });
  const chunk = makeChunks(document)[0];
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

  return {
    id: "batch_resolution",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        id: "entity_acme",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Acme LLC",
        normalizedName: "acme llc",
        confidence: 0.95,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_acme_duplicate",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "ACME, L.L.C.",
        normalizedName: "acme l l c",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      },
      {
        id: "entity_child",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Child LLC",
        normalizedName: "child",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        id: "relation_duplicate_owns_child",
        namespaceId: "test-namespace",
        relationKind: "owns",
        sourceEntityId: "entity_acme_duplicate",
        targetEntityId: "entity_child",
        factStrength: "explicit_fact",
        confidence: 0.9,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        temporal: { observedAt: FIXED_NOW },
        verificationStatus: "supported",
        status: "approved",
        createdAt: FIXED_NOW
      }
    ],
    createdAt: FIXED_NOW
  };
}
