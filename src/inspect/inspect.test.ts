import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { ContextBuildResult } from "../context/context-types.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagEvalRunSummary } from "../evals/eval-types.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type { RagRunTrace } from "../observability/trace.js";
import {
  InMemoryIngestionCheckpointStore,
  InMemoryIngestionJobStore,
  InMemoryIngestionProgressStore
} from "../runtime/ingestion-job.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import {
  inspectCitation,
  inspectEvalFailure,
  inspectIngestionRun,
  inspectRetrieval,
  inspectSourceHealth,
  inspectTrace
} from "./inspect.js";
import type { RetrievalResult } from "../retrieval/retrieval-types.js";

const indexedChunk = makePolicyChunk();

test("inspectIngestionRun returns job checkpoints and failed document rollups", async () => {
  const jobStore = new InMemoryIngestionJobStore();
  const checkpointStore = new InMemoryIngestionCheckpointStore();
  const progressStore = new InMemoryIngestionProgressStore();
  await jobStore.create({
    jobId: "job_1",
    runId: "run_1",
    tenantId: "tenant_1",
    namespaceId: "namespace_1",
    sourceIds: ["source_policy"],
    requestedAt: FIXED_NOW
  });
  await jobStore.update({
    jobId: "job_1",
    status: "completed_with_warnings",
    stage: "completed_with_warnings",
    updatedAt: FIXED_NOW
  });
  await checkpointStore.save({
    jobId: "job_1",
    stage: "chunking",
    checkpoint: { phase: "chunking_started", documentId: "doc_policy" },
    recordedAt: FIXED_NOW
  });
  await checkpointStore.save({
    jobId: "job_1",
    stage: "indexing",
    checkpoint: { phase: "document_indexed", documentId: "doc_policy" },
    recordedAt: FIXED_NOW
  });
  await progressStore.updateSource({
    jobId: "job_1",
    sourceId: "source_policy",
    status: "completed",
    acceptedDocumentCount: 1,
    failedDocumentCount: 1,
    skippedDocumentCount: 1,
    updatedAt: FIXED_NOW
  });
  await progressStore.updateDocument({
    jobId: "job_1",
    sourceId: "source_policy",
    documentId: "doc_policy",
    status: "accepted",
    chunkCount: 1,
    updatedAt: FIXED_NOW
  });
  await progressStore.updateDocument({
    jobId: "job_1",
    sourceId: "source_policy",
    documentId: "doc_failed",
    status: "failed",
    retryable: true,
    failureStage: "parsing",
    failurePhase: "parser_timeout",
    errorMessage: "Parser timed out.",
    updatedAt: FIXED_NOW
  });
  await progressStore.updateDocument({
    jobId: "job_1",
    sourceId: "source_policy",
    documentId: "doc_skipped",
    status: "skipped",
    updatedAt: FIXED_NOW
  });

  const inspected = await inspectIngestionRun({
    jobId: "job_1",
    jobStore,
    checkpointStore,
    progressStore
  });

  assert.equal(inspected.job?.status, "completed_with_warnings");
  assert.equal(inspected.summary.status, "completed_with_warnings");
  assert.equal(inspected.summary.currentCheckpointPhase, "document_indexed");
  assert.equal(inspected.latestCheckpoint?.stage, "indexing");
  assert.equal(inspected.counts.checkpointCount, 2);
  assert.equal(inspected.counts.failedDocumentCount, 1);
  assert.equal(inspected.counts.skippedDocumentCount, 1);
  assert.equal(inspected.counts.acceptedDocumentCount, 1);
  assert.equal(inspected.counts.retryableFailureCount, 1);
  assert.equal(inspected.failedDocuments[0]?.documentId, "doc_failed");
  assert.equal(inspected.failedDocuments[0]?.failureStage, "parsing");
  assert.equal(inspected.failedDocuments[0]?.failurePhase, "parser_timeout");

  const failedPage = await inspectIngestionRun({
    jobId: "job_1",
    jobStore,
    checkpointStore,
    progressStore,
    documentStatuses: ["failed"],
    checkpointLimit: 1,
    documentLimit: 1
  });

  assert.equal(failedPage.checkpoints.length, 1);
  assert.equal(failedPage.documents.length, 1);
  assert.equal(failedPage.documents[0]?.documentId, "doc_failed");
  assert.equal(failedPage.page.checkpointHasMore, true);
  assert.equal(failedPage.page.documentHasMore, false);
  assert.deepEqual(failedPage.page.documentStatuses, ["failed"]);
});

test("inspectIngestionRun fails clearly for missing jobs", async () => {
  const jobStore = new InMemoryIngestionJobStore();

  await assert.rejects(
    () =>
      inspectIngestionRun({
        jobId: "missing_job",
        jobStore
      }),
    /Ingestion job "missing_job" was not found/
  );
});

test("inspectSourceHealth classifies failed source progress", async () => {
  const progressStore = new InMemoryIngestionProgressStore();
  await progressStore.updateSource({
    jobId: "job_1",
    sourceId: "source_policy",
    status: "completed",
    loadedDocumentCount: 3,
    acceptedDocumentCount: 2,
    failedDocumentCount: 1,
    skippedDocumentCount: 0,
    updatedAt: FIXED_NOW
  });

  const inspected = await inspectSourceHealth({ jobId: "job_1", progressStore });

  assert.equal(inspected.sources[0]?.health, "failed");
  assert.equal(inspected.sources[0]?.loadedDocumentCount, 3);
});

test("inspectTrace summarizes trace IDs, events, and citation chunks", () => {
  const inspected = inspectTrace(traceFixture());

  assert.equal(inspected.traceId, "trace_1");
  assert.deepEqual(inspected.finalCitationChunkIds, [indexedChunk.id]);
  assert.deepEqual(inspected.eventKinds, ["run_started", "chunk_retrieved"]);
  assert.deepEqual(inspected.events[1]?.dataKeys, ["chunkId"]);
});

test("inspectRetrieval exposes candidates and rejections without raw chunk text", () => {
  const inspected = inspectRetrieval(retrievalFixture());

  assert.equal(inspected.retrievalId, "retrieval_1");
  assert.equal(inspected.candidates[0]?.chunkId, indexedChunk.id);
  assert.equal(inspected.candidates[0]?.sourceId, "source_policy");
  assert.equal(inspected.candidates[0]?.matchedTermCount, 2);
  assert.equal(inspected.rejected[0]?.code, "access_denied_or_missing_chunk");
  assert.ok(!("text" in inspected.candidates[0]!));
});

test("inspectCitation joins trace, context, and retrieval citation chain", () => {
  const inspected = inspectCitation({
    trace: traceFixture(),
    retrieval: retrievalFixture(),
    context: contextFixture()
  });

  assert.equal(inspected.citations[0]?.chunkId, indexedChunk.id);
  assert.equal(inspected.citations[0]?.finalCitation, true);
  assert.equal(inspected.citations[0]?.contextBlockIndex, 0);
  assert.equal(inspected.citations[0]?.retrievalRank, 1);
  assert.equal(inspected.rejected[0]?.code, "stale_source");
});

test("inspectEvalFailure lists failed cases and selected passing cases", () => {
  const summary = evalSummaryFixture();

  const failures = inspectEvalFailure({ summary });
  assert.equal(failures.failureCount, 1);
  assert.equal(failures.cases[0]?.caseId, "case_failed");
  assert.equal(failures.cases[0]?.metrics?.citationPrecision, 0.5);

  const selected = inspectEvalFailure({ summary, caseId: "case_passed" });
  assert.equal(selected.cases.length, 1);
  assert.equal(selected.cases[0]?.caseId, "case_passed");
  assert.deepEqual(selected.cases[0]?.failures, []);
});

function retrievalFixture(): RetrievalResult {
  return {
    query: "refund policy",
    candidates: [
      {
        chunk: indexedChunk,
        score: 0.92,
        rank: 1,
        matchedTerms: ["refund", "policy"],
        citation: indexedChunk.citation,
        reasons: ["bm25_match"]
      }
    ],
    rejected: [
      {
        chunkId: "chunk_denied",
        code: "access_denied_or_missing_chunk",
        reason: "Principal cannot read this chunk."
      }
    ],
    trace: {
      retrievalId: "retrieval_1",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      mode: "keyword",
      queryHash: "hash_query",
      normalizedQueryHash: "hash_normalized",
      searchTermHashes: ["hash_refund", "hash_policy"],
      access: redactIndexFilterForTrace(makeIndexFilter()),
      candidatePoolSize: 2,
      returnedCount: 1,
      rejectedCount: 1,
      adaptiveStrategy: {
        initialStrategy: "hybrid",
        reason: "question_has_named_policy_and_semantic_request",
        diagnosis: {
          code: "sufficient_candidates",
          reason: "Enough candidates returned.",
          candidateCount: 1,
          rejectedCount: 1,
          trustedCandidateCount: 1
        },
        finalDecision: "answerable",
        attemptedStrategies: ["hybrid"]
      }
    }
  };
}

function makePolicyChunk(): RagChunk {
  const chunk = chunkDocument({
    document: makeDocument({
      id: "doc_policy",
      title: "Refund Policy",
      body: "Refund policy says billing refunds require manager approval.",
      provenance: {
        sourceId: "source_policy",
        sourceKind: "local_file",
        title: "Refund Policy",
        ingestedAt: FIXED_NOW,
        capturedAt: FIXED_NOW,
        trustTier: "trusted_internal",
        sensitivity: "internal"
      }
    })
  }).chunks[0];
  if (!chunk) {
    throw new Error("Expected policy document to produce a chunk.");
  }
  return chunk;
}

function traceFixture(): RagRunTrace {
  return {
    runId: "run_1",
    traceId: "trace_1",
    profileId: "profile_1",
    namespaceId: "namespace_1",
    startedAt: FIXED_NOW,
    finishedAt: FIXED_NOW,
    status: "succeeded",
    questionHash: "hash_question",
    plannedQueryHashes: ["hash_query"],
    retrievalId: "retrieval_1",
    contextId: "context_1",
    retrievedChunkIds: [indexedChunk.id],
    rejectedChunkIds: ["chunk_denied"],
    finalCitations: [indexedChunk.citation],
    safetyFlags: [],
    events: [
      {
        runId: "run_1",
        traceId: "trace_1",
        kind: "run_started",
        at: FIXED_NOW,
        message: "Run started."
      },
      {
        runId: "run_1",
        traceId: "trace_1",
        kind: "chunk_retrieved",
        at: FIXED_NOW,
        message: "Chunk retrieved.",
        data: { chunkId: indexedChunk.id }
      }
    ]
  };
}

function contextFixture(): ContextBuildResult {
  return {
    blocks: [
      {
        index: 0,
        boundaryLabel: "chunk 1",
        chunkId: indexedChunk.id,
        documentId: indexedChunk.documentId,
        namespaceId: indexedChunk.namespaceId,
        text: indexedChunk.text,
        textHash: indexedChunk.textHash,
        tokenEstimate: indexedChunk.tokenEstimate ?? 12,
        score: 0.92,
        retrievalRank: 1,
        matchedTerms: ["refund", "policy"],
        citation: indexedChunk.citation,
        provenance: indexedChunk.provenance,
        safetyFlags: [],
        requiresHumanReview: false,
        redacted: false
      }
    ],
    citations: [indexedChunk.citation],
    rejected: [
      {
        chunkId: "chunk_stale",
        documentId: "doc_stale",
        code: "stale_source",
        reason: "Source freshness policy rejected this chunk."
      }
    ],
    evidence: {
      status: "answerable",
      canAttemptAnswer: true,
      blockCount: 1,
      citationCount: 1,
      trustedCitationCount: 1,
      requiresHumanReviewCount: 0,
      sourceIds: ["source_policy"],
      trustTiers: [indexedChunk.provenance.trustTier]
    },
    trace: {
      contextId: "context_1",
      retrievalId: "retrieval_1",
      profileId: "profile_1",
      namespaceId: "namespace_1",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      candidateCount: 1,
      blockCount: 1,
      rejectedCount: 1,
      totalTokenEstimate: 12,
      redactionCount: 0,
      maxContextTokens: 1000,
      maxContextChunks: 4,
      sourceIds: ["source_policy"],
      chunkIds: [indexedChunk.id],
      rejectionCodes: ["stale_source"]
    },
    totalTokenEstimate: 12
  };
}

function evalSummaryFixture(): RagEvalRunSummary {
  return {
    passed: false,
    suiteCount: 1,
    caseCount: 2,
    failures: ["case_failed failed: citation precision too low"],
    suites: [
      {
        profileId: "profile_1",
        namespaceId: "namespace_1",
        passed: false,
        goldenSetPath: "golden.jsonl",
        adversarialSetPath: "adversarial.jsonl",
        requiredChecks: ["citation_required"],
        coveredChecks: ["citation_required"],
        missingRequiredChecks: [],
        caseCount: 2,
        failures: ["case_failed failed: citation precision too low"],
        cases: [
          {
            id: "case_failed",
            setKind: "golden",
            checks: ["citation_required"],
            passed: false,
            failures: ["citation precision too low"],
            status: "succeeded",
            contextStatus: "answerable",
            retrievalMode: "keyword",
            retrievedDocumentIds: ["doc_policy"],
            finalCitationCount: 1,
            traceId: "trace_1",
            metrics: {
              citationPrecision: 0.5,
              citationRecall: 1,
              recallAtK: 1,
              mrr: 1
            }
          },
          {
            id: "case_passed",
            setKind: "golden",
            checks: ["citation_required"],
            passed: true,
            failures: [],
            retrievedDocumentIds: ["doc_policy"],
            finalCitationCount: 1
          }
        ]
      }
    ]
  };
}
