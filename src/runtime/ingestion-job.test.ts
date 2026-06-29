import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryIngestionCheckpointStore,
  InMemoryIngestionJobStore,
  InMemoryIngestionProgressStore
} from "./ingestion-job.js";

const NOW = "2026-06-26T12:00:00.000Z";

test("in-memory ingestion job store supports Phase 1 states and listing", async () => {
  const store = new InMemoryIngestionJobStore();
  await store.create({
    jobId: "job_1",
    runId: "job_1",
    tenantId: "tenant_1",
    namespaceId: "namespace_1",
    sourceIds: ["source_a"],
    requestedAt: NOW
  });
  await store.update({
    jobId: "job_1",
    status: "graph_extracting",
    stage: "graph_extracting",
    updatedAt: NOW
  });
  await store.update({
    jobId: "job_1",
    status: "completed_with_warnings",
    stage: "completed_with_warnings",
    counts: {
      documentsAccepted: 1,
      chunksAccepted: 2,
      recordsRejected: 1,
      failedDocumentCount: 0,
      skippedDocumentCount: 0,
      indexWritesAccepted: 3,
      indexWritesRejected: 0,
      adapterWarnings: 0,
      normalizationIssues: 0,
      parserQualityWarnings: 0,
      chunkingWarnings: 1
    },
    updatedAt: NOW
  });

  assert.equal((await store.get("job_1"))?.status, "completed_with_warnings");
  assert.deepEqual(
    (await store.list({ statuses: ["completed_with_warnings"] })).map((job) => job.jobId),
    ["job_1"]
  );
});

test("checkpoint store appends resumable checkpoints", async () => {
  const store = new InMemoryIngestionCheckpointStore();
  await store.save({
    jobId: "job_1",
    stage: "loading_source",
    checkpoint: { phase: "selected_sources", sourceIds: ["source_a"] },
    recordedAt: NOW
  });
  await store.save({
    jobId: "job_1",
    stage: "indexing",
    checkpoint: {
      phase: "document_indexed",
      documentId: "doc_1",
      completedDocumentIds: ["doc_1"]
    },
    recordedAt: NOW
  });

  assert.equal((await store.latest("job_1"))?.sequence, 2);
  assert.equal((await store.list("job_1")).length, 2);
});

test("progress store records source and document status", async () => {
  const store = new InMemoryIngestionProgressStore();
  await store.updateSource({
    jobId: "job_1",
    sourceId: "source_a",
    status: "loading",
    startedAt: NOW,
    updatedAt: NOW
  });
  await store.updateDocument({
    jobId: "job_1",
    sourceId: "source_a",
    documentId: "doc_1",
    status: "accepted",
    chunkCount: 2,
    finishedAt: NOW,
    updatedAt: NOW
  });
  await store.updateDocument({
    jobId: "job_1",
    sourceId: "source_a",
    documentId: "doc_failed",
    status: "failed",
    retryable: true,
    failureStage: "chunking",
    failurePhase: "chunking_rejected_record",
    errorMessage: "Chunk limit exceeded.",
    updatedAt: NOW
  });
  await store.updateSource({
    jobId: "job_1",
    sourceId: "source_a",
    status: "completed",
    acceptedDocumentCount: 1,
    finishedAt: NOW,
    updatedAt: NOW
  });

  assert.equal((await store.listSources("job_1"))[0]?.status, "completed");
  assert.equal((await store.listSources("job_1"))[0]?.acceptedDocumentCount, 1);
  assert.equal((await store.listDocuments("job_1"))[0]?.status, "accepted");
  assert.equal((await store.listDocuments("job_1"))[0]?.chunkCount, 2);
  const failed = (await store.listDocuments("job_1", { statuses: ["failed"] }))[0];
  assert.equal(failed?.failureStage, "chunking");
  assert.equal(failed?.failurePhase, "chunking_rejected_record");
});
