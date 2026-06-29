import assert from "node:assert/strict";
import test from "node:test";

import { makeChunks, makeDocument } from "../test-support/fixtures.js";
import { buildChunkRelationships } from "./chunk-relationships.js";
import { buildRetrievalReadinessReport } from "./retrieval-readiness.js";

test("chunk relationship builder emits bidirectional adjacent chunk links", () => {
  const document = makeDocument({
    id: "doc_relationships",
    body: [
      "Refund definitions and scope for support teams.",
      "Refund approvals require manager review.",
      "Approved refunds must include a support note."
    ].join("\n\n")
  });
  const chunks = makeChunks(document);

  const relationships = buildChunkRelationships({ documents: [document], chunks });

  assert.ok(relationships.some((relationship) => relationship.kind === "next_chunk"));
  assert.ok(relationships.some((relationship) => relationship.kind === "previous_chunk"));
  assert.equal(
    relationships.every((relationship) => relationship.documentId === document.id),
    true
  );
});

test("retrieval readiness report exposes text, connected, vector, visual, and graph coverage", () => {
  const document = makeDocument({
    id: "doc_ready",
    body: [
      "Refund definitions and scope for support teams.",
      "Refund approvals require manager review."
    ].join("\n\n")
  });
  const chunks = makeChunks(document);
  const chunkRelationships = buildChunkRelationships({ documents: [document], chunks });

  const readiness = buildRetrievalReadinessReport({
    ingest: {
      runId: "ingest_ready",
      startedAt: "2026-06-23T00:00:00.000Z",
      finishedAt: "2026-06-23T00:00:00.000Z",
      loadedSourceIds: ["source"],
      documents: [document],
      chunks,
      chunkRelationships,
      rejectedRecords: [],
      normalizationIssues: [],
      adapterWarnings: [],
      parserQuality: {
        documentCount: 1,
        tracedDocumentCount: 1,
        untracedDocumentCount: 0,
        averageSelectedScore: 95,
        lowScoreDocumentCount: 0,
        fallbackSelectedCount: 0,
        visualSelectedForTextLikeDocumentCount: 0,
        failedResultSelectedCount: 0,
        failedAttemptCount: 0,
        rejectedAttemptCount: 0,
        skippedCandidateCount: 0,
        tableStructureMissingCount: 0,
        visualAssetsMissingCount: 0,
        layoutMissingForComplexDocumentCount: 0,
        markdownSelectedForLayoutRiskCount: 0,
        pageTrackedDocumentCount: 0,
        lowPageTextCoverageDocumentCount: 0,
        emptyPageCount: 0,
        warningCount: 0,
        readiness: {
          status: "ready",
          tracedDocumentCount: 1,
          minimumTracedDocumentsForTesting: 1,
          recommendedTracedDocumentsForBaseline: 1,
          message: "Parser quality is ready."
        }
      },
      parserQualityWarnings: [],
      chunkingWarnings: [],
      indexResults: []
    },
    postIngest: {
      status: "succeeded",
      metrics: {
        indexedVectorCount: chunks.length,
        indexedVisualVectorCount: 1,
        knowledgeEntityCount: 2,
        knowledgeRelationCount: 1
      }
    }
  });

  assert.equal(readiness.textIndexReady, true);
  assert.equal(readiness.connectedChunkExpansionReady, true);
  assert.equal(readiness.vectorIndexReady, true);
  assert.equal(readiness.visualIndexReady, true);
  assert.equal(readiness.graphReady, true);
  assert.equal(readiness.warningCodes.length, 0);
});
