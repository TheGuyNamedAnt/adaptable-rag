import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GraphApprovalRunner } from "./graph-approval.js";
import { GraphEntityResolutionRunner } from "./graph-entity-resolution.js";
import type { GraphExtractionBatch } from "./graph-types.js";
import { JsonFileGraphStore } from "./json-file-graph-store.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

test("persists and reloads graph entities and relations", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-graph-"));
  try {
    const filePath = path.join(directory, "graph.json");
    const first = new JsonFileGraphStore({ filePath, pretty: true });
    const batch = makeBatch();

    first.addExtractionBatch(batch);

    const reloaded = new JsonFileGraphStore({ filePath });

    assert.deepEqual(
      reloaded.findEntities(makeIndexFilter()).map((entity) => entity.id),
      ["entity_parent", "entity_child", "entity_parent_duplicate"]
    );
    assert.deepEqual(
      reloaded
        .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
        .map((relation) => relation.id),
      ["relation_owns", "relation_duplicate_owns"]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists graph approval status updates and relation endpoint rewrites", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-graph-"));
  try {
    const filePath = path.join(directory, "graph.json");
    const store = new JsonFileGraphStore({ filePath });

    store.addExtractionBatch(makeBatch());
    new GraphApprovalRunner({ graphStore: store, now: () => FIXED_NOW }).approve({
      filter: makeIndexFilter(),
      requestedAt: FIXED_NOW
    });
    new GraphEntityResolutionRunner({ graphStore: store, now: () => FIXED_NOW }).resolve({
      filter: makeIndexFilter(),
      requestedAt: FIXED_NOW
    });

    const reloaded = new JsonFileGraphStore({ filePath });

    assert.equal(
      reloaded.findEntities(makeIndexFilter()).find((entity) => entity.id === "entity_parent")
        ?.status,
      "approved"
    );
    assert.equal(
      reloaded
        .findEntities(makeIndexFilter())
        .find((entity) => entity.id === "entity_parent_duplicate")?.status,
      "superseded"
    );
    assert.deepEqual(
      reloaded
        .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
        .map((relation) => [relation.id, relation.sourceEntityId, relation.status]),
      [
        ["relation_owns", "entity_parent", "approved"],
        ["relation_duplicate_owns", "entity_parent", "approved"]
      ]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists graph evidence pruning for deleted source documents", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-graph-"));
  try {
    const filePath = path.join(directory, "graph.json");
    const store = new JsonFileGraphStore({ filePath });

    store.addExtractionBatch(makeBatch());
    const result = store.pruneEvidence({
      filter: makeIndexFilter(),
      documentIds: ["doc_graph_store"]
    });

    const reloaded = new JsonFileGraphStore({ filePath });

    assert.equal(result.removedEvidenceAnchorCount, 5);
    assert.deepEqual(
      reloaded
        .snapshot()
        .entities.map((entity) => [entity.id, entity.status, entity.evidence.length]),
      [
        ["entity_parent", "superseded", 0],
        ["entity_child", "superseded", 0],
        ["entity_parent_duplicate", "superseded", 0]
      ]
    );
    assert.deepEqual(
      reloaded
        .snapshot()
        .relations.map((relation) => [relation.id, relation.status, relation.evidence.length]),
      [
        ["relation_owns", "superseded", 0],
        ["relation_duplicate_owns", "superseded", 0]
      ]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid graph store snapshots before serving reads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-graph-"));
  try {
    const filePath = path.join(directory, "graph.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, entities: {}, relations: [] }), "utf8");

    assert.throws(() => new JsonFileGraphStore({ filePath }), /Invalid graph store snapshot/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_graph_store",
    title: "Graph store memo",
    body: "Parent LLC owns Child LLC. Parent, L.L.C. owns Child LLC."
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
  const baseEntity = {
    namespaceId: "test-namespace",
    kind: "legal_entity" as const,
    confidence: 0.92,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };
  const baseRelation = {
    namespaceId: "test-namespace",
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
    id: "batch_graph_store",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
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
        id: "entity_child",
        name: "Child LLC",
        normalizedName: "child"
      },
      {
        ...baseEntity,
        id: "entity_parent_duplicate",
        name: "Parent, L.L.C.",
        normalizedName: "parent l l c"
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
