import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryIngestionJobQueue, InMemoryIngestionLeaseStore } from "./ingestion-scale.js";
import { ProductionIngestionWorker } from "./ingestion-worker.js";
import type {
  ProductionIngestRuntime,
  ProductionRagIngestInput,
  ProductionRagIngestResponse
} from "./production-ingestion.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("production ingestion worker claims, leases, ingests, and completes a queue job", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const leases = new InMemoryIngestionLeaseStore();
  const runtime = new FakeIngestRuntime();
  await queue.enqueue({
    queueId: "queue_1",
    jobId: "job_1",
    runId: "run_1",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    enqueuedAt: NOW,
    metadata: { reindexGenerationId: "candidate_generation" }
  });

  const worker = new ProductionIngestionWorker({
    queue,
    leaseStore: leases,
    ingestRuntime: runtime,
    workerId: "worker_a",
    principalForJob: () => ({ userId: "system_ingestion", roles: ["admin"] }),
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    now: fixedNow
  });

  const result = await worker.runOnce({ overwriteMode: "replace" });

  assert.equal(result.status, "completed");
  assert.equal((await queue.get("queue_1"))?.status, "completed");
  assert.equal(runtime.inputs[0]?.runId, "run_1");
  assert.equal(runtime.inputs[0]?.overwriteMode, "replace");
  assert.deepEqual(runtime.inputs[0]?.sourceIds, ["source_a"]);
  assert.equal(await leases.get("source:tenant_1:support:source_a"), undefined);
  assert.equal(await leases.get("generation:tenant_1:support:candidate_generation"), undefined);
});

test("production ingestion worker requeues when a source lease is held", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const leases = new InMemoryIngestionLeaseStore();
  const runtime = new FakeIngestRuntime();
  await leases.acquire({
    resourceId: "source:tenant_1:support:source_a",
    holderId: "worker_b",
    now: NOW,
    ttlMs: 60_000
  });
  await queue.enqueue({
    queueId: "queue_1",
    jobId: "job_1",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    enqueuedAt: NOW
  });

  const worker = new ProductionIngestionWorker({
    queue,
    leaseStore: leases,
    ingestRuntime: runtime,
    workerId: "worker_a",
    principalForJob: () => ({ userId: "system_ingestion" }),
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    leaseConflictRetryMs: 30_000,
    now: fixedNow
  });

  const result = await worker.runOnce();
  const queued = await queue.get("queue_1");

  assert.equal(result.status, "lease_conflict");
  assert.equal(result.errorName, "IngestionLeaseConflict");
  assert.equal(runtime.inputs.length, 0);
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.availableAt, "2026-01-01T00:00:30.000Z");
});

test("production ingestion worker dead-letters exhausted failed jobs", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const runtime = new FakeIngestRuntime(new Error("Parser crashed."));
  await queue.enqueue({
    queueId: "queue_1",
    jobId: "job_1",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    maxAttempts: 1,
    enqueuedAt: NOW
  });
  const worker = new ProductionIngestionWorker({
    queue,
    ingestRuntime: runtime,
    workerId: "worker_a",
    principalForJob: () => ({ userId: "system_ingestion" }),
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    now: fixedNow
  });

  const result = await worker.runOnce();
  const failed = await queue.get("queue_1");

  assert.equal(result.status, "failed");
  assert.equal(result.errorName, "Error");
  assert.equal(failed?.status, "dead_letter");
  assert.equal(failed?.errorMessage, "Parser crashed.");
});

test("production ingestion worker loop stops when the queue becomes idle", async () => {
  const queue = new InMemoryIngestionJobQueue();
  const runtime = new FakeIngestRuntime();
  await queue.enqueue({
    queueId: "queue_1",
    jobId: "job_1",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    enqueuedAt: NOW
  });
  const worker = new ProductionIngestionWorker({
    queue,
    ingestRuntime: runtime,
    workerId: "worker_a",
    principalForJob: () => ({ userId: "system_ingestion" }),
    leaseTtlMs: 60_000,
    heartbeatIntervalMs: 0,
    now: fixedNow
  });

  const result = await worker.runLoop({ maxJobs: 3 });

  assert.equal(result.attemptedCount, 1);
  assert.equal(result.completedCount, 1);
  assert.equal(result.idleCount, 1);
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["completed", "idle"]
  );
});

class FakeIngestRuntime implements ProductionIngestRuntime {
  readonly inputs: ProductionRagIngestInput[] = [];

  constructor(private readonly failure?: Error) {}

  async ingest(input: ProductionRagIngestInput): Promise<ProductionRagIngestResponse> {
    this.inputs.push(input);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return {
      status: "completed",
      runId: input.runId ?? "run_1",
      startedAt: NOW,
      finishedAt: "2026-01-01T00:00:05.000Z",
      loadedSourceIds: input.sourceIds ?? [],
      counts: {
        documentsAccepted: 1,
        chunksAccepted: 1,
        recordsRejected: 0,
        indexWritesAccepted: 2,
        indexWritesRejected: 0,
        adapterWarnings: 0,
        normalizationIssues: 0,
        parserQualityWarnings: 0,
        searchableArtifactWarnings: 0,
        chunkingWarnings: 0,
        integrityErrors: 0,
        integrityWarnings: 0
      },
      index: {
        storageKind: "memory",
        durable: false,
        documentCount: 1,
        chunkCount: 1
      },
      parserQuality: {
        documentsAnalyzed: 0,
        warnings: [],
        readiness: {
          status: "passed",
          message: "ok"
        }
      },
      integrity: {
        status: "passed",
        counts: {
          documentCount: 1,
          chunkCount: 1,
          bodyChunkCount: 1,
          derivedChunkCount: 0,
          pageSummaryChunkCount: 0,
          parserGapChunkCount: 0,
          pageCount: 0,
          pagesNeedingOcrCount: 0,
          tableCount: 0,
          tableRowCount: 0,
          visualAssetCount: 0,
          layoutRelationCount: 0,
          chunkRelationshipCount: 0,
          indexedVectorCount: 0,
          indexedVisualVectorCount: 0,
          indexedRelationVectorCount: 0,
          knowledgeEntityCount: 0,
          knowledgeRelationCount: 0
        },
        searchableUnitCounts: {},
        issueCount: 0,
        errorCount: 0,
        warningCount: 0,
        issues: []
      },
      warnings: {
        adapter: [],
        normalization: [],
        parserQuality: [],
        searchableArtifacts: [],
        chunking: [],
        index: [],
        embedding: [],
        visualEmbedding: []
      },
      artifacts: {
        documents: [],
        chunks: []
      }
    } as unknown as ProductionRagIngestResponse;
  }
}

function fixedNow(): string {
  return NOW;
}
