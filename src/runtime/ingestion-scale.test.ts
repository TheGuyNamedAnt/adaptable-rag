import assert from "node:assert/strict";
import test from "node:test";

import {
  IndexGenerationPromotionService,
  InMemoryIndexGenerationStore,
  InMemoryIngestionJobQueue,
  InMemoryIngestionLeaseStore,
  PostgresIndexGenerationStore,
  PostgresIngestionJobQueue,
  PostgresIngestionLeaseStore,
  planGenerationPromotion,
  planIngestionBackfillJobs,
  planReindex,
  type GenerationEvalResult,
  type IndexGenerationManifest
} from "./ingestion-scale.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("in-memory ingestion job queue claims by priority and handles retry/dead-letter", async () => {
  const queue = new InMemoryIngestionJobQueue();
  await queue.enqueue({
    jobId: "low",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    priority: 0,
    enqueuedAt: NOW
  });
  await queue.enqueue({
    jobId: "high",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_b"],
    priority: 10,
    maxAttempts: 2,
    enqueuedAt: NOW
  });

  const first = await queue.claimNext({
    workerId: "worker_a",
    now: NOW,
    leaseTtlMs: 60_000
  });
  assert.equal(first?.jobId, "high");
  assert.equal(first.attempt, 1);
  assert.equal(first.status, "leased");

  const retry = await queue.fail({
    queueId: "high",
    workerId: "worker_a",
    now: "2026-01-01T00:00:10.000Z",
    retryable: true,
    nextAvailableAt: "2026-01-01T00:01:00.000Z",
    errorName: "TransientProviderError"
  });
  assert.equal(retry.status, "queued");
  assert.equal(retry.attempt, 1);

  const second = await queue.claimNext({
    workerId: "worker_b",
    now: "2026-01-01T00:00:30.000Z",
    leaseTtlMs: 60_000
  });
  assert.equal(second?.jobId, "low");
  await queue.complete({
    queueId: "low",
    workerId: "worker_b",
    now: "2026-01-01T00:00:40.000Z"
  });

  const third = await queue.claimNext({
    workerId: "worker_c",
    now: "2026-01-01T00:01:00.000Z",
    leaseTtlMs: 60_000
  });
  assert.equal(third?.jobId, "high");
  assert.equal(third.attempt, 2);

  const deadLetter = await queue.fail({
    queueId: "high",
    workerId: "worker_c",
    now: "2026-01-01T00:01:05.000Z",
    retryable: true,
    errorMessage: "Provider unavailable after retry."
  });
  assert.equal(deadLetter.status, "dead_letter");
  assert.equal(deadLetter.finishedAt, "2026-01-01T00:01:05.000Z");

  assert.deepEqual(
    (await queue.list({ statuses: ["completed", "dead_letter"] })).map((job) => [
      job.jobId,
      job.status
    ]),
    [
      ["high", "dead_letter"],
      ["low", "completed"]
    ]
  );
});

test("in-memory ingestion lease store enforces exclusive workers", async () => {
  const leases = new InMemoryIngestionLeaseStore();
  const first = await leases.acquire({
    resourceId: "source:billing",
    holderId: "worker_a",
    now: NOW,
    ttlMs: 60_000
  });
  assert.ok(first);
  assert.equal(
    await leases.acquire({
      resourceId: "source:billing",
      holderId: "worker_b",
      now: "2026-01-01T00:00:30.000Z",
      ttlMs: 60_000
    }),
    undefined
  );

  const heartbeat = await leases.heartbeat({
    resourceId: first.resourceId,
    holderId: first.holderId,
    token: first.token,
    now: "2026-01-01T00:00:45.000Z",
    ttlMs: 60_000
  });
  assert.equal(heartbeat?.leaseExpiresAt, "2026-01-01T00:01:45.000Z");
  assert.equal(
    await leases.release({
      resourceId: first.resourceId,
      holderId: "worker_b",
      token: first.token
    }),
    false
  );
  assert.equal(
    await leases.release({
      resourceId: first.resourceId,
      holderId: first.holderId,
      token: first.token
    }),
    true
  );
  assert.equal(
    (
      await leases.acquire({
        resourceId: "source:billing",
        holderId: "worker_b",
        now: "2026-01-01T00:01:00.000Z",
        ttlMs: 60_000
      })
    )?.holderId,
    "worker_b"
  );
});

test("in-memory ingestion job queue cancels active work and requeues dead letters", async () => {
  const queue = new InMemoryIngestionJobQueue();
  await queue.enqueue({
    jobId: "queued_job",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    enqueuedAt: NOW
  });
  const cancelled = await queue.cancel({
    queueId: "queued_job",
    now: "2026-01-01T00:00:10.000Z",
    reason: "Operator cancelled duplicate work."
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorMessage, "Operator cancelled duplicate work.");

  await queue.enqueue({
    jobId: "dead_job",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_b"],
    maxAttempts: 1,
    enqueuedAt: NOW,
    metadata: { planId: "plan_a" }
  });
  await queue.claimNext({
    workerId: "worker_a",
    now: NOW,
    leaseTtlMs: 60_000
  });
  await queue.fail({
    queueId: "dead_job",
    workerId: "worker_a",
    now: "2026-01-01T00:00:20.000Z",
    retryable: true,
    errorName: "ProviderError",
    errorMessage: "Embedding provider unavailable."
  });
  const requeued = await queue.requeue({
    queueId: "dead_job",
    now: "2026-01-01T00:01:00.000Z",
    availableAt: "2026-01-01T00:05:00.000Z",
    maxAttempts: 3,
    reason: "Provider recovered.",
    metadata: { operator: "search_team" }
  });

  assert.equal(requeued.status, "queued");
  assert.equal(requeued.attempt, 0);
  assert.equal(requeued.maxAttempts, 3);
  assert.equal(requeued.availableAt, "2026-01-01T00:05:00.000Z");
  assert.equal(requeued.finishedAt, undefined);
  assert.equal(requeued.errorName, "ProviderError");
  assert.equal(requeued.errorMessage, "Embedding provider unavailable.");
  assert.equal(requeued.metadata?.planId, "plan_a");
  assert.equal(requeued.metadata?.operator, "search_team");
  assert.equal(requeued.metadata?.requeueReason, "Provider recovered.");
});

test("backfill, promotion, and reindex planning keep generation rollout explicit", () => {
  const candidate = manifest("candidate_generation", "candidate");
  const active = manifest("active_generation", "active");
  const backfill = planIngestionBackfillJobs({
    planId: "plan_a",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["a", "b", "c", "d", "e"],
    requestedAt: NOW,
    batchSize: 2,
    priority: 5,
    availableAt: "2026-01-01T00:10:00.000Z",
    metadata: { operator: "search_team" }
  });
  assert.equal(backfill.jobCount, 3);
  assert.equal(backfill.jobs[0]?.availableAt, "2026-01-01T00:10:00.000Z");
  assert.equal(backfill.jobs[0]?.metadata?.operator, "search_team");
  assert.deepEqual(
    backfill.jobs.map((job) => job.sourceIds),
    [["a", "b"], ["c", "d"], ["e"]]
  );

  const promotion = planGenerationPromotion({
    candidate,
    active,
    requiredEvalIds: ["retrieval_recall", "citation_recall"],
    archivePrevious: true,
    plannedAt: NOW
  });
  assert.deepEqual(promotion.actions, [
    "validate_candidate_generation",
    "run_required_evals",
    "switch_active_generation",
    "mark_previous_generation_deprecated",
    "archive_previous_generation"
  ]);
  assert.equal(promotion.previousActiveGenerationId, "active_generation");

  const reindex = planReindex({
    planId: "reindex_a",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a", "source_b"],
    requestedAt: NOW,
    batchSize: 1,
    candidateGeneration: candidate,
    activeGeneration: active,
    requiredEvalIds: ["grounding"],
    metadata: { operator: "search_team" }
  });
  assert.equal(reindex.backfill.jobCount, 2);
  assert.equal(reindex.backfill.jobs[0]?.metadata?.operator, "search_team");
  assert.equal(reindex.backfill.jobs[0]?.metadata?.reindexGenerationId, "candidate_generation");
  assert.deepEqual(reindex.promotion.requiredEvalIds, ["grounding"]);
});

test("index generation promotion service gates active switch on required evals", async () => {
  const store = new InMemoryIndexGenerationStore();
  const service = new IndexGenerationPromotionService({ store });
  const candidate = manifest("candidate_generation", "candidate");
  const active = manifest("active_generation", "active");

  const planned = await service.planPromotion({
    promotionId: "promotion_1",
    candidate,
    active,
    requiredEvalIds: ["retrieval_recall", "citation_recall"],
    plannedAt: NOW
  });
  assert.equal(planned.status, "planned");
  assert.equal(
    (await store.getActiveManifest({ tenantId: "tenant_1", namespaceId: "support" }))?.generationId,
    "active_generation"
  );

  await assert.rejects(
    () =>
      service.promote({
        promotionId: "promotion_1",
        promotedAt: "2026-01-01T00:05:00.000Z"
      }),
    /missing required evals/
  );

  const partial = await service.recordEvalResult({
    promotionId: "promotion_1",
    evalId: "retrieval_recall",
    status: "passed",
    recordedAt: "2026-01-01T00:01:00.000Z"
  });
  assert.equal(partial.status, "planned");

  const failed = await service.recordEvalResult({
    promotionId: "promotion_1",
    evalId: "citation_recall",
    status: "failed",
    recordedAt: "2026-01-01T00:02:00.000Z",
    reportUri: "s3://evals/citation.json"
  });
  assert.equal(failed.status, "failed");
  await assert.rejects(
    () =>
      service.promote({
        promotionId: "promotion_1",
        promotedAt: "2026-01-01T00:05:00.000Z"
      }),
    /failed evals/
  );

  const ready = await service.recordEvalResult({
    promotionId: "promotion_1",
    evalId: "citation_recall",
    status: "passed",
    recordedAt: "2026-01-01T00:03:00.000Z",
    reportUri: "s3://evals/citation-rerun.json"
  });
  assert.equal(ready.status, "ready");

  const promoted = await service.promote({
    promotionId: "promotion_1",
    promotedAt: "2026-01-01T00:05:00.000Z"
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotedAt, "2026-01-01T00:05:00.000Z");
  assert.equal(
    (await store.getActiveManifest({ tenantId: "tenant_1", namespaceId: "support" }))?.generationId,
    "candidate_generation"
  );
  assert.equal((await store.getManifest("active_generation"))?.status, "deprecated");
});

test("postgres ingestion job queue maps rows and claims with skip-locked SQL", async () => {
  const pool = new ScriptedPgPool([
    [
      queueRow({
        queue_id: "queue_1",
        job_id: "job_1",
        status: "queued",
        attempt: 0,
        metadata: { reindexGenerationId: "candidate_generation" }
      })
    ],
    [
      queueRow({
        queue_id: "queue_1",
        job_id: "job_1",
        status: "leased",
        attempt: 1,
        leased_by: "worker_a",
        lease_expires_at: "2026-01-01T00:01:00.000Z"
      })
    ],
    [queueRow({ queue_id: "queue_1", job_id: "job_1", status: "completed", attempt: 1 })]
  ]);
  const queue = new PostgresIngestionJobQueue({ pool: pool as never });

  const enqueued = await queue.enqueue({
    queueId: "queue_1",
    jobId: "job_1",
    runId: "run_1",
    tenantId: "tenant_1",
    namespaceId: "support",
    sourceIds: ["source_a"],
    enqueuedAt: NOW,
    metadata: { reindexGenerationId: "candidate_generation" }
  });
  assert.equal(enqueued.status, "queued");
  assert.equal(enqueued.metadata?.reindexGenerationId, "candidate_generation");

  const claimed = await queue.claimNext({
    workerId: "worker_a",
    now: NOW,
    leaseTtlMs: 60_000,
    tenantId: "tenant_1",
    namespaceId: "support"
  });
  assert.equal(claimed?.status, "leased");
  assert.equal(claimed?.leasedBy, "worker_a");
  assert.equal(pool.queries[1]?.text.includes("for update skip locked"), true);
  assert.deepEqual(pool.queries[1]?.values?.slice(3), ["tenant_1", "support", null]);

  const completed = await queue.complete({
    queueId: "queue_1",
    workerId: "worker_a",
    now: "2026-01-01T00:00:30.000Z"
  });
  assert.equal(completed.status, "completed");
});

test("postgres ingestion job queue cancels active rows and requeues dead letters", async () => {
  const pool = new ScriptedPgPool([
    [
      queueRow({
        queue_id: "queue_cancel",
        job_id: "job_cancel",
        status: "cancelled",
        finished_at: "2026-01-01T00:00:10.000Z",
        error_message: "Operator cancelled duplicate work."
      })
    ],
    [
      queueRow({
        queue_id: "queue_dead",
        job_id: "job_dead",
        status: "queued",
        attempt: 0,
        max_attempts: 5,
        available_at: "2026-01-01T00:05:00.000Z",
        finished_at: null,
        metadata: { operator: "search_team", requeueReason: "Provider recovered." }
      })
    ]
  ]);
  const queue = new PostgresIngestionJobQueue({ pool: pool as never });

  const cancelled = await queue.cancel({
    queueId: "queue_cancel",
    now: "2026-01-01T00:00:10.000Z",
    reason: "Operator cancelled duplicate work."
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(pool.queries[0]?.text.includes("status in ('queued', 'leased')"), true);

  const requeued = await queue.requeue({
    queueId: "queue_dead",
    now: "2026-01-01T00:01:00.000Z",
    availableAt: "2026-01-01T00:05:00.000Z",
    maxAttempts: 5,
    reason: "Provider recovered.",
    metadata: { operator: "search_team" }
  });
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.attempt, 0);
  assert.equal(requeued.maxAttempts, 5);
  assert.equal(requeued.metadata?.requeueReason, "Provider recovered.");
  assert.equal(pool.queries[1]?.text.includes("status = 'dead_letter'"), true);
  assert.deepEqual(pool.queries[1]?.values, [
    "queue_dead",
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:05:00.000Z",
    5,
    JSON.stringify({ operator: "search_team", requeueReason: "Provider recovered." })
  ]);
});

test("postgres ingestion lease store maps lease rows and token-checked release", async () => {
  const pool = new ScriptedPgPool([
    [
      leaseRow({
        resource_id: "source:billing",
        holder_id: "worker_a",
        token: "source:billing:worker_a:token",
        metadata: { sourceId: "billing" }
      })
    ],
    [
      leaseRow({
        resource_id: "source:billing",
        holder_id: "worker_a",
        token: "source:billing:worker_a:token",
        updated_at: "2026-01-01T00:00:30.000Z",
        lease_expires_at: "2026-01-01T00:01:30.000Z"
      })
    ],
    [{ resource_id: "source:billing" }]
  ]);
  const leases = new PostgresIngestionLeaseStore({ pool: pool as never });

  const acquired = await leases.acquire({
    resourceId: "source:billing",
    holderId: "worker_a",
    now: NOW,
    ttlMs: 60_000,
    metadata: { sourceId: "billing" }
  });
  assert.equal(acquired?.resourceId, "source:billing");
  assert.equal(acquired?.metadata?.sourceId, "billing");

  const heartbeat = await leases.heartbeat({
    resourceId: "source:billing",
    holderId: "worker_a",
    token: "source:billing:worker_a:token",
    now: "2026-01-01T00:00:30.000Z",
    ttlMs: 60_000
  });
  assert.equal(heartbeat?.leaseExpiresAt, "2026-01-01T00:01:30.000Z");

  assert.equal(
    await leases.release({
      resourceId: "source:billing",
      holderId: "worker_a",
      token: "source:billing:worker_a:token"
    }),
    true
  );
  assert.equal(pool.queries[2]?.values?.[2], "source:billing:worker_a:token");
});

test("postgres index generation store maps manifests and promotion evals", async () => {
  const candidate = manifest("candidate_generation", "candidate");
  const active = manifest("active_generation", "active");
  const passedEval: GenerationEvalResult = {
    evalId: "retrieval_recall",
    status: "passed",
    recordedAt: "2026-01-01T00:01:00.000Z",
    reportUri: "s3://evals/retrieval.json"
  };
  const promotion = planGenerationPromotion({
    candidate,
    active,
    requiredEvalIds: ["retrieval_recall"],
    plannedAt: NOW
  });
  const pool = new ScriptedPgPool([
    [generationManifestRow(candidate)],
    [generationManifestRow(active)],
    [promotionRow({ required_eval_ids: ["retrieval_recall"], status: "planned" })],
    [promotionRow({ required_eval_ids: ["retrieval_recall"], status: "planned" })],
    [
      promotionRow({
        required_eval_ids: ["retrieval_recall"],
        status: "ready",
        updated_at: "2026-01-01T00:01:00.000Z",
        eval_results: [passedEval]
      })
    ]
  ]);
  const store = new PostgresIndexGenerationStore({ pool: pool as never });

  const saved = await store.saveManifest({ manifest: candidate, savedAt: NOW });
  assert.equal(saved.generationId, "candidate_generation");

  const current = await store.getActiveManifest({
    tenantId: "tenant_1",
    namespaceId: "support"
  });
  assert.equal(current?.generationId, "active_generation");

  const savedPromotion = await store.savePromotion({
    promotionId: "promotion_1",
    plan: promotion,
    savedAt: NOW
  });
  assert.equal(savedPromotion.status, "planned");

  const updated = await store.recordEvalResult({
    promotionId: "promotion_1",
    result: passedEval,
    recordedAt: "2026-01-01T00:01:00.000Z"
  });
  assert.equal(updated.status, "ready");
  assert.deepEqual(updated.evalResults, [passedEval]);
  assert.equal(pool.queries[0]?.text.includes("index_generation_manifests"), true);
  assert.equal(pool.queries[2]?.text.includes("index_generation_promotions"), true);
  assert.equal(pool.queries[4]?.values?.[3], JSON.stringify([passedEval]));
});

function manifest(
  generationId: string,
  status: IndexGenerationManifest["status"]
): IndexGenerationManifest {
  return {
    generationId,
    tenantId: "tenant_1",
    namespaceId: "support",
    profileId: "support_profile",
    status,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-large",
    embeddingDimensions: 3072,
    embeddingConfigHash: `${generationId}_embedding_hash`,
    embeddingIndexConfigHash: `${generationId}_index_hash`,
    chunkingPolicyId: "default",
    chunkingPolicyVersion: 1,
    createdAt: NOW
  };
}

class ScriptedPgPool {
  readonly queries: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
  private readonly rows: readonly unknown[][];

  constructor(rows: readonly (readonly unknown[])[]) {
    this.rows = rows.map((entry) => [...entry]);
  }

  async query<T>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly T[] }> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    const rows = this.rows[this.queries.length - 1] ?? [];
    return { rows: rows as readonly T[] };
  }
}

function queueRow(
  overrides: Partial<{
    readonly queue_id: string;
    readonly job_id: string;
    readonly run_id: string | null;
    readonly tenant_id: string;
    readonly namespace_id: string;
    readonly source_ids: readonly string[];
    readonly priority: number;
    readonly status: string;
    readonly attempt: number;
    readonly max_attempts: number;
    readonly available_at: string;
    readonly enqueued_at: string;
    readonly updated_at: string;
    readonly leased_by: string | null;
    readonly lease_expires_at: string | null;
    readonly finished_at: string | null;
    readonly error_name: string | null;
    readonly error_message: string | null;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }>
): Record<string, unknown> {
  return {
    queue_id: "queue_1",
    job_id: "job_1",
    run_id: "run_1",
    tenant_id: "tenant_1",
    namespace_id: "support",
    source_ids: ["source_a"],
    priority: 0,
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    available_at: NOW,
    enqueued_at: NOW,
    updated_at: NOW,
    leased_by: null,
    lease_expires_at: null,
    finished_at: null,
    error_name: null,
    error_message: null,
    metadata: {},
    ...overrides
  };
}

function leaseRow(
  overrides: Partial<{
    readonly resource_id: string;
    readonly holder_id: string;
    readonly token: string;
    readonly acquired_at: string;
    readonly updated_at: string;
    readonly lease_expires_at: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }>
): Record<string, unknown> {
  return {
    resource_id: "source:billing",
    holder_id: "worker_a",
    token: "source:billing:worker_a:token",
    acquired_at: NOW,
    updated_at: NOW,
    lease_expires_at: "2026-01-01T00:01:00.000Z",
    metadata: {},
    ...overrides
  };
}

function generationManifestRow(manifest: IndexGenerationManifest): Record<string, unknown> {
  return {
    generation_id: manifest.generationId,
    tenant_id: manifest.tenantId,
    namespace_id: manifest.namespaceId,
    profile_id: manifest.profileId,
    status: manifest.status,
    manifest,
    created_at: manifest.createdAt,
    updated_at: manifest.createdAt,
    promoted_at: manifest.promotedAt ?? null,
    deprecated_at: manifest.deprecatedAt ?? null
  };
}

function promotionRow(
  overrides: Partial<{
    readonly promotion_id: string;
    readonly tenant_id: string;
    readonly namespace_id: string;
    readonly candidate_generation_id: string;
    readonly previous_active_generation_id: string | null;
    readonly required_eval_ids: readonly string[];
    readonly actions: readonly string[];
    readonly status: string;
    readonly planned_at: string;
    readonly updated_at: string;
    readonly promoted_at: string | null;
    readonly failure_reason: string | null;
    readonly eval_results: readonly GenerationEvalResult[];
  }>
): Record<string, unknown> {
  return {
    promotion_id: "promotion_1",
    tenant_id: "tenant_1",
    namespace_id: "support",
    candidate_generation_id: "candidate_generation",
    previous_active_generation_id: "active_generation",
    required_eval_ids: [],
    actions: [
      "validate_candidate_generation",
      "run_required_evals",
      "switch_active_generation",
      "mark_previous_generation_deprecated"
    ],
    status: "planned",
    planned_at: NOW,
    updated_at: NOW,
    promoted_at: null,
    failure_reason: null,
    eval_results: [],
    ...overrides
  };
}
