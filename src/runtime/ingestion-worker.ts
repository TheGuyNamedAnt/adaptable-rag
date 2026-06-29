import type { IndexOverwriteMode } from "../indexing/index-types.js";
import type {
  IngestionJobQueue,
  IngestionLeaseRecord,
  IngestionLeaseStore,
  IngestionQueueJob
} from "./ingestion-scale.js";
import type {
  ProductionIngestRuntime,
  ProductionRagIngestResponse
} from "./production-ingestion.js";

export type IngestionWorkerRunOnceStatus = "idle" | "completed" | "failed" | "lease_conflict";

export interface ProductionIngestionWorkerOptions {
  readonly queue: IngestionJobQueue;
  readonly ingestRuntime: ProductionIngestRuntime;
  readonly workerId: string;
  readonly principalForJob: (job: IngestionQueueJob) => unknown;
  readonly leaseStore?: IngestionLeaseStore;
  readonly leaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseConflictRetryMs?: number;
  readonly retryFailedJobs?: boolean;
  readonly overwriteMode?: IndexOverwriteMode;
  readonly now?: () => string;
  readonly logger?: (event: ProductionIngestionWorkerEvent) => void;
}

export interface ProductionIngestionWorkerRunOnceInput {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly sourceIds?: readonly string[];
  readonly requestedAt?: string;
  readonly overwriteMode?: IndexOverwriteMode;
}

export interface ProductionIngestionWorkerRunLoopInput extends ProductionIngestionWorkerRunOnceInput {
  readonly maxJobs?: number;
}

export interface ProductionIngestionWorkerRunOnceResult {
  readonly status: IngestionWorkerRunOnceStatus;
  readonly workerId: string;
  readonly checkedAt: string;
  readonly queueJob?: IngestionQueueJob;
  readonly ingestion?: ProductionRagIngestResponse;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface ProductionIngestionWorkerRunLoopResult {
  readonly workerId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly attemptedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly leaseConflictCount: number;
  readonly idleCount: number;
  readonly results: readonly ProductionIngestionWorkerRunOnceResult[];
}

export type ProductionIngestionWorkerEvent =
  | {
      readonly event: "worker_idle";
      readonly workerId: string;
      readonly checkedAt: string;
    }
  | {
      readonly event: "worker_claimed_job";
      readonly workerId: string;
      readonly queueId: string;
      readonly jobId: string;
      readonly checkedAt: string;
    }
  | {
      readonly event: "worker_completed_job";
      readonly workerId: string;
      readonly queueId: string;
      readonly jobId: string;
      readonly finishedAt: string;
    }
  | {
      readonly event: "worker_failed_job" | "worker_lease_conflict";
      readonly workerId: string;
      readonly queueId: string;
      readonly jobId: string;
      readonly failedAt: string;
      readonly errorName: string;
      readonly errorMessage: string;
    };

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_LEASE_CONFLICT_RETRY_MS = 30_000;

export class ProductionIngestionWorker {
  private readonly queue: IngestionJobQueue;
  private readonly ingestRuntime: ProductionIngestRuntime;
  private readonly workerId: string;
  private readonly principalForJob: (job: IngestionQueueJob) => unknown;
  private readonly leaseStore: IngestionLeaseStore | undefined;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseConflictRetryMs: number;
  private readonly retryFailedJobs: boolean;
  private readonly overwriteMode: IndexOverwriteMode | undefined;
  private readonly now: () => string;
  private readonly logger: ((event: ProductionIngestionWorkerEvent) => void) | undefined;

  constructor(options: ProductionIngestionWorkerOptions) {
    this.queue = options.queue;
    this.ingestRuntime = options.ingestRuntime;
    this.workerId = nonBlank(options.workerId, "workerId");
    this.principalForJob = options.principalForJob;
    this.leaseStore = options.leaseStore;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.floor(this.leaseTtlMs / 2);
    this.leaseConflictRetryMs = options.leaseConflictRetryMs ?? DEFAULT_LEASE_CONFLICT_RETRY_MS;
    this.retryFailedJobs = options.retryFailedJobs ?? true;
    this.overwriteMode = options.overwriteMode;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger = options.logger;
    assertPositiveInteger(this.leaseTtlMs, "leaseTtlMs");
    if (this.heartbeatIntervalMs < 0 || !Number.isInteger(this.heartbeatIntervalMs)) {
      throw new Error("heartbeatIntervalMs must be a non-negative integer.");
    }
    assertPositiveInteger(this.leaseConflictRetryMs, "leaseConflictRetryMs");
  }

  async runOnce(
    input: ProductionIngestionWorkerRunOnceInput = {}
  ): Promise<ProductionIngestionWorkerRunOnceResult> {
    const checkedAt = input.requestedAt ?? this.now();
    const queueJob = await this.queue.claimNext({
      workerId: this.workerId,
      now: checkedAt,
      leaseTtlMs: this.leaseTtlMs,
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      ...(input.namespaceId === undefined ? {} : { namespaceId: input.namespaceId }),
      ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds })
    });
    if (queueJob === undefined) {
      this.logger?.({ event: "worker_idle", workerId: this.workerId, checkedAt });
      return { status: "idle", workerId: this.workerId, checkedAt };
    }

    this.logger?.({
      event: "worker_claimed_job",
      workerId: this.workerId,
      queueId: queueJob.queueId,
      jobId: queueJob.jobId,
      checkedAt
    });

    const leases = await this.acquireLeases(queueJob, checkedAt);
    if (!leases.acquired) {
      await this.queue.fail({
        queueId: queueJob.queueId,
        workerId: this.workerId,
        now: checkedAt,
        retryable: true,
        nextAvailableAt: addMilliseconds(checkedAt, this.leaseConflictRetryMs),
        errorName: "IngestionLeaseConflict",
        errorMessage: leases.reason
      });
      await this.releaseLeases(leases.leases);
      this.logger?.({
        event: "worker_lease_conflict",
        workerId: this.workerId,
        queueId: queueJob.queueId,
        jobId: queueJob.jobId,
        failedAt: checkedAt,
        errorName: "IngestionLeaseConflict",
        errorMessage: leases.reason
      });
      return {
        status: "lease_conflict",
        workerId: this.workerId,
        checkedAt,
        queueJob,
        errorName: "IngestionLeaseConflict",
        errorMessage: leases.reason
      };
    }

    const heartbeat = this.startHeartbeat(queueJob, leases.leases);
    try {
      const overwriteMode = input.overwriteMode ?? this.overwriteMode;
      const ingestion = await this.ingestRuntime.ingest({
        tenantId: queueJob.tenantId,
        namespaceId: queueJob.namespaceId,
        principal: this.principalForJob(queueJob),
        sourceIds: queueJob.sourceIds,
        runId: queueJob.runId ?? queueJob.jobId,
        requestedAt: input.requestedAt ?? checkedAt,
        ...(overwriteMode === undefined ? {} : { overwriteMode })
      });
      await heartbeat.stop();
      const completed = await this.queue.complete({
        queueId: queueJob.queueId,
        workerId: this.workerId,
        now: ingestion.finishedAt
      });
      await this.releaseLeases(leases.leases);
      this.logger?.({
        event: "worker_completed_job",
        workerId: this.workerId,
        queueId: queueJob.queueId,
        jobId: queueJob.jobId,
        finishedAt: ingestion.finishedAt
      });
      return {
        status: "completed",
        workerId: this.workerId,
        checkedAt,
        queueJob: completed,
        ingestion
      };
    } catch (error) {
      await heartbeat.stop();
      const failedAt = this.now();
      const errorName = error instanceof Error ? error.name : "IngestionWorkerError";
      const errorMessage = error instanceof Error ? error.message : "Ingestion worker failed.";
      const failed = await this.queue.fail({
        queueId: queueJob.queueId,
        workerId: this.workerId,
        now: failedAt,
        retryable: this.retryFailedJobs,
        nextAvailableAt: addMilliseconds(failedAt, this.leaseConflictRetryMs),
        errorName,
        errorMessage
      });
      await this.releaseLeases(leases.leases);
      this.logger?.({
        event: "worker_failed_job",
        workerId: this.workerId,
        queueId: queueJob.queueId,
        jobId: queueJob.jobId,
        failedAt,
        errorName,
        errorMessage
      });
      return {
        status: "failed",
        workerId: this.workerId,
        checkedAt,
        queueJob: failed,
        errorName,
        errorMessage
      };
    }
  }

  async runLoop(
    input: ProductionIngestionWorkerRunLoopInput = {}
  ): Promise<ProductionIngestionWorkerRunLoopResult> {
    const startedAt = input.requestedAt ?? this.now();
    const maxJobs = input.maxJobs ?? 1;
    assertPositiveInteger(maxJobs, "maxJobs");
    const results: ProductionIngestionWorkerRunOnceResult[] = [];

    for (let index = 0; index < maxJobs; index += 1) {
      const result = await this.runOnce(input);
      results.push(result);
      if (result.status === "idle") {
        break;
      }
    }

    return {
      workerId: this.workerId,
      startedAt,
      finishedAt: this.now(),
      attemptedCount: results.filter((result) => result.status !== "idle").length,
      completedCount: results.filter((result) => result.status === "completed").length,
      failedCount: results.filter((result) => result.status === "failed").length,
      leaseConflictCount: results.filter((result) => result.status === "lease_conflict").length,
      idleCount: results.filter((result) => result.status === "idle").length,
      results
    };
  }

  private async acquireLeases(
    job: IngestionQueueJob,
    now: string
  ): Promise<
    | { readonly acquired: true; readonly leases: readonly IngestionLeaseRecord[] }
    | {
        readonly acquired: false;
        readonly leases: readonly IngestionLeaseRecord[];
        readonly reason: string;
      }
  > {
    if (this.leaseStore === undefined) {
      return { acquired: true, leases: [] };
    }

    const acquired: IngestionLeaseRecord[] = [];
    for (const resourceId of leaseResourceIds(job)) {
      const lease = await this.leaseStore.acquire({
        resourceId,
        holderId: this.workerId,
        now,
        ttlMs: this.leaseTtlMs,
        metadata: {
          queueId: job.queueId,
          jobId: job.jobId,
          tenantId: job.tenantId,
          namespaceId: job.namespaceId
        }
      });
      if (lease === undefined) {
        return {
          acquired: false,
          leases: acquired,
          reason: `Could not acquire ingestion lease "${resourceId}".`
        };
      }
      acquired.push(lease);
    }

    return { acquired: true, leases: acquired };
  }

  private async releaseLeases(leases: readonly IngestionLeaseRecord[]): Promise<void> {
    if (this.leaseStore === undefined) {
      return;
    }
    await Promise.all(
      leases.map((lease) =>
        this.leaseStore?.release({
          resourceId: lease.resourceId,
          holderId: lease.holderId,
          token: lease.token
        })
      )
    );
  }

  private startHeartbeat(
    job: IngestionQueueJob,
    leases: readonly IngestionLeaseRecord[]
  ): IngestionWorkerHeartbeat {
    if (this.heartbeatIntervalMs === 0) {
      return new IngestionWorkerHeartbeat(async () => undefined, 0);
    }

    return new IngestionWorkerHeartbeat(async () => {
      const now = this.now();
      await this.queue.heartbeat({
        queueId: job.queueId,
        workerId: this.workerId,
        now,
        leaseTtlMs: this.leaseTtlMs
      });
      if (this.leaseStore !== undefined) {
        await Promise.all(
          leases.map((lease) =>
            this.leaseStore?.heartbeat({
              resourceId: lease.resourceId,
              holderId: lease.holderId,
              token: lease.token,
              now,
              ttlMs: this.leaseTtlMs
            })
          )
        );
      }
    }, this.heartbeatIntervalMs).start();
  }
}

class IngestionWorkerHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly beat: () => Promise<void> | void,
    private readonly intervalMs: number
  ) {}

  start(): this {
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.beat();
      }, this.intervalMs);
    }
    return this;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    await this.beat();
  }
}

function leaseResourceIds(job: IngestionQueueJob): readonly string[] {
  const sourceLeaseIds = job.sourceIds.map(
    (sourceId) => `source:${job.tenantId}:${job.namespaceId}:${sourceId}`
  );
  const generationId = metadataString(job.metadata, "reindexGenerationId");
  return generationId === undefined
    ? sourceLeaseIds
    : [...sourceLeaseIds, `generation:${job.tenantId}:${job.namespaceId}:${generationId}`];
}

function metadataString(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
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

function nonBlank(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} cannot be blank.`);
  }
  return value;
}
