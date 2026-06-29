import type { Pool, PoolConfig } from "pg";
import pg from "pg";

export type IngestionJobStatus =
  | "queued"
  | "loading_source"
  | "normalizing"
  | "parsing"
  | "chunking"
  | "embedding"
  | "indexing"
  | "graph_extracting"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled";

export type IngestionJobStage = IngestionJobStatus | "visual_embedding";

export type IngestionSourceStatus = "queued" | "loading" | "completed" | "failed" | "skipped";
export type IngestionDocumentStatus =
  | "queued"
  | "normalizing"
  | "parsing"
  | "chunking"
  | "embedding"
  | "indexing"
  | "graph_extracting"
  | "accepted"
  | "failed"
  | "skipped";

export interface IngestionJobCounts {
  readonly documentsAccepted: number;
  readonly chunksAccepted: number;
  readonly recordsRejected: number;
  readonly recordsSkipped?: number;
  readonly failedDocumentCount?: number;
  readonly skippedDocumentCount?: number;
  readonly indexWritesAccepted: number;
  readonly indexWritesRejected: number;
  readonly adapterWarnings: number;
  readonly normalizationIssues: number;
  readonly parserQualityWarnings: number;
  readonly searchableArtifactWarnings?: number;
  readonly chunkingWarnings: number;
}

export interface IngestionJobRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly status: IngestionJobStatus;
  readonly stage: IngestionJobStage;
  readonly attempt: number;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly counts?: IngestionJobCounts;
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface CreateIngestionJobInput {
  readonly jobId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly requestedAt: string;
}

export interface UpdateIngestionJobInput {
  readonly jobId: string;
  readonly status?: IngestionJobStatus;
  readonly stage?: IngestionJobStage;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
  readonly counts?: IngestionJobCounts;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly updatedAt: string;
}

export interface IngestionJobStore {
  create(input: CreateIngestionJobInput): Promise<IngestionJobRecord>;
  update(input: UpdateIngestionJobInput): Promise<IngestionJobRecord>;
  get(jobId: string): Promise<IngestionJobRecord | undefined>;
  list?(filter?: IngestionJobListFilter): Promise<readonly IngestionJobRecord[]>;
}

export interface IngestionJobListFilter {
  readonly tenantId?: string;
  readonly namespaceId?: string;
  readonly statuses?: readonly IngestionJobStatus[];
  readonly limit?: number;
}

export interface IngestionCheckpointRecord {
  readonly jobId: string;
  readonly checkpointId: string;
  readonly sequence: number;
  readonly stage: IngestionJobStage;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface IngestionCheckpointListFilter {
  readonly limit?: number;
  readonly offset?: number;
}

export interface SaveIngestionCheckpointInput {
  readonly jobId: string;
  readonly stage: IngestionJobStage;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface IngestionCheckpointStore {
  save(input: SaveIngestionCheckpointInput): Promise<IngestionCheckpointRecord>;
  latest(jobId: string): Promise<IngestionCheckpointRecord | undefined>;
  list(
    jobId: string,
    filter?: IngestionCheckpointListFilter
  ): Promise<readonly IngestionCheckpointRecord[]>;
}

export interface IngestionSourceProgressRecord {
  readonly jobId: string;
  readonly sourceId: string;
  readonly status: IngestionSourceStatus;
  readonly loadedDocumentCount: number;
  readonly acceptedDocumentCount: number;
  readonly failedDocumentCount: number;
  readonly skippedDocumentCount: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface IngestionSourceProgressListFilter {
  readonly sourceId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateIngestionSourceProgressInput {
  readonly jobId: string;
  readonly sourceId: string;
  readonly status: IngestionSourceStatus;
  readonly loadedDocumentCount?: number;
  readonly acceptedDocumentCount?: number;
  readonly failedDocumentCount?: number;
  readonly skippedDocumentCount?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface IngestionDocumentProgressRecord {
  readonly jobId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly status: IngestionDocumentStatus;
  readonly chunkCount: number;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly failureStage?: IngestionJobStage;
  readonly failurePhase?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface IngestionDocumentProgressListFilter {
  readonly sourceId?: string;
  readonly statuses?: readonly IngestionDocumentStatus[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateIngestionDocumentProgressInput {
  readonly jobId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly status: IngestionDocumentStatus;
  readonly chunkCount?: number;
  readonly retryable?: boolean;
  readonly attempt?: number;
  readonly failureStage?: IngestionJobStage;
  readonly failurePhase?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface IngestionProgressStore {
  updateSource(input: UpdateIngestionSourceProgressInput): Promise<IngestionSourceProgressRecord>;
  updateDocument(
    input: UpdateIngestionDocumentProgressInput
  ): Promise<IngestionDocumentProgressRecord>;
  listSources(
    jobId: string,
    filter?: IngestionSourceProgressListFilter
  ): Promise<readonly IngestionSourceProgressRecord[]>;
  listDocuments(
    jobId: string,
    filter?: IngestionDocumentProgressListFilter
  ): Promise<readonly IngestionDocumentProgressRecord[]>;
}

export class InMemoryIngestionJobStore implements IngestionJobStore {
  private readonly jobs = new Map<string, IngestionJobRecord>();

  async create(input: CreateIngestionJobInput): Promise<IngestionJobRecord> {
    if (this.jobs.has(input.jobId)) {
      throw new Error(`Ingestion job "${input.jobId}" already exists.`);
    }

    const record: IngestionJobRecord = {
      jobId: input.jobId,
      runId: input.runId,
      tenantId: input.tenantId,
      namespaceId: input.namespaceId,
      sourceIds: [...input.sourceIds],
      status: "queued",
      stage: "queued",
      attempt: 1,
      requestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
      checkpoint: {}
    };
    this.jobs.set(input.jobId, record);
    return record;
  }

  async update(input: UpdateIngestionJobInput): Promise<IngestionJobRecord> {
    const existing = this.jobs.get(input.jobId);
    if (!existing) {
      throw new Error(`Ingestion job "${input.jobId}" does not exist.`);
    }

    const record: IngestionJobRecord = {
      ...existing,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
      ...(input.counts === undefined ? {} : { counts: input.counts }),
      ...(input.errorName === undefined ? {} : { errorName: input.errorName }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      updatedAt: input.updatedAt
    };
    this.jobs.set(input.jobId, record);
    return record;
  }

  async get(jobId: string): Promise<IngestionJobRecord | undefined> {
    return this.jobs.get(jobId);
  }

  async list(filter: IngestionJobListFilter = {}): Promise<readonly IngestionJobRecord[]> {
    const rows = [...this.jobs.values()]
      .filter((job) => filter.tenantId === undefined || job.tenantId === filter.tenantId)
      .filter((job) => filter.namespaceId === undefined || job.namespaceId === filter.namespaceId)
      .filter((job) => filter.statuses === undefined || filter.statuses.includes(job.status))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    return filter.limit === undefined ? rows : rows.slice(0, Math.max(0, filter.limit));
  }
}

export class InMemoryIngestionCheckpointStore implements IngestionCheckpointStore {
  private readonly checkpoints = new Map<string, IngestionCheckpointRecord[]>();

  async save(input: SaveIngestionCheckpointInput): Promise<IngestionCheckpointRecord> {
    const existing = this.checkpoints.get(input.jobId) ?? [];
    const sequence = existing.length + 1;
    const record: IngestionCheckpointRecord = {
      jobId: input.jobId,
      checkpointId: `${input.jobId}_checkpoint_${sequence}`,
      sequence,
      stage: input.stage,
      checkpoint: input.checkpoint,
      recordedAt: input.recordedAt
    };
    this.checkpoints.set(input.jobId, [...existing, record]);
    return record;
  }

  async latest(jobId: string): Promise<IngestionCheckpointRecord | undefined> {
    return this.checkpoints.get(jobId)?.at(-1);
  }

  async list(
    jobId: string,
    filter: IngestionCheckpointListFilter = {}
  ): Promise<readonly IngestionCheckpointRecord[]> {
    return applyListPage(this.checkpoints.get(jobId) ?? [], filter);
  }
}

export class InMemoryIngestionProgressStore implements IngestionProgressStore {
  private readonly sources = new Map<string, IngestionSourceProgressRecord>();
  private readonly documents = new Map<string, IngestionDocumentProgressRecord>();

  async updateSource(
    input: UpdateIngestionSourceProgressInput
  ): Promise<IngestionSourceProgressRecord> {
    const key = sourceKey(input.jobId, input.sourceId);
    const existing = this.sources.get(key);
    const startedAt = input.startedAt ?? existing?.startedAt;
    const finishedAt = input.finishedAt ?? existing?.finishedAt;
    const errorMessage = input.errorMessage ?? existing?.errorMessage;
    const record: IngestionSourceProgressRecord = {
      jobId: input.jobId,
      sourceId: input.sourceId,
      status: input.status,
      loadedDocumentCount: input.loadedDocumentCount ?? existing?.loadedDocumentCount ?? 0,
      acceptedDocumentCount: input.acceptedDocumentCount ?? existing?.acceptedDocumentCount ?? 0,
      failedDocumentCount: input.failedDocumentCount ?? existing?.failedDocumentCount ?? 0,
      skippedDocumentCount: input.skippedDocumentCount ?? existing?.skippedDocumentCount ?? 0,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      updatedAt: input.updatedAt,
      ...(errorMessage === undefined ? {} : { errorMessage })
    };
    this.sources.set(key, record);
    return record;
  }

  async updateDocument(
    input: UpdateIngestionDocumentProgressInput
  ): Promise<IngestionDocumentProgressRecord> {
    const key = documentKey(input.jobId, input.sourceId, input.documentId);
    const existing = this.documents.get(key);
    const startedAt = input.startedAt ?? existing?.startedAt;
    const finishedAt = input.finishedAt ?? existing?.finishedAt;
    const errorMessage = input.errorMessage ?? existing?.errorMessage;
    const failureStage =
      input.status === "failed" ? (input.failureStage ?? existing?.failureStage) : undefined;
    const failurePhase =
      input.status === "failed" ? (input.failurePhase ?? existing?.failurePhase) : undefined;
    const record: IngestionDocumentProgressRecord = {
      jobId: input.jobId,
      sourceId: input.sourceId,
      documentId: input.documentId,
      status: input.status,
      chunkCount: input.chunkCount ?? existing?.chunkCount ?? 0,
      retryable: input.retryable ?? existing?.retryable ?? false,
      attempt: input.attempt ?? existing?.attempt ?? 1,
      ...(failureStage === undefined ? {} : { failureStage }),
      ...(failurePhase === undefined ? {} : { failurePhase }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      updatedAt: input.updatedAt,
      ...(errorMessage === undefined ? {} : { errorMessage })
    };
    this.documents.set(key, record);
    return record;
  }

  async listSources(
    jobId: string,
    filter: IngestionSourceProgressListFilter = {}
  ): Promise<readonly IngestionSourceProgressRecord[]> {
    const rows = [...this.sources.values()]
      .filter((record) => record.jobId === jobId)
      .filter((record) => filter.sourceId === undefined || record.sourceId === filter.sourceId)
      .sort((first, second) => first.sourceId.localeCompare(second.sourceId));
    return applyListPage(rows, filter);
  }

  async listDocuments(
    jobId: string,
    filter: IngestionDocumentProgressListFilter = {}
  ): Promise<readonly IngestionDocumentProgressRecord[]> {
    const rows = [...this.documents.values()]
      .filter((record) => record.jobId === jobId)
      .filter((record) => filter.sourceId === undefined || record.sourceId === filter.sourceId)
      .filter((record) => filter.statuses === undefined || filter.statuses.includes(record.status))
      .sort(
        (first, second) =>
          first.sourceId.localeCompare(second.sourceId) ||
          first.documentId.localeCompare(second.documentId)
      );
    return applyListPage(rows, filter);
  }
}

export interface PostgresIngestionJobStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
}

const DEFAULT_SCHEMA = "rag_core";

export class PostgresIngestionJobStore implements IngestionJobStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionJobStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error("PostgresIngestionJobStore requires pool, connectionString, or poolConfig.");
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

  async create(input: CreateIngestionJobInput): Promise<IngestionJobRecord> {
    const result = await this.pool.query<IngestionJobRow>(
      `insert into ${this.q("ingestion_jobs")} (
        job_id, run_id, tenant_id, namespace_id, source_ids, status, stage,
        attempt, requested_at, updated_at, checkpoint
      ) values ($1, $2, $3, $4, $5::text[], 'queued', 'queued', 1, $6, $6, '{}'::jsonb)
      returning *`,
      [
        input.jobId,
        input.runId,
        input.tenantId,
        input.namespaceId,
        input.sourceIds,
        input.requestedAt
      ]
    );
    return ingestionJobFromRow(requireRow(result.rows[0], input.jobId));
  }

  async update(input: UpdateIngestionJobInput): Promise<IngestionJobRecord> {
    const existing = await this.get(input.jobId);
    if (!existing) {
      throw new Error(`Ingestion job "${input.jobId}" does not exist.`);
    }

    const result = await this.pool.query<IngestionJobRow>(
      `update ${this.q("ingestion_jobs")} set
        status = $2,
        stage = $3,
        started_at = $4,
        finished_at = $5,
        updated_at = $6,
        checkpoint = $7::jsonb,
        counts = $8::jsonb,
        error_name = $9,
        error_message = $10
      where job_id = $1
      returning *`,
      [
        input.jobId,
        input.status ?? existing.status,
        input.stage ?? existing.stage,
        input.startedAt ?? existing.startedAt ?? null,
        input.finishedAt ?? existing.finishedAt ?? null,
        input.updatedAt,
        JSON.stringify(input.checkpoint ?? existing.checkpoint),
        input.counts === undefined
          ? JSON.stringify(existing.counts ?? null)
          : JSON.stringify(input.counts),
        input.errorName ?? existing.errorName ?? null,
        input.errorMessage ?? existing.errorMessage ?? null
      ]
    );
    return ingestionJobFromRow(requireRow(result.rows[0], input.jobId));
  }

  async get(jobId: string): Promise<IngestionJobRecord | undefined> {
    const result = await this.pool.query<IngestionJobRow>(
      `select * from ${this.q("ingestion_jobs")} where job_id = $1`,
      [jobId]
    );
    return result.rows[0] === undefined ? undefined : ingestionJobFromRow(result.rows[0]);
  }

  async list(filter: IngestionJobListFilter = {}): Promise<readonly IngestionJobRecord[]> {
    const result = await this.pool.query<IngestionJobRow>(
      `select * from ${this.q("ingestion_jobs")}
       where ($1::text is null or tenant_id = $1)
         and ($2::text is null or namespace_id = $2)
         and ($3::text[] is null or status = any($3::text[]))
       order by updated_at desc
       limit $4`,
      [
        filter.tenantId ?? null,
        filter.namespaceId ?? null,
        filter.statuses ?? null,
        filter.limit ?? 100
      ]
    );
    return result.rows.map(ingestionJobFromRow);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export class PostgresIngestionCheckpointStore implements IngestionCheckpointStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionJobStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error(
        "PostgresIngestionCheckpointStore requires pool, connectionString, or poolConfig."
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

  async save(input: SaveIngestionCheckpointInput): Promise<IngestionCheckpointRecord> {
    const result = await this.pool.query<IngestionCheckpointRow>(
      `insert into ${this.q("ingestion_checkpoints")} (
        job_id, stage, checkpoint, recorded_at, sequence
      ) values (
        $1, $2, $3::jsonb, $4,
        coalesce((select max(sequence) + 1 from ${this.q("ingestion_checkpoints")} where job_id = $1), 1)
      )
      returning *`,
      [input.jobId, input.stage, JSON.stringify(input.checkpoint), input.recordedAt]
    );
    return checkpointFromRow(requireCheckpointRow(result.rows[0], input.jobId));
  }

  async latest(jobId: string): Promise<IngestionCheckpointRecord | undefined> {
    const result = await this.pool.query<IngestionCheckpointRow>(
      `select * from ${this.q("ingestion_checkpoints")}
       where job_id = $1
       order by sequence desc
       limit 1`,
      [jobId]
    );
    return result.rows[0] === undefined ? undefined : checkpointFromRow(result.rows[0]);
  }

  async list(
    jobId: string,
    filter: IngestionCheckpointListFilter = {}
  ): Promise<readonly IngestionCheckpointRecord[]> {
    const result = await this.pool.query<IngestionCheckpointRow>(
      `select * from ${this.q("ingestion_checkpoints")}
       where job_id = $1
       order by sequence asc
       offset $2
       limit $3`,
      [jobId, listOffset(filter.offset), listLimit(filter.limit)]
    );
    return result.rows.map(checkpointFromRow);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

export class PostgresIngestionProgressStore implements IngestionProgressStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(options: PostgresIngestionJobStoreOptions) {
    if (!options.pool && !options.connectionString && !options.poolConfig) {
      throw new Error(
        "PostgresIngestionProgressStore requires pool, connectionString, or poolConfig."
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

  async updateSource(
    input: UpdateIngestionSourceProgressInput
  ): Promise<IngestionSourceProgressRecord> {
    const existing = await this.getSource(input.jobId, input.sourceId);
    const result = await this.pool.query<IngestionSourceProgressRow>(
      `insert into ${this.q("ingestion_source_progress")} (
        job_id, source_id, status, loaded_document_count, accepted_document_count,
        failed_document_count, skipped_document_count, started_at, finished_at,
        updated_at, error_message
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (job_id, source_id) do update set
        status = excluded.status,
        loaded_document_count = excluded.loaded_document_count,
        accepted_document_count = excluded.accepted_document_count,
        failed_document_count = excluded.failed_document_count,
        skipped_document_count = excluded.skipped_document_count,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at,
        error_message = excluded.error_message
      returning *`,
      [
        input.jobId,
        input.sourceId,
        input.status,
        input.loadedDocumentCount ?? existing?.loadedDocumentCount ?? 0,
        input.acceptedDocumentCount ?? existing?.acceptedDocumentCount ?? 0,
        input.failedDocumentCount ?? existing?.failedDocumentCount ?? 0,
        input.skippedDocumentCount ?? existing?.skippedDocumentCount ?? 0,
        input.startedAt ?? existing?.startedAt ?? null,
        input.finishedAt ?? existing?.finishedAt ?? null,
        input.updatedAt,
        input.errorMessage ?? existing?.errorMessage ?? null
      ]
    );
    return sourceProgressFromRow(requireSourceProgressRow(result.rows[0], input.jobId));
  }

  async updateDocument(
    input: UpdateIngestionDocumentProgressInput
  ): Promise<IngestionDocumentProgressRecord> {
    const existing = await this.getDocument(input.jobId, input.sourceId, input.documentId);
    const failureStage =
      input.status === "failed" ? (input.failureStage ?? existing?.failureStage ?? null) : null;
    const failurePhase =
      input.status === "failed" ? (input.failurePhase ?? existing?.failurePhase ?? null) : null;
    const result = await this.pool.query<IngestionDocumentProgressRow>(
      `insert into ${this.q("ingestion_document_progress")} (
        job_id, source_id, document_id, status, chunk_count, retryable, attempt,
        failure_stage, failure_phase, started_at, finished_at, updated_at, error_message
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      on conflict (job_id, source_id, document_id) do update set
        status = excluded.status,
        chunk_count = excluded.chunk_count,
        retryable = excluded.retryable,
        attempt = excluded.attempt,
        failure_stage = excluded.failure_stage,
        failure_phase = excluded.failure_phase,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at,
        error_message = excluded.error_message
      returning *`,
      [
        input.jobId,
        input.sourceId,
        input.documentId,
        input.status,
        input.chunkCount ?? existing?.chunkCount ?? 0,
        input.retryable ?? existing?.retryable ?? false,
        input.attempt ?? existing?.attempt ?? 1,
        failureStage,
        failurePhase,
        input.startedAt ?? existing?.startedAt ?? null,
        input.finishedAt ?? existing?.finishedAt ?? null,
        input.updatedAt,
        input.errorMessage ?? existing?.errorMessage ?? null
      ]
    );
    return documentProgressFromRow(requireDocumentProgressRow(result.rows[0], input.jobId));
  }

  async listSources(
    jobId: string,
    filter: IngestionSourceProgressListFilter = {}
  ): Promise<readonly IngestionSourceProgressRecord[]> {
    const result = await this.pool.query<IngestionSourceProgressRow>(
      `select * from ${this.q("ingestion_source_progress")}
       where job_id = $1
         and ($2::text is null or source_id = $2)
       order by source_id asc
       offset $3
       limit $4`,
      [jobId, filter.sourceId ?? null, listOffset(filter.offset), listLimit(filter.limit)]
    );
    return result.rows.map(sourceProgressFromRow);
  }

  async listDocuments(
    jobId: string,
    filter: IngestionDocumentProgressListFilter = {}
  ): Promise<readonly IngestionDocumentProgressRecord[]> {
    const result = await this.pool.query<IngestionDocumentProgressRow>(
      `select * from ${this.q("ingestion_document_progress")}
       where job_id = $1
         and ($2::text is null or source_id = $2)
         and ($3::text[] is null or status = any($3::text[]))
       order by source_id asc, document_id asc
       offset $4
       limit $5`,
      [
        jobId,
        filter.sourceId ?? null,
        filter.statuses ?? null,
        listOffset(filter.offset),
        listLimit(filter.limit)
      ]
    );
    return result.rows.map(documentProgressFromRow);
  }

  private async getSource(
    jobId: string,
    sourceId: string
  ): Promise<IngestionSourceProgressRecord | undefined> {
    const result = await this.pool.query<IngestionSourceProgressRow>(
      `select * from ${this.q("ingestion_source_progress")} where job_id = $1 and source_id = $2`,
      [jobId, sourceId]
    );
    return result.rows[0] === undefined ? undefined : sourceProgressFromRow(result.rows[0]);
  }

  private async getDocument(
    jobId: string,
    sourceId: string,
    documentId: string
  ): Promise<IngestionDocumentProgressRecord | undefined> {
    const result = await this.pool.query<IngestionDocumentProgressRow>(
      `select * from ${this.q("ingestion_document_progress")}
       where job_id = $1 and source_id = $2 and document_id = $3`,
      [jobId, sourceId, documentId]
    );
    return result.rows[0] === undefined ? undefined : documentProgressFromRow(result.rows[0]);
  }

  private q(tableName: string): string {
    return `"${this.schema}"."${assertSafeIdentifier(tableName, "table")}"`;
  }
}

interface IngestionJobRow {
  readonly job_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly namespace_id: string;
  readonly source_ids: readonly string[];
  readonly status: IngestionJobStatus;
  readonly stage: IngestionJobStage;
  readonly attempt: number;
  readonly requested_at: Date | string;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly checkpoint: Record<string, unknown>;
  readonly counts: IngestionJobCounts | null;
  readonly error_name: string | null;
  readonly error_message: string | null;
}

interface IngestionCheckpointRow {
  readonly job_id: string;
  readonly checkpoint_id: string;
  readonly sequence: number;
  readonly stage: IngestionJobStage;
  readonly checkpoint: Record<string, unknown>;
  readonly recorded_at: Date | string;
}

interface IngestionSourceProgressRow {
  readonly job_id: string;
  readonly source_id: string;
  readonly status: IngestionSourceStatus;
  readonly loaded_document_count: number;
  readonly accepted_document_count: number;
  readonly failed_document_count: number;
  readonly skipped_document_count: number;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly error_message: string | null;
}

interface IngestionDocumentProgressRow {
  readonly job_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly status: IngestionDocumentStatus;
  readonly chunk_count: number;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly failure_stage: IngestionJobStage | null;
  readonly failure_phase: string | null;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly error_message: string | null;
}

function ingestionJobFromRow(row: IngestionJobRow): IngestionJobRecord {
  return {
    jobId: row.job_id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    namespaceId: row.namespace_id,
    sourceIds: [...row.source_ids],
    status: row.status,
    stage: row.stage,
    attempt: row.attempt,
    requestedAt: dateString(row.requested_at),
    ...(row.started_at === null ? {} : { startedAt: dateString(row.started_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: dateString(row.finished_at) }),
    updatedAt: dateString(row.updated_at),
    checkpoint: row.checkpoint,
    ...(row.counts === null ? {} : { counts: row.counts }),
    ...(row.error_name === null ? {} : { errorName: row.error_name }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message })
  };
}

function checkpointFromRow(row: IngestionCheckpointRow): IngestionCheckpointRecord {
  return {
    jobId: row.job_id,
    checkpointId: row.checkpoint_id,
    sequence: row.sequence,
    stage: row.stage,
    checkpoint: row.checkpoint,
    recordedAt: dateString(row.recorded_at)
  };
}

function sourceProgressFromRow(row: IngestionSourceProgressRow): IngestionSourceProgressRecord {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    status: row.status,
    loadedDocumentCount: row.loaded_document_count,
    acceptedDocumentCount: row.accepted_document_count,
    failedDocumentCount: row.failed_document_count,
    skippedDocumentCount: row.skipped_document_count,
    ...(row.started_at === null ? {} : { startedAt: dateString(row.started_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: dateString(row.finished_at) }),
    updatedAt: dateString(row.updated_at),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message })
  };
}

function documentProgressFromRow(
  row: IngestionDocumentProgressRow
): IngestionDocumentProgressRecord {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    documentId: row.document_id,
    status: row.status,
    chunkCount: row.chunk_count,
    retryable: row.retryable,
    attempt: row.attempt,
    ...(row.failure_stage === null ? {} : { failureStage: row.failure_stage }),
    ...(row.failure_phase === null ? {} : { failurePhase: row.failure_phase }),
    ...(row.started_at === null ? {} : { startedAt: dateString(row.started_at) }),
    ...(row.finished_at === null ? {} : { finishedAt: dateString(row.finished_at) }),
    updatedAt: dateString(row.updated_at),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message })
  };
}

function requireRow(row: IngestionJobRow | undefined, jobId: string): IngestionJobRow {
  if (!row) {
    throw new Error(`Ingestion job "${jobId}" was not returned by the database.`);
  }
  return row;
}

function requireCheckpointRow(
  row: IngestionCheckpointRow | undefined,
  jobId: string
): IngestionCheckpointRow {
  if (!row) {
    throw new Error(`Ingestion checkpoint for job "${jobId}" was not returned by the database.`);
  }
  return row;
}

function requireSourceProgressRow(
  row: IngestionSourceProgressRow | undefined,
  jobId: string
): IngestionSourceProgressRow {
  if (!row) {
    throw new Error(
      `Ingestion source progress for job "${jobId}" was not returned by the database.`
    );
  }
  return row;
}

function requireDocumentProgressRow(
  row: IngestionDocumentProgressRow | undefined,
  jobId: string
): IngestionDocumentProgressRow {
  if (!row) {
    throw new Error(
      `Ingestion document progress for job "${jobId}" was not returned by the database.`
    );
  }
  return row;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function applyListPage<T>(
  rows: readonly T[],
  filter: { readonly limit?: number; readonly offset?: number }
): readonly T[] {
  const offset = listOffset(filter.offset);
  const limit = filter.limit === undefined ? undefined : Math.max(0, Math.trunc(filter.limit));
  return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
}

function listOffset(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.trunc(value));
}

function listLimit(value: number | undefined): number | null {
  return value === undefined ? null : Math.max(0, Math.trunc(value));
}

function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Postgres ingestion job ${label} must be a safe SQL identifier.`);
  }
  return value;
}

function sourceKey(jobId: string, sourceId: string): string {
  return `${jobId}\u0000${sourceId}`;
}

function documentKey(jobId: string, sourceId: string, documentId: string): string {
  return `${jobId}\u0000${sourceId}\u0000${documentId}`;
}
