import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_NOW, makeChunks, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { GraphApprovalRunner, ThresholdGraphApprovalPolicy } from "./graph-approval.js";
import { JsonlGraphApprovalDecisionLedger } from "./graph-approval-ledger.js";
import type { GraphExtractionBatch, GraphRelationProposal } from "./graph-types.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { ProposalBackedRagGraphStore } from "./proposal-graph-adapter.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

test("graph approval runner approves explicit high-confidence facts and records decisions", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  const runner = new GraphApprovalRunner({
    graphStore,
    now: () => FIXED_NOW
  });

  const result = runner.approve({
    filter: makeIndexFilter(),
    runId: "approval_1",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.runId, "approval_1");
  assert.equal(result.approvedCount, 3);
  assert.equal(result.needsReviewCount, 1);
  assert.equal(result.rejectedCount, 1);
  assert.deepEqual(
    result.decisions.map((decision) => `${decision.target}:${decision.id}:${decision.status}`),
    [
      "entity:entity_parent:approved",
      "entity:entity_child:approved",
      "relation:relation_owns:approved",
      "relation:relation_guarantees:needs_review",
      "relation:relation_unsupported:rejected"
    ]
  );
  assert.equal(
    result.decisions.every(
      (decision) => decision.reason.length > 0 && decision.decidedAt === FIXED_NOW
    ),
    true
  );
});

test("approved graph facts become visible to LightRAG adapter while review facts stay hidden", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  new GraphApprovalRunner({ graphStore, now: () => FIXED_NOW }).approve({
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });
  const retrievalGraph = new ProposalBackedRagGraphStore(graphStore);

  assert.deepEqual(
    graphStore
      .findRelations({ filter: makeIndexFilter(), entityId: "entity_parent" })
      .map((relation) => relation.id),
    ["relation_owns"]
  );
  assert.deepEqual(
    retrievalGraph
      .getOneHopNeighbors("entity_parent", 10, makeIndexFilter())
      .map((neighbor) => neighbor.relationship.id),
    ["relation_owns"]
  );
});

test("graph approval policy can be configured for stricter thresholds", () => {
  const graphStore = new InMemoryGraphStore();
  graphStore.addExtractionBatch(makeBatch());
  const runner = new GraphApprovalRunner({
    graphStore,
    policy: new ThresholdGraphApprovalPolicy({
      entityConfidenceThreshold: 0.99,
      relationConfidenceThreshold: 0.99,
      autoApproveRelationKinds: ["owns"]
    }),
    now: () => FIXED_NOW
  });

  const result = runner.approve({
    filter: makeIndexFilter(),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.approvedCount, 0);
  assert.equal(result.needsReviewCount, 4);
  assert.equal(result.rejectedCount, 1);
});

test("graph approval runner can persist decisions to a JSONL ledger", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "graph-approval-ledger-"));
  try {
    const graphStore = new InMemoryGraphStore();
    graphStore.addExtractionBatch(makeBatch());
    const ledger = new JsonlGraphApprovalDecisionLedger({
      filePath: path.join(tempDir, "approval.jsonl")
    });
    const runner = new GraphApprovalRunner({
      graphStore,
      ledger,
      now: () => FIXED_NOW
    });

    const result = runner.approve({
      filter: makeIndexFilter(),
      runId: "approval_ledger_1",
      requestedAt: FIXED_NOW
    });

    assert.deepEqual(ledger.readAll(), [result]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeBatch(): GraphExtractionBatch {
  const document = makeDocument({
    id: "doc_ownership",
    title: "Ownership memo",
    body: "Parent LLC owns Child LLC."
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
  const baseRelation = {
    namespaceId: "test-namespace",
    sourceEntityId: "entity_parent",
    targetEntityId: "entity_child",
    factStrength: "explicit_fact" as const,
    confidence: 0.91,
    trustTier: "trusted_internal" as const,
    accessScope: chunk.accessScope,
    evidence: [anchor],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "not_checked" as const,
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_approval",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        id: "entity_parent",
        namespaceId: "test-namespace",
        kind: "legal_entity",
        name: "Parent LLC",
        normalizedName: "parent",
        confidence: 0.93,
        trustTier: "trusted_internal",
        accessScope: chunk.accessScope,
        evidence: [anchor],
        status: "proposed",
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
        status: "proposed",
        createdAt: FIXED_NOW
      }
    ],
    relations: [
      {
        ...baseRelation,
        id: "relation_owns",
        relationKind: "owns"
      },
      {
        ...baseRelation,
        id: "relation_guarantees",
        relationKind: "guarantees"
      },
      {
        ...baseRelation,
        id: "relation_unsupported",
        relationKind: "controls",
        verificationStatus: "unsupported"
      }
    ] satisfies readonly GraphRelationProposal[],
    createdAt: FIXED_NOW
  };
}
