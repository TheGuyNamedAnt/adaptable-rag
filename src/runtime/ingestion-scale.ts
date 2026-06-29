import { randomUUID } from "node:crypto";
import type { Pool, PoolConfig } from "pg";
import pg from "pg";

export type IngestionQueueStatus = "queued" | "leased" | "completed" | "dead_letter" | "cancelled";

export interface IngestionQueueJob {
  readonly queueId: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly priority: number;
  readonly status: IngestionQueueStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly leasedBy?: string;
  readonly leaseExpiresAt?: string;
  readonly finishedAt?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface EnqueueIngestionJobInput {
  readonly queueId?: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly enqueuedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ClaimIngestionJobInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseTtlMs: number;
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly sourceIds?: readonly string[];
}

export interface CompleteIngestionJobInput {
  readonly queueId: string;
  readonly workerId: string;
  readonly now: string;
}

export interface HeartbeatIngestionQueueJobInput {
  readonly queueId: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseTtlMs: number;
}

export interface FailIngestionJobInput {
  readonly queueId: string;
  readonly workerId: string;
  readonly now: string;
  readonly retryable: boolean;
  readonly nextAvailableAt?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface CancelIngestionJobInput {
  readonly queueId: string;
  readonly now: string;
  readonly reason?: string;
}

export interface RequeueIngestionJobInput {
  readonly queueId: string;
  readonly now: string;
  readonly availableAt?: string;
  readonly maxAttempts?: number;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface IngestionQueueListFilter {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly statuses?: readonly IngestionQueueStatus[];
  readonly limit?: number;
}

export interface IngestionJobQueue {
  enqueue(input: EnqueueIngestionJobInput): Promise<IngestionQueueJob>;
  claimNext(input: ClaimIngestionJobInput): Promise<IngestionQueueJob | undefined>;
  heartbeat(input: HeartbeatIngestionQueueJobInput): Promise<IngestionQueueJob | undefined>;
  complete(input: CompleteIngestionJobInput): Promise<IngestionQueueJob>;
  fail(input: FailIngestionJobInput): Promise<IngestionQueueJob>;
  cancel(input: CancelIngestionJobInput): Promise<IngestionQueueJob>;
  requeue(input: RequeueIngestionJobInput): Promise<IngestionQueueJob>;
  get(queueId: string): Promise<IngestionQueueJob | undefined>;
  list(filter?: IngestionQueueListFilter): Promise<readonly IngestionQueueJob[]>;
}

export interface IngestionLeaseRecord {
  readonly resourceId: string;
  readonly holderId: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AcquireIngestionLeaseInput {
  readonly resourceId: string;
  readonly holderId: string;
  readonly now: string;
  readonly ttlMs: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface HeartbeatIngestionLeaseInput {
  readonly resourceId: string;
  readonly holderId: string;
  readonly token: string;
  readonly now: string;
  readonly ttlMs: number;
}

export interface ReleaseIngestionLeaseInput {
  readonly resourceId: string;
  readonly holderId: string;
  readonly token: string;
}

export interface IngestionLeaseStore {
  acquire(input: AcquireIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined>;
  heartbeat(input: HeartbeatIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined>;
  release(input: ReleaseIngestionLeaseInput): Promise<boolean>;
  get(resourceId: string): Promise<IngestionLeaseRecord | undefined>;
}

export interface IngestionBackfillPlanRequest {
  readonly planId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly requestedAt: string;
  readonly batchSize: number;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface IngestionBackfillPlan {
  readonly planId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly requestedAt: string;
  readonly batchSize: number;
  readonly jobCount: number;
  readonly jobs: readonly EnqueueIngestionJobInput[];
}

export type IndexGenerationStatus = "candidate" | "active" | "deprecated" | "failed";

export interface IndexGenerationManifest {
  readonly generationId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly profileId: string;
  readonly status: IndexGenerationStatus;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly embeddingConfigHash: string;
  readonly embeddingIndexConfigHash: string;
  readonly chunkingPolicyId: string;
  readonly chunkingPolicyVersion: number;
  readonly chunkerVersion?: string;
  readonly createdAt: string;
  readonly promotedAt?: string;
  readonly deprecatedAt?: string;
  readonly evalReportUri?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type GenerationPromotionAction =
  | "validate_candidate_generation"
  | "run_required_evals"
  | "switch_active_generation"
  | "mark_previous_generation_deprecated"
  | "archive_previous_generation";

export interface GenerationPromotionPlan {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly candidateGenerationId: string;
  readonly previousActiveGenerationId?: string;
  readonly requiredEvalIds: readonly string[];
  readonly actions: readonly GenerationPromotionAction[];
  readonly plannedAt: string;
}

export interface PlanGenerationPromotionInput {
  readonly candidate: IndexGenerationManifest;
  readonly active?: IndexGenerationManifest;
  readonly requiredEvalIds?: readonly string[];
  readonly archivePrevious?: boolean;
  readonly plannedAt: string;
}

export interface ReindexPlanRequest {
  readonly planId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly requestedAt: string;
  readonly batchSize: number;
  readonly candidateGeneration: IndexGenerationManifest;
  readonly activeGeneration?: IndexGenerationManifest;
  readonly requiredEvalIds?: readonly string[];
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ReindexPlan {
  readonly planId: string;
  readonly backfill: IngestionBackfillPlan;
  readonly candidateGeneration: IndexGenerationManifest;
  readonly promotion: GenerationPromotionPlan;
}

export type GenerationEvalStatus = "passed" | "failed";
export type GenerationPromotionStatus = "planned" | "ready" | "promoted" | "failed";

export interface GenerationEvalResult {
  readonly evalId: string;
  readonly status: GenerationEvalStatus;
  readonly recordedAt: string;
  readonly reportUri?: string;
  readonly summary?: string;
}

export interface GenerationPromotionRecord extends GenerationPromotionPlan {
  readonly promotionId: string;
  readonly status: GenerationPromotionStatus;
  readonly evalResults: readonly GenerationEvalResult[];
  readonly updatedAt: string;
  readonly promotedAt?: string;
  readonly failureReason?: string;
}

export interface IndexGenerationListFilter {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly statuses?: readonly IndexGenerationStatus[];
  readonly limit?: number;
}

export interface SaveIndexGenerationManifestInput {
  readonly manifest: IndexGenerationManifest;
  readonly savedAt: string;
}

export interface SaveGenerationPromotionInput {
  readonly promotionId: string;
  readonly plan: GenerationPromotionPlan;
  readonly evalResults?: readonly GenerationEvalResult[];
  readonly savedAt: string;
}

export interface RecordGenerationEvalResultInput {
  readonly promotionId: string;
  readonly result: GenerationEvalResult;
  readonly recordedAt: string;
}

export interface PromoteGenerationInput {
  readonly promotionId: string;
  readonly promotedAt: string;
}

export interface IndexGenerationStore {
  saveManifest(input: SaveIndexGenerationManifestInput): Promise<IndexGenerationManifest>;
  getManifest(generationId: string): Promise<IndexGenerationManifest | undefined>;
  getActiveManifest(input: {
    readonly tenantId: string;
    readonly namespaceId: string;
  }): Promise<IndexGenerationManifest | undefined>;
  listManifests(filter?: IndexGenerationListFilter): Promise<readonly IndexGenerationManifest[]>;
  savePromotion(input: SaveGenerationPromotionInput): Promise<GenerationPromotionRecord>;
  getPromotion(promotionId: string): Promise<GenerationPromotionRecord | undefined>;
  recordEvalResult(input: RecordGenerationEvalResultInput): Promise<GenerationPromotionRecord>;
  promote(input: PromoteGenerationInput): Promise<GenerationPromotionRecord>;
}

export interface IndexGenerationPromotionServiceOptions {
  readonly store: IndexGenerationStore;
  readonly now?: () => string;
}

export interface PlanIndexGenerationPromotionInput {
  readonly promotionId: string;
  readonly candidate: IndexGenerationManifest;
  readonly active?: IndexGenerationManifest;
  readonly requiredEvalIds?: readonly string[];
  readonly archivePrevious?: boolean;
  readonly plannedAt?: string;
}

export class IndexGenerationPromotionService {
  private readonly store: IndexGenerationStore;
  private readonly now: () => string;

  constructor(options: IndexGenerationPromotionServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async planPromotion(
    input: PlanIndexGenerationPromotionInput
  ): Promise<GenerationPromotionRecord> {
    const plannedAt = input.plannedAt ?? this.now();
    const plan = planGenerationPromotion({
      candidate: input.candidate,
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.requiredEvalIds === undefined ? {} : { requiredEvalIds: input.requiredEvalIds }),
      ...(input.archivePrevious === undefined ? {} : { archivePrevious: input.archivePrevious }),
      plannedAt
    });
    await this.store.saveManifest({ manifest: input.candidate, savedAt: plannedAt });
    if (input.active !== undefined) {
      await this.store.saveManifest({ manifest: input.active, savedAt: plannedAt });
    }
    return this.store.savePromotion({
      promotionId: input.promotionId,
      plan,
      savedAt: plannedAt
    });
  }

  async recordEvalResult(input: {
    readonly promotionId: string;
    readonly evalId: string;
    readonly status: GenerationEvalStatus;
    readonly reportUri?: string;
    readonly summary?: string;
    readonly recordedAt?: string;
  }): Promise<GenerationPromotionRecord> {
    const recordedAt = input.recordedAt ?? this.now();
    return this.store.recordEvalResult({
      promotionId: input.promotionId,
      recordedAt,
      result: {
        evalId: input.evalId,
        status: input.status,
        recordedAt,
        ...(input.reportUri === undefined ? {} : { reportUri: input.reportUri }),
        ...(input.summary === undefined ? {} : { summary: input.summary })
      }
    });
  }

  async promote(input: {
    readonly promotionId: string;
    readonly promotedAt?: string;
  }): Promise<GenerationPromotionRecord> {
    const promotedAt = input.promotedAt ?? this.now();
    const record = await this.store.getPromotion(input.promotionId);
    if (record === undefined) {
      throw new Error(`Generation promotion "${input.promotionId}" does not exist.`);
    }
    const readiness = generationPromotionReadiness(record);
    if (!readiness.ready) {
      throw new Error(readiness.reason);
    }

    return this.store.promote({
      promotionId: input.promotionId,
      promotedAt
    });
  }
}

export class InMemoryIngestionJobQueue implements IngestionJobQueue {
  private readonly jobs = new Map<string, IngestionQueueJob>();

  async enqueue(input: EnqueueIngestionJobInput): Promise<IngestionQueueJob> {
    const queueId = nonBlank(input.queueId ?? input.jobId, "queueId");
    if (this.jobs.has(queueId)) {
      throw new Error(`Ingestion queue job "${queueId}" already exists.`);
    }

    const enqueuedAt = nonBlank(input.enqueuedAt, "enqueuedAt");
    const job: IngestionQueueJob = {
      queueId,
      jobId: nonBlank(input.jobId, "jobId"),
      ...(input.runId === undefined ? {} : { runId: nonBlank(input.runId, "runId") }),
      tenantId: nonBlank(input.tenantId, "tenantId"),
      namespaceId: nonBlank(input.namespaceId, "namespaceId"),
      sourceIds: input.sourceIds.map((sourceId) => nonBlank(sourceId, "sourceId")),
      priority: input.priority ?? 0,
      status: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      availableAt: input.availableAt ?? enqueuedAt,
      enqueuedAt,
      updatedAt: enqueuedAt,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    };
    assertPositiveInteger(job.maxAttempts, "maxAttempts");
    this.jobs.set(queueId, job);
    return job;
  }

  async claimNext(input: ClaimIngestionJobInput): Promise<IngestionQueueJob | undefined> {
    assertPositiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const workerId = nonBlank(input.workerId, "workerId");
    const now = nonBlank(input.now, "now");
    const candidate = [...this.jobs.values()]
      .filter((job) => job.status === "queued")
      .filter((job) => Date.parse(job.availableAt) <= Date.parse(now))
      .filter((job) => input.tenantId === undefined || job.tenantId === input.tenantId)
      .filter((job) => input.namespaceId === undefined || job.namespaceId === input.namespaceId)
      .filter(
        (job) =>
          input.sourceIds === undefined ||
          input.sourceIds.length === 0 ||
          job.sourceIds.some((sourceId) => input.sourceIds?.includes(sourceId))
      )
      .sort(compareQueueJobsForClaim)[0];
    if (candidate === undefined) {
      return undefined;
    }

    const leased = withoutTerminalFields({
      ...candidate,
      status: "leased",
      attempt: candidate.attempt + 1,
      leasedBy: workerId,
      leaseExpiresAt: addMilliseconds(now, input.leaseTtlMs),
      updatedAt: now
    });
    this.jobs.set(leased.queueId, leased);
    return leased;
  }

  async complete(input: CompleteIngestionJobInput): Promise<IngestionQueueJob> {
    const existing = this.requireClaimedJob(input.queueId, input.workerId);
    const completed: IngestionQueueJob = {
      queueId: existing.queueId,
      jobId: existing.jobId,
      ...(existing.runId === undefined ? {} : { runId: existing.runId }),
      tenantId: existing.tenantId,
      namespaceId: existing.namespaceId,
      sourceIds: existing.sourceIds,
      priority: existing.priority,
      status: "completed",
      attempt: existing.attempt,
      maxAttempts: existing.maxAttempts,
      availableAt: existing.availableAt,
      enqueuedAt: existing.enqueuedAt,
      updatedAt: input.now,
      finishedAt: input.now,
      ...(existing.metadata === undefined ? {} : { metadata: existing.metadata })
    };
    this.jobs.set(completed.queueId, completed);
    return completed;
  }

  async heartbeat(input: HeartbeatIngestionQueueJobInput): Promise<IngestionQueueJob | undefined> {
    assertPositiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const existing = this.jobs.get(input.queueId);
    if (
      existing === undefined ||
      existing.status !== "leased" ||
      existing.leasedBy !== input.workerId ||
      existing.leaseExpiresAt === undefined ||
      Date.parse(existing.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      return undefined;
    }

    const refreshed: IngestionQueueJob = {
      ...existing,
      leaseExpiresAt: addMilliseconds(input.now, input.leaseTtlMs),
      updatedAt: input.now
    };
    this.jobs.set(refreshed.queueId, refreshed);
    return refreshed;
  }

  async fail(input: FailIngestionJobInput): Promise<IngestionQueueJob> {
    const existing = this.requireClaimedJob(input.queueId, input.workerId);
    const retry = input.retryable && existing.attempt < existing.maxAttempts;
    const failed: IngestionQueueJob = {
      queueId: existing.queueId,
      jobId: existing.jobId,
      ...(existing.runId === undefined ? {} : { runId: existing.runId }),
      tenantId: existing.tenantId,
      namespaceId: existing.namespaceId,
      sourceIds: existing.sourceIds,
      priority: existing.priority,
      status: retry ? "queued" : "dead_letter",
      attempt: existing.attempt,
      maxAttempts: existing.maxAttempts,
      availableAt: retry ? (input.nextAvailableAt ?? input.now) : existing.availableAt,
      enqueuedAt: existing.enqueuedAt,
      updatedAt: input.now,
      ...(retry ? {} : { finishedAt: input.now }),
      ...(input.errorName === undefined
        ? existingErrorName(existing)
        : { errorName: input.errorName }),
      ...(input.errorMessage === undefined
        ? existingErrorMessage(existing)
        : { errorMessage: input.errorMessage }),
      ...(existing.metadata === undefined ? {} : { metadata: existing.metadata })
    };
    this.jobs.set(failed.queueId, failed);
    return failed;
  }

  async cancel(input: CancelIngestionJobInput): Promise<IngestionQueueJob> {
    const existing = this.requireJob(input.queueId);
    if (existing.status !== "queued" && existing.status !== "leased") {
      throw new Error(
        `Ingestion queue job "${input.queueId}" cannot be cancelled from ${existing.status}.`
      );
    }
    const cancelled: IngestionQueueJob = {
      queueId: existing.queueId,
      jobId: existing.jobId,
      ...(existing.runId === undefined ? {} : { runId: existing.runId }),
      tenantId: existing.tenantId,
      namespaceId: existing.namespaceId,
      sourceIds: existing.sourceIds,
      priority: existing.priority,
      status: "cancelled",
      attempt: existing.attempt,
      maxAttempts: existing.maxAttempts,
      availableAt: existing.availableAt,
      enqueuedAt: existing.enqueuedAt,
      updatedAt: input.now,
      finishedAt: input.now,
      ...(existing.errorName === undefined ? {} : { errorName: existing.errorName }),
      errorMessage: input.reason ?? existing.errorMessage ?? "Ingestion queue job cancelled.",
      ...(existing.metadata === undefined ? {} : { metadata: existing.metadata })
    };
    this.jobs.set(cancelled.queueId, cancelled);
    return cancelled;
  }

  async requeue(input: RequeueIngestionJobInput): Promise<IngestionQueueJob> {
    const existing = this.requireJob(input.queueId);
    if (existing.status !== "dead_letter") {
      throw new Error(`Ingestion queue job "${input.queueId}" is not dead-lettered.`);
    }
    const maxAttempts = input.maxAttempts ?? existing.maxAttempts;
    assertPositiveInteger(maxAttempts, "maxAttempts");
    const metadata = requeueMetadata(existing.metadata, input.metadata, input.reason);
    const requeued: IngestionQueueJob = {
      queueId: existing.queueId,
      jobId: existing.jobId,
      ...(existing.runId === undefined ? {} : { runId: existing.runId }),
      tenantId: existing.tenantId,
      namespaceId: existing.namespaceId,
      sourceIds: existing.sourceIds,
      priority: existing.priority,
      status: "queued",
      attempt: 0,
      maxAttempts,
      availableAt: input.availableAt ?? input.now,
      enqueuedAt: existing.enqueuedAt,
      updatedAt: input.now,
      ...(existing.errorName === undefined ? {} : { errorName: existing.errorName }),
      ...(existing.errorMessage === undefined ? {} : { errorMessage: existing.errorMessage }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata })
    };
    this.jobs.set(requeued.queueId, requeued);
    return requeued;
  }

  async get(queueId: string): Promise<IngestionQueueJob | undefined> {
    return this.jobs.get(queueId);
  }

  async list(filter: IngestionQueueListFilter = {}): Promise<readonly IngestionQueueJob[]> {
    const rows = [...this.jobs.values()]
      .filter((job) => filter.tenantId === undefined || job.tenantId === filter.tenantId)
      .filter((job) => filter.namespaceId === undefined || job.namespaceId === filter.namespaceId)
      .filter((job) => filter.statuses === undefined || filter.statuses.includes(job.status))
      .sort(compareQueueJobsForList);
    return filter.limit === undefined ? rows : rows.slice(0, Math.max(0, filter.limit));
  }

  private requireJob(queueId: string): IngestionQueueJob {
    const job = this.jobs.get(queueId);
    if (job === undefined) {
      throw new Error(`Ingestion queue job "${queueId}" does not exist.`);
    }
    return job;
  }

  private requireClaimedJob(queueId: string, workerId: string): IngestionQueueJob {
    const job = this.requireJob(queueId);
    if (job.status !== "leased" || job.leasedBy !== workerId) {
      throw new Error(`Ingestion queue job "${queueId}" is not leased by "${workerId}".`);
    }
    return job;
  }
}

export class InMemoryIngestionLeaseStore implements IngestionLeaseStore {
  private readonly leases = new Map<string, IngestionLeaseRecord>();
  private sequence = 0;

  async acquire(input: AcquireIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined> {
    assertPositiveInteger(input.ttlMs, "ttlMs");
    const resourceId = nonBlank(input.resourceId, "resourceId");
    const holderId = nonBlank(input.holderId, "holderId");
    const existing = this.leases.get(resourceId);
    if (existing !== undefined && Date.parse(existing.leaseExpiresAt) > Date.parse(input.now)) {
      return existing.holderId === holderId ? existing : undefined;
    }

    this.sequence += 1;
    const lease: IngestionLeaseRecord = {
      resourceId,
      holderId,
      token: `${resourceId}:${holderId}:${this.sequence}`,
      acquiredAt: input.now,
      updatedAt: input.now,
      leaseExpiresAt: addMilliseconds(input.now, input.ttlMs),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    };
    this.leases.set(resourceId, lease);
    return lease;
  }

  async heartbeat(input: HeartbeatIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined> {
    assertPositiveInteger(input.ttlMs, "ttlMs");
    const existing = this.leases.get(input.resourceId);
    if (
      existing === undefined ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token ||
      Date.parse(existing.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      return undefined;
    }

    const refreshed: IngestionLeaseRecord = {
      ...existing,
      updatedAt: input.now,
      leaseExpiresAt: addMilliseconds(input.now, input.ttlMs)
    };
    this.leases.set(refreshed.resourceId, refreshed);
    return refreshed;
  }

  async release(input: ReleaseIngestionLeaseInput): Promise<boolean> {
    const existing = this.leases.get(input.resourceId);
    if (
      existing === undefined ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      return false;
    }

    this.leases.delete(input.resourceId);
    return true;
  }

  async get(resourceId: string): Promise<IngestionLeaseRecord | undefined> {
    return this.leases.get(resourceId);
  }
}

export class InMemoryIndexGenerationStore implements IndexGenerationStore {
  private readonly manifests = new Map<string, IndexGenerationManifest>();
  private readonly promotions = new Map<string, GenerationPromotionRecord>();

  async saveManifest(input: SaveIndexGenerationManifestInput): Promise<IndexGenerationManifest> {
    this.manifests.set(input.manifest.generationId, input.manifest);
    return input.manifest;
  }

  async getManifest(generationId: string): Promise<IndexGenerationManifest | undefined> {
    return this.manifests.get(generationId);
  }

  async getActiveManifest(input: {
    readonly tenantId: string;
    readonly namespaceId: string;
  }): Promise<IndexGenerationManifest | undefined> {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.tenantId === input.tenantId)
      .filter((manifest) => manifest.namespaceId === input.namespaceId)
      .filter((manifest) => manifest.status === "active")
      .sort(compareGenerationManifests)[0];
  }

  async listManifests(
    filter: IndexGenerationListFilter = {}
  ): Promise<readonly IndexGenerationManifest[]> {
    const rows = [...this.manifests.values()]
      .filter((manifest) => filter.tenantId === undefined || manifest.tenantId === filter.tenantId)
      .filter(
        (manifest) =>
          filter.namespaceId === undefined || manifest.namespaceId === filter.namespaceId
      )
      .filter(
        (manifest) => filter.statuses === undefined || filter.statuses.includes(manifest.status)
      )
      .sort(compareGenerationManifests);
    return filter.limit === undefined ? rows : rows.slice(0, Math.max(0, filter.limit));
  }

  async savePromotion(input: SaveGenerationPromotionInput): Promise<GenerationPromotionRecord> {
    const evalResults = [...(input.evalResults ?? [])];
    const record: GenerationPromotionRecord = {
      promotionId: nonBlank(input.promotionId, "promotionId"),
      tenantId: input.plan.tenantId,
      namespaceId: input.plan.namespaceId,
      candidateGenerationId: input.plan.candidateGenerationId,
      ...(input.plan.previousActiveGenerationId === undefined
        ? {}
        : { previousActiveGenerationId: input.plan.previousActiveGenerationId }),
      requiredEvalIds: input.plan.requiredEvalIds,
      actions: input.plan.actions,
      plannedAt: input.plan.plannedAt,
      status: promotionStatusFor(input.plan.requiredEvalIds, evalResults),
      evalResults,
      updatedAt: input.savedAt
    };
    this.promotions.set(record.promotionId, record);
    return record;
  }

  async getPromotion(promotionId: string): Promise<GenerationPromotionRecord | undefined> {
    return this.promotions.get(promotionId);
  }

  async recordEvalResult(
    input: RecordGenerationEvalResultInput
  ): Promise<GenerationPromotionRecord> {
    const existing = this.requirePromotion(input.promotionId);
    const evalResults = upsertEvalResult(existing.evalResults, input.result);
    const updated: GenerationPromotionRecord = {
      ...withoutPromotionTerminalFields(existing),
      status: promotionStatusFor(existing.requiredEvalIds, evalResults),
      evalResults,
      updatedAt: input.recordedAt
    };
    this.promotions.set(updated.promotionId, updated);
    return updated;
  }

  async promote(input: PromoteGenerationInput): Promise<GenerationPromotionRecord> {
    const existing = this.requirePromotion(input.promotionId);
    const readiness = generationPromotionReadiness(existing);
    if (!readiness.ready) {
      throw new Error(readiness.reason);
    }
    const candidate = this.requireManifest(existing.candidateGenerationId);
    const active = this.activeManifestSync(existing.tenantId, existing.namespaceId);
    if (active !== undefined && active.generationId !== candidate.generationId) {
      this.manifests.set(active.generationId, {
        ...active,
        status: "deprecated",
        deprecatedAt: input.promotedAt
      });
    }
    const promotedCandidate: IndexGenerationManifest = {
      ...candidate,
      status: "active",
      promotedAt: input.promotedAt
    };
    this.manifests.set(promotedCandidate.generationId, promotedCandidate);

    const promoted: GenerationPromotionRecord = {
      ...withoutPromotionTerminalFields(existing),
      status: "promoted",
      evalResults: existing.evalResults,
      updatedAt: input.promotedAt,
      promotedAt: input.promotedAt
    };
    this.promotions.set(promoted.promotionId, promoted);
    return promoted;
  }

  private requireManifest(generationId: string): IndexGenerationManifest {
    const manifest = this.manifests.get(generationId);
    if (manifest === undefined) {
      throw new Error(`Index generation manifest "${generationId}" does not exist.`);
    }
    return manifest;
  }

  private requirePromotion(promotionId: string): GenerationPromotionRecord {
    const promotion = this.promotions.get(promotionId);
    if (promotion === undefined) {
      throw new Error(`Generation promotion "${promotionId}" does not exist.`);
    }
    return promotion;
  }

  private activeManifestSync(
    tenantId: string,
    namespaceId: string
  ): IndexGenerationManifest | undefined {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.tenantId === tenantId)
      .filter((manifest) => manifest.namespaceId === namespaceId)
      .filter((manifest) => manifest.status === "active")
      .sort(compareGenerationManifests)[0];
  }
}

export interface PostgresIngestionScaleStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
}

const DEFAULT_SCHEMA = "rag_core";

export class PostgresIngestionJobQueue implements IngestionJobQueue {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionScaleStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error("PostgresIngestionJobQueue requires pool, connectionString, or poolConfig.");
    }

    this.pool =
      options.pool ??
      new pg.Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString })
      });
    this.schema = assertSafeIdentifier(options.schema ?? DEFAULT_SCHEMA, "schema");
  }

  async enqueue(input: EnqueueIngestionJobInput): Promise<IngestionQueueJob> {
    const enqueuedAt = nonBlank(input.enqueuedAt, "enqueuedAt");
    const result = await this.pool.query<IngestionQueueJobRow>(
      `insert into ${this.q("ingestion_queue")} (
        queue_id, job_id, run_id, tenant_id, namespace_id, source_ids, priority,
        status, attempt, max_attempts, available_at, enqueued_at, updated_at, metadata
      ) values (
        $1, $2, $3, $4, $5, $6::text[], $7, 'queued', 0, $8, $9, $10, $10, $11::jsonb
      )
      returning *`,
      [
        nonBlank(input.queueId ?? input.jobId, "queueId"),
        nonBlank(input.jobId, "jobId"),
        input.runId ?? null,
        nonBlank(input.tenantId, "tenantId"),
        nonBlank(input.namespaceId, "namespaceId"),
        input.sourceIds.map((sourceId) => nonBlank(sourceId, "sourceId")),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        input.availableAt ?? enqueuedAt,
        enqueuedAt,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return ingestionQueueJobFromRow(requireQueueRow(result.rows[0], input.queueId ?? input.jobId));
  }

  async claimNext(input: ClaimIngestionJobInput): Promise<IngestionQueueJob | undefined> {
    assertPositiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const now = nonBlank(input.now, "now");
    const workerId = nonBlank(input.workerId, "workerId");
    const sourceIds =
      input.sourceIds === undefined || input.sourceIds.length === 0 ? null : input.sourceIds;
    const result = await this.pool.query<IngestionQueueJobRow>(
      `with candidate as (
        select queue_id
        from ${this.q("ingestion_queue")}
        where (
            (status = 'queued' and available_at <= $1)
            or (status = 'leased' and lease_expires_at <= $1)
          )
          and ($4::text is null or tenant_id = $4)
          and ($5::text is null or namespace_id = $5)
          and ($6::text[] is null or source_ids && $6::text[])
        order by priority desc, available_at asc, enqueued_at asc, queue_id asc
        for update skip locked
        limit 1
      )
      update ${this.q("ingestion_queue")} queue
      set status = 'leased',
          attempt = queue.attempt + 1,
          leased_by = $2,
          lease_expires_at = $3,
          finished_at = null,
          updated_at = $1
      from candidate
      where queue.queue_id = candidate.queue_id
      returning queue.*`,
      [
        now,
        workerId,
        addMilliseconds(now, input.leaseTtlMs),
        input.tenantId ?? null,
        input.namespaceId ?? null,
        sourceIds
      ]
    );
    return result.rows[0] === undefined ? undefined : ingestionQueueJobFromRow(result.rows[0]);
  }

  async complete(input: CompleteIngestionJobInput): Promise<IngestionQueueJob> {
    const result = await this.pool.query<IngestionQueueJobRow>(
      `update ${this.q("ingestion_queue")}
       set status = 'completed',
           leased_by = null,
           lease_expires_at = null,
           updated_at = $3,
           finished_at = $3
       where queue_id = $1
         and status = 'leased'
         and leased_by = $2
       returning *`,
      [input.queueId, input.workerId, input.now]
    );
    return ingestionQueueJobFromRow(requireQueueRow(result.rows[0], input.queueId));
  }

  async heartbeat(input: HeartbeatIngestionQueueJobInput): Promise<IngestionQueueJob | undefined> {
    assertPositiveInteger(input.leaseTtlMs, "leaseTtlMs");
    const result = await this.pool.query<IngestionQueueJobRow>(
      `update ${this.q("ingestion_queue")}
       set lease_expires_at = $4,
           updated_at = $3
       where queue_id = $1
         and status = 'leased'
         and leased_by = $2
         and lease_expires_at > $3
       returning *`,
      [input.queueId, input.workerId, input.now, addMilliseconds(input.now, input.leaseTtlMs)]
    );
    return result.rows[0] === undefined ? undefined : ingestionQueueJobFromRow(result.rows[0]);
  }

  async fail(input: FailIngestionJobInput): Promise<IngestionQueueJob> {
    const result = await this.pool.query<IngestionQueueJobRow>(
      `update ${this.q("ingestion_queue")}
       set status = case
             when $4::boolean and attempt < max_attempts then 'queued'
             else 'dead_letter'
           end,
           available_at = case
             when $4::boolean and attempt < max_attempts then coalesce($5, $3)
             else available_at
           end,
           leased_by = null,
           lease_expires_at = null,
           updated_at = $3,
           finished_at = case
             when $4::boolean and attempt < max_attempts then null
             else $3
           end,
           error_name = coalesce($6, error_name),
           error_message = coalesce($7, error_message)
       where queue_id = $1
         and status = 'leased'
         and leased_by = $2
       returning *`,
      [
        input.queueId,
        input.workerId,
        input.now,
        input.retryable,
        input.nextAvailableAt ?? null,
        input.errorName ?? null,
        input.errorMessage ?? null
      ]
    );
    return ingestionQueueJobFromRow(requireQueueRow(result.rows[0], input.queueId));
  }

  async cancel(input: CancelIngestionJobInput): Promise<IngestionQueueJob> {
    const result = await this.pool.query<IngestionQueueJobRow>(
      `update ${this.q("ingestion_queue")}
       set status = 'cancelled',
           leased_by = null,
           lease_expires_at = null,
           updated_at = $2,
           finished_at = $2,
           error_message = coalesce($3, error_message, 'Ingestion queue job cancelled.')
       where queue_id = $1
         and status in ('queued', 'leased')
       returning *`,
      [input.queueId, input.now, input.reason ?? null]
    );
    return ingestionQueueJobFromRow(requireQueueRow(result.rows[0], input.queueId));
  }

  async requeue(input: RequeueIngestionJobInput): Promise<IngestionQueueJob> {
    if (input.maxAttempts !== undefined) {
      assertPositiveInteger(input.maxAttempts, "maxAttempts");
    }
    const metadata = requeueMetadata(undefined, input.metadata, input.reason);
    const result = await this.pool.query<IngestionQueueJobRow>(
      `update ${this.q("ingestion_queue")}
       set status = 'queued',
           attempt = 0,
           max_attempts = coalesce($4, max_attempts),
           available_at = coalesce($3, $2),
           leased_by = null,
           lease_expires_at = null,
           updated_at = $2,
           finished_at = null,
           metadata = metadata || $5::jsonb
       where queue_id = $1
         and status = 'dead_letter'
       returning *`,
      [
        input.queueId,
        input.now,
        input.availableAt ?? null,
        input.maxAttempts ?? null,
        JSON.stringify(metadata)
      ]
    );
    return ingestionQueueJobFromRow(requireQueueRow(result.rows[0], input.queueId));
  }

  async get(queueId: string): Promise<IngestionQueueJob | undefined> {
    const result = await this.pool.query<IngestionQueueJobRow>(
      `select * from ${this.q("ingestion_queue")} where queue_id = $1`,
      [queueId]
    );
    return result.rows[0] === undefined ? undefined : ingestionQueueJobFromRow(result.rows[0]);
  }

  async list(filter: IngestionQueueListFilter = {}): Promise<readonly IngestionQueueJob[]> {
    const result = await this.pool.query<IngestionQueueJobRow>(
      `select * from ${this.q("ingestion_queue")}
       where ($1::text is null or tenant_id = $1)
         and ($2::text is null or namespace_id = $2)
         and ($3::text[] is null or status = any($3::text[]))
       order by updated_at desc, priority desc, queue_id asc
       limit $4`,
      [
        filter.tenantId ?? null,
        filter.namespaceId ?? null,
        filter.statuses ?? null,
        filter.limit ?? 100
      ]
    );
    return result.rows.map(ingestionQueueJobFromRow);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export class PostgresIngestionLeaseStore implements IngestionLeaseStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionScaleStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error(
        "PostgresIngestionLeaseStore requires pool, connectionString, or poolConfig."
      );
    }

    this.pool =
      options.pool ??
      new pg.Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString })
      });
    this.schema = assertSafeIdentifier(options.schema ?? DEFAULT_SCHEMA, "schema");
  }

  async acquire(input: AcquireIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined> {
    assertPositiveInteger(input.ttlMs, "ttlMs");
    const token = `${input.resourceId}:${input.holderId}:${randomUUID()}`;
    const result = await this.pool.query<IngestionLeaseRow>(
      `insert into ${this.q("ingestion_leases")} (
        resource_id, holder_id, token, acquired_at, updated_at, lease_expires_at, metadata
      ) values ($1, $2, $3, $4, $4, $5, $6::jsonb)
      on conflict (resource_id) do update set
        holder_id = excluded.holder_id,
        token = excluded.token,
        acquired_at = excluded.acquired_at,
        updated_at = excluded.updated_at,
        lease_expires_at = excluded.lease_expires_at,
        metadata = excluded.metadata
      where ${this.q("ingestion_leases")}.lease_expires_at <= $4
         or ${this.q("ingestion_leases")}.holder_id = $2
      returning *`,
      [
        nonBlank(input.resourceId, "resourceId"),
        nonBlank(input.holderId, "holderId"),
        token,
        nonBlank(input.now, "now"),
        addMilliseconds(input.now, input.ttlMs),
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return result.rows[0] === undefined ? undefined : ingestionLeaseFromRow(result.rows[0]);
  }

  async heartbeat(input: HeartbeatIngestionLeaseInput): Promise<IngestionLeaseRecord | undefined> {
    assertPositiveInteger(input.ttlMs, "ttlMs");
    const result = await this.pool.query<IngestionLeaseRow>(
      `update ${this.q("ingestion_leases")}
       set updated_at = $4,
           lease_expires_at = $5
       where resource_id = $1
         and holder_id = $2
         and token = $3
         and lease_expires_at > $4
       returning *`,
      [
        input.resourceId,
        input.holderId,
        input.token,
        input.now,
        addMilliseconds(input.now, input.ttlMs)
      ]
    );
    return result.rows[0] === undefined ? undefined : ingestionLeaseFromRow(result.rows[0]);
  }

  async release(input: ReleaseIngestionLeaseInput): Promise<boolean> {
    const result = await this.pool.query<{ readonly resource_id: string }>(
      `delete from ${this.q("ingestion_leases")}
       where resource_id = $1
         and holder_id = $2
         and token = $3
       returning resource_id`,
      [input.resourceId, input.holderId, input.token]
    );
    return result.rows.length > 0;
  }

  async get(resourceId: string): Promise<IngestionLeaseRecord | undefined> {
    const result = await this.pool.query<IngestionLeaseRow>(
      `select * from ${this.q("ingestion_leases")} where resource_id = $1`,
      [resourceId]
    );
    return result.rows[0] === undefined ? undefined : ingestionLeaseFromRow(result.rows[0]);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export class PostgresIndexGenerationStore implements IndexGenerationStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionScaleStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error(
        "PostgresIndexGenerationStore requires pool, connectionString, or poolConfig."
      );
    }

    this.pool =
      options.pool ??
      new pg.Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString === undefined
          ? {}
          : { connectionString: options.connectionString })
      });
    this.schema = assertSafeIdentifier(options.schema ?? DEFAULT_SCHEMA, "schema");
  }

  async saveManifest(input: SaveIndexGenerationManifestInput): Promise<IndexGenerationManifest> {
    const result = await this.pool.query<IndexGenerationManifestRow>(
      `insert into ${this.q("index_generation_manifests")} (
        generation_id, tenant_id, namespace_id, profile_id, status, manifest,
        created_at, updated_at, promoted_at, deprecated_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $7, $8, $9)
      on conflict (generation_id) do update set
        tenant_id = excluded.tenant_id,
        namespace_id = excluded.namespace_id,
        profile_id = excluded.profile_id,
        status = excluded.status,
        manifest = excluded.manifest,
        updated_at = excluded.updated_at,
        promoted_at = excluded.promoted_at,
        deprecated_at = excluded.deprecated_at
      returning *`,
      [
        input.manifest.generationId,
        input.manifest.tenantId,
        input.manifest.namespaceId,
        input.manifest.profileId,
        input.manifest.status,
        JSON.stringify(input.manifest),
        input.savedAt,
        input.manifest.promotedAt ?? null,
        input.manifest.deprecatedAt ?? null
      ]
    );
    return indexGenerationManifestFromRow(
      requireManifestRow(result.rows[0], input.manifest.generationId)
    );
  }

  async getManifest(generationId: string): Promise<IndexGenerationManifest | undefined> {
    const result = await this.pool.query<IndexGenerationManifestRow>(
      `select * from ${this.q("index_generation_manifests")} where generation_id = $1`,
      [generationId]
    );
    return result.rows[0] === undefined
      ? undefined
      : indexGenerationManifestFromRow(result.rows[0]);
  }

  async getActiveManifest(input: {
    readonly tenantId: string;
    readonly namespaceId: string;
  }): Promise<IndexGenerationManifest | undefined> {
    const result = await this.pool.query<IndexGenerationManifestRow>(
      `select * from ${this.q("index_generation_manifests")}
       where tenant_id = $1
         and namespace_id = $2
         and status = 'active'
       order by promoted_at desc nulls last, updated_at desc, generation_id asc
       limit 1`,
      [input.tenantId, input.namespaceId]
    );
    return result.rows[0] === undefined
      ? undefined
      : indexGenerationManifestFromRow(result.rows[0]);
  }

  async listManifests(
    filter: IndexGenerationListFilter = {}
  ): Promise<readonly IndexGenerationManifest[]> {
    const result = await this.pool.query<IndexGenerationManifestRow>(
      `select * from ${this.q("index_generation_manifests")}
       where ($1::text is null or tenant_id = $1)
         and ($2::text is null or namespace_id = $2)
         and ($3::text[] is null or status = any($3::text[]))
       order by updated_at desc, generation_id asc
       limit $4`,
      [
        filter.tenantId ?? null,
        filter.namespaceId ?? null,
        filter.statuses ?? null,
        filter.limit ?? 100
      ]
    );
    return result.rows.map(indexGenerationManifestFromRow);
  }

  async savePromotion(input: SaveGenerationPromotionInput): Promise<GenerationPromotionRecord> {
    const evalResults = [...(input.evalResults ?? [])];
    const status = promotionStatusFor(input.plan.requiredEvalIds, evalResults);
    const result = await this.pool.query<GenerationPromotionRow>(
      `insert into ${this.q("index_generation_promotions")} (
        promotion_id, tenant_id, namespace_id, candidate_generation_id,
        previous_active_generation_id, required_eval_ids, actions, status,
        planned_at, updated_at, eval_results
      ) values ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10, $11::jsonb)
      on conflict (promotion_id) do update set
        required_eval_ids = excluded.required_eval_ids,
        actions = excluded.actions,
        status = excluded.status,
        updated_at = excluded.updated_at,
        eval_results = excluded.eval_results
      returning *`,
      [
        input.promotionId,
        input.plan.tenantId,
        input.plan.namespaceId,
        input.plan.candidateGenerationId,
        input.plan.previousActiveGenerationId ?? null,
        input.plan.requiredEvalIds,
        input.plan.actions,
        status,
        input.plan.plannedAt,
        input.savedAt,
        JSON.stringify(evalResults)
      ]
    );
    return generationPromotionRecordFromRow(requirePromotionRow(result.rows[0], input.promotionId));
  }

  async getPromotion(promotionId: string): Promise<GenerationPromotionRecord | undefined> {
    const result = await this.pool.query<GenerationPromotionRow>(
      `select * from ${this.q("index_generation_promotions")} where promotion_id = $1`,
      [promotionId]
    );
    return result.rows[0] === undefined
      ? undefined
      : generationPromotionRecordFromRow(result.rows[0]);
  }

  async recordEvalResult(
    input: RecordGenerationEvalResultInput
  ): Promise<GenerationPromotionRecord> {
    const existing = await this.getPromotion(input.promotionId);
    if (existing === undefined) {
      throw new Error(`Generation promotion "${input.promotionId}" does not exist.`);
    }
    const evalResults = upsertEvalResult(existing.evalResults, input.result);
    const status = promotionStatusFor(existing.requiredEvalIds, evalResults);
    const result = await this.pool.query<GenerationPromotionRow>(
      `update ${this.q("index_generation_promotions")}
       set status = $2,
           updated_at = $3,
           eval_results = $4::jsonb
       where promotion_id = $1
       returning *`,
      [input.promotionId, status, input.recordedAt, JSON.stringify(evalResults)]
    );
    return generationPromotionRecordFromRow(requirePromotionRow(result.rows[0], input.promotionId));
  }

  async promote(input: PromoteGenerationInput): Promise<GenerationPromotionRecord> {
    const existing = await this.getPromotion(input.promotionId);
    if (existing === undefined) {
      throw new Error(`Generation promotion "${input.promotionId}" does not exist.`);
    }
    const readiness = generationPromotionReadiness(existing);
    if (!readiness.ready) {
      throw new Error(readiness.reason);
    }
    const candidate = await this.getManifest(existing.candidateGenerationId);
    if (candidate === undefined) {
      throw new Error(
        `Index generation manifest "${existing.candidateGenerationId}" does not exist.`
      );
    }
    const result = await this.pool.query<GenerationPromotionRow>(
      `with updated_manifests as (
        update ${this.q("index_generation_manifests")}
        set status = case
              when generation_id = $5 then 'active'
              else 'deprecated'
            end,
            updated_at = $2,
            promoted_at = case
              when generation_id = $5 then $2
              else promoted_at
            end,
            deprecated_at = case
              when generation_id = $5 then null
              else $2
            end,
            manifest = case
              when generation_id = $5 then
                (manifest || jsonb_build_object('status', 'active', 'promotedAt', $2::text)) - 'deprecatedAt'
              else
                manifest || jsonb_build_object('status', 'deprecated', 'deprecatedAt', $2::text)
            end
        where generation_id = $5
           or (
             tenant_id = $3
             and namespace_id = $4
             and status = 'active'
             and generation_id <> $5
           )
        returning generation_id
      )
      update ${this.q("index_generation_promotions")}
       set status = 'promoted',
           updated_at = $2,
           promoted_at = $2,
           failure_reason = null
       where promotion_id = $1
         and exists (select 1 from updated_manifests where generation_id = $5)
       returning *`,
      [
        input.promotionId,
        input.promotedAt,
        existing.tenantId,
        existing.namespaceId,
        existing.candidateGenerationId
      ]
    );
    return generationPromotionRecordFromRow(requirePromotionRow(result.rows[0], input.promotionId));
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export function planIngestionBackfillJobs(
  request: IngestionBackfillPlanRequest
): IngestionBackfillPlan {
  assertPositiveInteger(request.batchSize, "batchSize");
  const sourceIds = request.sourceIds.map((sourceId) => nonBlank(sourceId, "sourceId"));
  const jobs = chunk(sourceIds, request.batchSize).map((batch, index): EnqueueIngestionJobInput => {
    const ordinal = index + 1;
    return {
      queueId: `${request.planId}_queue_${ordinal}`,
      jobId: `${request.planId}_job_${ordinal}`,
      runId: `${request.planId}_run_${ordinal}`,
      tenantId: request.tenantId,
      namespaceId: request.namespaceId,
      sourceIds: batch,
      priority: request.priority ?? 0,
      maxAttempts: request.maxAttempts ?? 3,
      enqueuedAt: request.requestedAt,
      ...(request.availableAt === undefined ? {} : { availableAt: request.availableAt }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata })
    };
  });

  return {
    planId: nonBlank(request.planId, "planId"),
    tenantId: nonBlank(request.tenantId, "tenantId"),
    namespaceId: nonBlank(request.namespaceId, "namespaceId"),
    requestedAt: nonBlank(request.requestedAt, "requestedAt"),
    batchSize: request.batchSize,
    jobCount: jobs.length,
    jobs
  };
}

export function planGenerationPromotion(
  input: PlanGenerationPromotionInput
): GenerationPromotionPlan {
  if (input.candidate.status !== "candidate") {
    throw new Error("Generation promotion requires a candidate generation.");
  }
  if (
    input.active !== undefined &&
    (input.active.tenantId !== input.candidate.tenantId ||
      input.active.namespaceId !== input.candidate.namespaceId)
  ) {
    throw new Error("Generation promotion requires candidate and active generations in one scope.");
  }

  return {
    tenantId: input.candidate.tenantId,
    namespaceId: input.candidate.namespaceId,
    candidateGenerationId: input.candidate.generationId,
    ...(input.active === undefined
      ? {}
      : { previousActiveGenerationId: input.active.generationId }),
    requiredEvalIds: [...(input.requiredEvalIds ?? [])],
    actions: [
      "validate_candidate_generation",
      "run_required_evals",
      "switch_active_generation",
      ...(input.active === undefined ? [] : (["mark_previous_generation_deprecated"] as const)),
      ...(input.archivePrevious === true && input.active !== undefined
        ? (["archive_previous_generation"] as const)
        : [])
    ],
    plannedAt: input.plannedAt
  };
}

export function planReindex(request: ReindexPlanRequest): ReindexPlan {
  const backfill = planIngestionBackfillJobs({
    planId: request.planId,
    tenantId: request.tenantId,
    namespaceId: request.namespaceId,
    sourceIds: request.sourceIds,
    requestedAt: request.requestedAt,
    batchSize: request.batchSize,
    ...(request.priority === undefined ? {} : { priority: request.priority }),
    ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
    ...(request.availableAt === undefined ? {} : { availableAt: request.availableAt }),
    metadata: {
      ...(request.metadata ?? {}),
      reindexGenerationId: request.candidateGeneration.generationId
    }
  });

  return {
    planId: request.planId,
    backfill,
    candidateGeneration: request.candidateGeneration,
    promotion: planGenerationPromotion({
      candidate: request.candidateGeneration,
      ...(request.activeGeneration === undefined ? {} : { active: request.activeGeneration }),
      ...(request.requiredEvalIds === undefined
        ? {}
        : { requiredEvalIds: request.requiredEvalIds }),
      plannedAt: request.requestedAt
    })
  };
}

function compareQueueJobsForClaim(first: IngestionQueueJob, second: IngestionQueueJob): number {
  return (
    second.priority - first.priority ||
    first.availableAt.localeCompare(second.availableAt) ||
    first.enqueuedAt.localeCompare(second.enqueuedAt) ||
    first.queueId.localeCompare(second.queueId)
  );
}

function compareQueueJobsForList(first: IngestionQueueJob, second: IngestionQueueJob): number {
  return (
    second.updatedAt.localeCompare(first.updatedAt) ||
    second.priority - first.priority ||
    first.queueId.localeCompare(second.queueId)
  );
}

function compareGenerationManifests(
  first: IndexGenerationManifest,
  second: IndexGenerationManifest
): number {
  const firstTimestamp = first.promotedAt ?? first.deprecatedAt ?? first.createdAt;
  const secondTimestamp = second.promotedAt ?? second.deprecatedAt ?? second.createdAt;
  return (
    secondTimestamp.localeCompare(firstTimestamp) ||
    first.generationId.localeCompare(second.generationId)
  );
}

interface IngestionQueueJobRow {
  readonly queue_id: string;
  readonly job_id: string;
  readonly run_id: string | null;
  readonly tenant_id: string;
  readonly namespace_id: string;
  readonly source_ids: readonly string[];
  readonly priority: number;
  readonly status: IngestionQueueStatus;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly available_at: Date | string;
  readonly enqueued_at: Date | string;
  readonly updated_at: Date | string;
  readonly leased_by: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly error_name: string | null;
  readonly error_message: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

interface IngestionLeaseRow {
  readonly resource_id: string;
  readonly holder_id: string;
  readonly token: string;
  readonly acquired_at: Date | string;
  readonly updated_at: Date | string;
  readonly lease_expires_at: Date | string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

interface IndexGenerationManifestRow {
  readonly generation_id: string;
  readonly tenant_id: string;
  readonly namespace_id: string;
  readonly profile_id: string;
  readonly status: IndexGenerationStatus;
  readonly manifest: IndexGenerationManifest;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly promoted_at: Date | string | null;
  readonly deprecated_at: Date | string | null;
}

interface GenerationPromotionRow {
  readonly promotion_id: string;
  readonly tenant_id: string;
  readonly namespace_id: string;
  readonly candidate_generation_id: string;
  readonly previous_active_generation_id: string | null;
  readonly required_eval_ids: readonly string[];
  readonly actions: readonly GenerationPromotionAction[];
  readonly status: GenerationPromotionStatus;
  readonly planned_at: Date | string;
  readonly updated_at: Date | string;
  readonly promoted_at: Date | string | null;
  readonly failure_reason: string | null;
  readonly eval_results: readonly GenerationEvalResult[];
}

function ingestionQueueJobFromRow(row: IngestionQueueJobRow): IngestionQueueJob {
  return {
    queueId: row.queue_id,
    jobId: row.job_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    tenantId: row.tenant_id,
    namespaceId: row.namespace_id,
    sourceIds: [...row.source_ids],
    priority: row.priority,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    availableAt: dateString(row.available_at),
    enqueuedAt: dateString(row.enqueued_at),
    updatedAt: dateString(row.updated_at),
    ...(row.leased_by === null ? {} : { leasedBy: row.leased_by }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: dateString(row.lease_expires_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: dateString(row.finished_at) }),
    ...(row.error_name === null ? {} : { errorName: row.error_name }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata })
  };
}

function indexGenerationManifestFromRow(row: IndexGenerationManifestRow): IndexGenerationManifest {
  const manifest = row.manifest;
  const promotedAt = row.promoted_at === null ? manifest.promotedAt : dateString(row.promoted_at);
  const deprecatedAt =
    row.deprecated_at === null ? manifest.deprecatedAt : dateString(row.deprecated_at);
  return {
    ...manifest,
    generationId: row.generation_id,
    tenantId: row.tenant_id,
    namespaceId: row.namespace_id,
    profileId: row.profile_id,
    status: row.status,
    createdAt: manifest.createdAt ?? dateString(row.created_at),
    ...(promotedAt === undefined ? {} : { promotedAt }),
    ...(deprecatedAt === undefined ? {} : { deprecatedAt })
  };
}

function generationPromotionRecordFromRow(row: GenerationPromotionRow): GenerationPromotionRecord {
  return {
    promotionId: row.promotion_id,
    tenantId: row.tenant_id,
    namespaceId: row.namespace_id,
    candidateGenerationId: row.candidate_generation_id,
    ...(row.previous_active_generation_id === null
      ? {}
      : { previousActiveGenerationId: row.previous_active_generation_id }),
    requiredEvalIds: [...row.required_eval_ids],
    actions: [...row.actions],
    plannedAt: dateString(row.planned_at),
    status: row.status,
    evalResults: [...row.eval_results],
    updatedAt: dateString(row.updated_at),
    ...(row.promoted_at === null ? {} : { promotedAt: dateString(row.promoted_at) }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason })
  };
}

function ingestionLeaseFromRow(row: IngestionLeaseRow): IngestionLeaseRecord {
  return {
    resourceId: row.resource_id,
    holderId: row.holder_id,
    token: row.token,
    acquiredAt: dateString(row.acquired_at),
    updatedAt: dateString(row.updated_at),
    leaseExpiresAt: dateString(row.lease_expires_at),
    ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata })
  };
}

function requireQueueRow(
  row: IngestionQueueJobRow | undefined,
  queueId: string
): IngestionQueueJobRow {
  if (row === undefined) {
    throw new Error(`Ingestion queue job "${queueId}" was not returned by the database.`);
  }
  return row;
}

function requireManifestRow(
  row: IndexGenerationManifestRow | undefined,
  generationId: string
): IndexGenerationManifestRow {
  if (row === undefined) {
    throw new Error(
      `Index generation manifest "${generationId}" was not returned by the database.`
    );
  }
  return row;
}

function requirePromotionRow(
  row: GenerationPromotionRow | undefined,
  promotionId: string
): GenerationPromotionRow {
  if (row === undefined) {
    throw new Error(`Generation promotion "${promotionId}" was not returned by the database.`);
  }
  return row;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function withoutTerminalFields(job: IngestionQueueJob): IngestionQueueJob {
  return {
    queueId: job.queueId,
    jobId: job.jobId,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    tenantId: job.tenantId,
    namespaceId: job.namespaceId,
    sourceIds: job.sourceIds,
    priority: job.priority,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    enqueuedAt: job.enqueuedAt,
    updatedAt: job.updatedAt,
    ...(job.leasedBy === undefined ? {} : { leasedBy: job.leasedBy }),
    ...(job.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: job.leaseExpiresAt }),
    ...(job.errorName === undefined ? {} : { errorName: job.errorName }),
    ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
    ...(job.metadata === undefined ? {} : { metadata: job.metadata })
  };
}

function withoutPromotionTerminalFields(
  record: GenerationPromotionRecord
): GenerationPromotionRecord {
  return {
    promotionId: record.promotionId,
    tenantId: record.tenantId,
    namespaceId: record.namespaceId,
    candidateGenerationId: record.candidateGenerationId,
    ...(record.previousActiveGenerationId === undefined
      ? {}
      : { previousActiveGenerationId: record.previousActiveGenerationId }),
    requiredEvalIds: record.requiredEvalIds,
    actions: record.actions,
    plannedAt: record.plannedAt,
    status: record.status,
    evalResults: record.evalResults,
    updatedAt: record.updatedAt
  };
}

function upsertEvalResult(
  existing: readonly GenerationEvalResult[],
  next: GenerationEvalResult
): readonly GenerationEvalResult[] {
  const byId = new Map(existing.map((result) => [result.evalId, result]));
  byId.set(nonBlank(next.evalId, "evalId"), next);
  return [...byId.values()].sort((first, second) => first.evalId.localeCompare(second.evalId));
}

function promotionStatusFor(
  requiredEvalIds: readonly string[],
  evalResults: readonly GenerationEvalResult[]
): GenerationPromotionStatus {
  const resultById = new Map(evalResults.map((result) => [result.evalId, result]));
  if (requiredEvalIds.some((evalId) => resultById.get(evalId)?.status === "failed")) {
    return "failed";
  }
  if (requiredEvalIds.every((evalId) => resultById.get(evalId)?.status === "passed")) {
    return "ready";
  }
  return "planned";
}

function generationPromotionReadiness(
  record: GenerationPromotionRecord
): { readonly ready: true } | { readonly ready: false; readonly reason: string } {
  if (record.status === "promoted") {
    return {
      ready: false,
      reason: `Generation promotion "${record.promotionId}" is already promoted.`
    };
  }

  const resultById = new Map(record.evalResults.map((result) => [result.evalId, result]));
  const failed = record.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status === "failed"
  );
  if (failed.length > 0) {
    return {
      ready: false,
      reason: `Generation promotion "${record.promotionId}" has failed evals: ${failed.join(", ")}.`
    };
  }

  const missing = record.requiredEvalIds.filter(
    (evalId) => resultById.get(evalId)?.status !== "passed"
  );
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Generation promotion "${record.promotionId}" is missing required evals: ${missing.join(", ")}.`
    };
  }

  return { ready: true };
}

function existingErrorName(job: IngestionQueueJob): { readonly errorName?: string } {
  return job.errorName === undefined ? {} : { errorName: job.errorName };
}

function existingErrorMessage(job: IngestionQueueJob): { readonly errorMessage?: string } {
  return job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage };
}

function requeueMetadata(
  existing: Readonly<Record<string, string | number | boolean>> | undefined,
  next: Readonly<Record<string, string | number | boolean>> | undefined,
  reason: string | undefined
): Readonly<Record<string, string | number | boolean>> {
  return {
    ...(existing ?? {}),
    ...(next ?? {}),
    ...(reason === undefined ? {} : { requeueReason: reason })
  };
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid timestamp "${timestamp}".`);
  }
  return new Date(value + milliseconds).toISOString();
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Postgres ingestion scale ${label} must be a safe SQL identifier.`);
  }
  return value;
}

function nonBlank(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} cannot be blank.`);
  }
  return value;
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push([...values.slice(index, index + size)]);
  }
  return chunks;
}
