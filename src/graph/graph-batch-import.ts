import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { redactText } from "../shared/provider-boundary.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { assertValidGraphExtractionBatch } from "./graph-validation.js";
import type { GraphStore, GraphStoreWriteResult } from "./in-memory-graph-store.js";

export type GraphBatchImportStatus = "succeeded" | "partial" | "failed";
export type GraphBatchImportStopReason = "completed" | "batch_failed" | "threshold_exceeded";

export type GraphBatchImportSource =
  | Iterable<GraphExtractionBatch>
  | AsyncIterable<GraphExtractionBatch>;

export interface GraphBatchImportThresholds {
  readonly maxFailedBatches?: number;
  readonly maxFailureRatio?: number;
  readonly maxBatchWriteMs?: number;
  readonly maxWriteP95Ms?: number;
  readonly maxTotalWriteMs?: number;
}

export interface GraphBatchImportRequest {
  readonly store: GraphStore;
  readonly batches: GraphBatchImportSource;
  readonly importId?: string;
  readonly requestedAt?: string;
  readonly checkpointStore?: GraphBatchImportCheckpointStore;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly continueOnError?: boolean;
  readonly thresholds?: GraphBatchImportThresholds;
  readonly now?: () => string;
}

export interface GraphBatchImportMetrics {
  readonly sourceBatchCount: number;
  readonly skippedBatchCount: number;
  readonly attemptedBatchCount: number;
  readonly completedBatchCount: number;
  readonly failedBatchCount: number;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
  readonly totalWriteMs: number;
  readonly maxBatchWriteMs: number;
  readonly p95BatchWriteMs: number;
}

export interface GraphBatchImportWrite {
  readonly batchId: string;
  readonly attemptCount: number;
  readonly durationMs: number;
  readonly entityCount: number;
  readonly relationCount: number;
}

export interface GraphBatchImportFailure {
  readonly batchId: string;
  readonly attempts: number;
  readonly message: string;
  readonly failedAt: string;
}

export interface GraphBatchImportThresholdViolation {
  readonly signalName: string;
  readonly observedValue: number;
  readonly threshold: number;
  readonly message: string;
}

export interface GraphBatchImportResult {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly status: GraphBatchImportStatus;
  readonly stopReason: GraphBatchImportStopReason;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly metrics: GraphBatchImportMetrics;
  readonly writes: readonly GraphBatchImportWrite[];
  readonly failures: readonly GraphBatchImportFailure[];
  readonly thresholdViolations: readonly GraphBatchImportThresholdViolation[];
  readonly checkpoint: GraphBatchImportCheckpoint;
}

export interface GraphBatchImportCheckpointMetrics {
  readonly completedBatchCount: number;
  readonly failedBatchCount: number;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
}

export interface GraphBatchImportCheckpoint {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly status: GraphBatchImportStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedBatchIds: readonly string[];
  readonly failedBatches: readonly GraphBatchImportFailure[];
  readonly metrics: GraphBatchImportCheckpointMetrics;
}

export interface GraphBatchImportCheckpointStore {
  read(): GraphBatchImportCheckpoint | undefined;
  write(checkpoint: GraphBatchImportCheckpoint): void;
}

export interface JsonFileGraphBatchImportCheckpointStoreOptions {
  readonly filePath: string;
  readonly pretty?: boolean;
}

export class JsonFileGraphBatchImportCheckpointStore implements GraphBatchImportCheckpointStore {
  private readonly filePath: string;
  private readonly pretty: boolean;

  constructor(options: JsonFileGraphBatchImportCheckpointStoreOptions) {
    this.filePath = options.filePath;
    this.pretty = options.pretty ?? true;
  }

  read(): GraphBatchImportCheckpoint | undefined {
    if (!existsSync(this.filePath)) {
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as GraphBatchImportCheckpoint;
    assertCheckpoint(parsed);
    return parsed;
  }

  write(checkpoint: GraphBatchImportCheckpoint): void {
    assertCheckpoint(checkpoint);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(checkpoint, null, this.pretty ? 2 : 0)}\n`,
      "utf8"
    );
    renameSync(temporaryPath, this.filePath);
  }
}

export interface GraphExtractionBatchChunkOptions {
  readonly maxEntitiesPerBatch: number;
  readonly maxRelationsPerBatch: number;
  readonly includeEntityOnlyBatches?: boolean;
  readonly chunkIdPrefix?: string;
  readonly createdAt?: string;
}

export async function importGraphBatches(
  request: GraphBatchImportRequest
): Promise<GraphBatchImportResult> {
  const now = request.now ?? (() => new Date().toISOString());
  const startedAt = request.requestedAt ?? now();
  const importId = request.importId ?? `graph_import_${safeTimestamp(startedAt)}`;
  const maxAttempts = request.maxAttempts ?? 1;
  const retryDelayMs = request.retryDelayMs ?? 0;
  const thresholds = request.thresholds ?? {};
  assertImportOptions({ maxAttempts, retryDelayMs, thresholds });

  const previousCheckpoint = request.checkpointStore?.read();
  if (previousCheckpoint && previousCheckpoint.importId !== importId) {
    throw new Error(
      `Graph import checkpoint belongs to "${previousCheckpoint.importId}", not "${importId}".`
    );
  }

  const completedBatchIds = new Set(previousCheckpoint?.completedBatchIds ?? []);
  const failedBatches = new Map(
    (previousCheckpoint?.failedBatches ?? []).map((failure) => [failure.batchId, failure])
  );
  const writes: GraphBatchImportWrite[] = [];
  const writeDurations: number[] = [];
  let sourceBatchCount = 0;
  let skippedBatchCount = 0;
  let attemptedBatchCount = 0;
  let completedBatchCount = 0;
  let failedBatchCount = 0;
  let storedEntityCount = 0;
  let storedRelationCount = 0;
  let stoppedOnFailure = false;
  let stoppedOnThreshold = false;
  let thresholdViolations: readonly GraphBatchImportThresholdViolation[] = [];

  for await (const batch of request.batches) {
    sourceBatchCount += 1;
    const batchId = batch.id;

    if (completedBatchIds.has(batchId)) {
      skippedBatchCount += 1;
      continue;
    }

    attemptedBatchCount += 1;
    const write = await writeBatchWithRetries({
      store: request.store,
      batch,
      maxAttempts,
      retryDelayMs,
      now
    });

    if (write.status === "succeeded") {
      completedBatchIds.add(batchId);
      failedBatches.delete(batchId);
      completedBatchCount += 1;
      storedEntityCount += write.result.entityCount;
      storedRelationCount += write.result.relationCount;
      writeDurations.push(write.durationMs);
      writes.push({
        batchId,
        attemptCount: write.attemptCount,
        durationMs: roundMs(write.durationMs),
        entityCount: write.result.entityCount,
        relationCount: write.result.relationCount
      });
    } else {
      failedBatchCount += 1;
      failedBatches.set(batchId, write.failure);
      if (request.continueOnError !== true) {
        stoppedOnFailure = true;
      }
    }

    const metrics = buildImportMetrics({
      sourceBatchCount,
      skippedBatchCount,
      attemptedBatchCount,
      completedBatchCount,
      failedBatchCount,
      storedEntityCount,
      storedRelationCount,
      writeDurations
    });
    thresholdViolations = graphBatchImportThresholdViolations({
      thresholds,
      metrics,
      unresolvedFailedBatchCount: failedBatches.size
    });
    stoppedOnThreshold = thresholdViolations.length > 0;
    writeCheckpoint({
      importId,
      startedAt: previousCheckpoint?.startedAt ?? startedAt,
      updatedAt: now(),
      status: statusFromState({
        stoppedOnFailure,
        stoppedOnThreshold,
        unresolvedFailedBatchCount: failedBatches.size
      }),
      completedBatchIds,
      failedBatches,
      storedEntityCount,
      storedRelationCount,
      ...(request.checkpointStore === undefined
        ? {}
        : { checkpointStore: request.checkpointStore }),
      ...(previousCheckpoint === undefined ? {} : { previousCheckpoint })
    });

    if (stoppedOnFailure || stoppedOnThreshold) {
      break;
    }
  }

  const metrics = buildImportMetrics({
    sourceBatchCount,
    skippedBatchCount,
    attemptedBatchCount,
    completedBatchCount,
    failedBatchCount,
    storedEntityCount,
    storedRelationCount,
    writeDurations
  });
  thresholdViolations = graphBatchImportThresholdViolations({
    thresholds,
    metrics,
    unresolvedFailedBatchCount: failedBatches.size
  });
  const status = statusFromState({
    stoppedOnFailure,
    stoppedOnThreshold: stoppedOnThreshold || thresholdViolations.length > 0,
    unresolvedFailedBatchCount: failedBatches.size
  });
  const finishedAt = now();
  const checkpoint = buildCheckpoint({
    importId,
    status,
    startedAt: previousCheckpoint?.startedAt ?? startedAt,
    updatedAt: finishedAt,
    completedBatchIds,
    failedBatches,
    storedEntityCount,
    storedRelationCount,
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint })
  });
  request.checkpointStore?.write(checkpoint);

  return {
    schemaVersion: 1,
    importId,
    status,
    stopReason:
      stoppedOnThreshold || thresholdViolations.length > 0
        ? "threshold_exceeded"
        : stoppedOnFailure
          ? "batch_failed"
          : "completed",
    startedAt,
    finishedAt,
    metrics,
    writes,
    failures: [...failedBatches.values()].sort((left, right) =>
      left.batchId.localeCompare(right.batchId)
    ),
    thresholdViolations,
    checkpoint
  };
}

export function* chunkGraphExtractionBatch(
  batch: GraphExtractionBatch,
  options: GraphExtractionBatchChunkOptions
): Iterable<GraphExtractionBatch> {
  assertValidGraphExtractionBatch(batch);
  assertChunkOptions(options);

  const createdAt = options.createdAt ?? batch.createdAt;
  const prefix = options.chunkIdPrefix ?? batch.id;
  const entityById = new Map(batch.entities.map((entity) => [entity.id, entity]));
  const entityOrder = new Map(batch.entities.map((entity, index) => [entity.id, index]));

  if (options.includeEntityOnlyBatches !== false) {
    let chunkIndex = 0;
    for (let index = 0; index < batch.entities.length; index += options.maxEntitiesPerBatch) {
      const entities = batch.entities.slice(index, index + options.maxEntitiesPerBatch);
      yield validChunk({
        batch,
        id: `${prefix}_entities_${chunkIndex}`,
        createdAt,
        entities,
        relations: []
      });
      chunkIndex += 1;
    }
  }

  let relationChunkIndex = 0;
  let currentRelations: GraphRelationProposal[] = [];
  let currentEndpointIds = new Set<string>();

  for (const relation of batch.relations) {
    const relationEndpointIds = new Set([relation.sourceEntityId, relation.targetEntityId]);
    if (relationEndpointIds.size > options.maxEntitiesPerBatch) {
      throw new Error(
        `Graph relation "${relation.id}" requires ${relationEndpointIds.size} endpoint entities, but maxEntitiesPerBatch is ${options.maxEntitiesPerBatch}.`
      );
    }

    const nextEndpointIds = new Set([...currentEndpointIds, ...relationEndpointIds]);
    const wouldOverflow =
      currentRelations.length >= options.maxRelationsPerBatch ||
      nextEndpointIds.size > options.maxEntitiesPerBatch;
    if (currentRelations.length > 0 && wouldOverflow) {
      yield relationChunk({
        batch,
        id: `${prefix}_relations_${relationChunkIndex}`,
        createdAt,
        relations: currentRelations,
        endpointIds: currentEndpointIds,
        entityById,
        entityOrder
      });
      relationChunkIndex += 1;
      currentRelations = [];
      currentEndpointIds = new Set<string>();
    }

    currentRelations.push(relation);
    currentEndpointIds.add(relation.sourceEntityId);
    currentEndpointIds.add(relation.targetEntityId);
  }

  if (currentRelations.length > 0) {
    yield relationChunk({
      batch,
      id: `${prefix}_relations_${relationChunkIndex}`,
      createdAt,
      relations: currentRelations,
      endpointIds: currentEndpointIds,
      entityById,
      entityOrder
    });
  }
}

export function renderGraphBatchImportMarkdown(result: GraphBatchImportResult): string {
  const lines = [
    "# Graph Batch Import",
    "",
    `Status: **${result.status}**`,
    "",
    `- Import: \`${result.importId}\``,
    `- Stop reason: \`${result.stopReason}\``,
    `- Started: \`${result.startedAt}\``,
    `- Finished: \`${result.finishedAt}\``,
    "",
    "| Signal | Value |",
    "| --- | ---: |",
    `| Source batches | ${result.metrics.sourceBatchCount} |`,
    `| Skipped batches | ${result.metrics.skippedBatchCount} |`,
    `| Attempted batches | ${result.metrics.attemptedBatchCount} |`,
    `| Completed batches | ${result.metrics.completedBatchCount} |`,
    `| Failed batches | ${result.metrics.failedBatchCount} |`,
    `| Stored entities | ${result.metrics.storedEntityCount} |`,
    `| Stored relations | ${result.metrics.storedRelationCount} |`,
    `| Write total | ${formatMs(result.metrics.totalWriteMs)} |`,
    `| Write p95 | ${formatMs(result.metrics.p95BatchWriteMs)} |`,
    `| Write max | ${formatMs(result.metrics.maxBatchWriteMs)} |`
  ];

  if (result.failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of result.failures) {
      lines.push(
        `- \`${failure.batchId}\` after ${failure.attempts} attempt(s): ${failure.message}`
      );
    }
  }

  if (result.thresholdViolations.length > 0) {
    lines.push("", "## Threshold Violations", "");
    for (const violation of result.thresholdViolations) {
      lines.push(`- ${violation.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeBatchWithRetries(input: {
  readonly store: GraphStore;
  readonly batch: GraphExtractionBatch;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly now: () => string;
}): Promise<
  | {
      readonly status: "succeeded";
      readonly attemptCount: number;
      readonly durationMs: number;
      readonly result: GraphStoreWriteResult;
    }
  | {
      readonly status: "failed";
      readonly failure: GraphBatchImportFailure;
    }
> {
  let finalError: unknown;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      assertValidGraphExtractionBatch(input.batch);
      const measured = measure(() => input.store.addExtractionBatch(input.batch));
      if (!measured.result.accepted) {
        throw new Error(`Graph store rejected batch "${input.batch.id}".`);
      }
      return {
        status: "succeeded",
        attemptCount: attempt,
        durationMs: measured.durationMs,
        result: measured.result
      };
    } catch (error) {
      finalError = error;
      if (attempt < input.maxAttempts && input.retryDelayMs > 0) {
        await sleep(input.retryDelayMs);
      }
    }
  }

  return {
    status: "failed",
    failure: {
      batchId: input.batch.id || "unknown_batch",
      attempts: input.maxAttempts,
      message: redactText(errorMessage(finalError)),
      failedAt: input.now()
    }
  };
}

function writeCheckpoint(input: {
  readonly checkpointStore?: GraphBatchImportCheckpointStore;
  readonly importId: string;
  readonly status: GraphBatchImportStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedBatchIds: ReadonlySet<string>;
  readonly failedBatches: ReadonlyMap<string, GraphBatchImportFailure>;
  readonly previousCheckpoint?: GraphBatchImportCheckpoint;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
}): void {
  input.checkpointStore?.write(buildCheckpoint(input));
}

function buildCheckpoint(input: {
  readonly importId: string;
  readonly status: GraphBatchImportStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedBatchIds: ReadonlySet<string>;
  readonly failedBatches: ReadonlyMap<string, GraphBatchImportFailure>;
  readonly previousCheckpoint?: GraphBatchImportCheckpoint;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
}): GraphBatchImportCheckpoint {
  return {
    schemaVersion: 1,
    importId: input.importId,
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    completedBatchIds: [...input.completedBatchIds].sort(),
    failedBatches: [...input.failedBatches.values()].sort((left, right) =>
      left.batchId.localeCompare(right.batchId)
    ),
    metrics: {
      completedBatchCount: input.completedBatchIds.size,
      failedBatchCount: input.failedBatches.size,
      storedEntityCount:
        (input.previousCheckpoint?.metrics.storedEntityCount ?? 0) + input.storedEntityCount,
      storedRelationCount:
        (input.previousCheckpoint?.metrics.storedRelationCount ?? 0) + input.storedRelationCount
    }
  };
}

function buildImportMetrics(input: {
  readonly sourceBatchCount: number;
  readonly skippedBatchCount: number;
  readonly attemptedBatchCount: number;
  readonly completedBatchCount: number;
  readonly failedBatchCount: number;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
  readonly writeDurations: readonly number[];
}): GraphBatchImportMetrics {
  const totalWriteMs = input.writeDurations.reduce((total, duration) => total + duration, 0);

  return {
    sourceBatchCount: input.sourceBatchCount,
    skippedBatchCount: input.skippedBatchCount,
    attemptedBatchCount: input.attemptedBatchCount,
    completedBatchCount: input.completedBatchCount,
    failedBatchCount: input.failedBatchCount,
    storedEntityCount: input.storedEntityCount,
    storedRelationCount: input.storedRelationCount,
    totalWriteMs: roundMs(totalWriteMs),
    maxBatchWriteMs: roundMs(
      input.writeDurations.length === 0 ? 0 : Math.max(...input.writeDurations)
    ),
    p95BatchWriteMs: roundMs(percentile(input.writeDurations, 0.95))
  };
}

function graphBatchImportThresholdViolations(input: {
  readonly thresholds: GraphBatchImportThresholds;
  readonly metrics: GraphBatchImportMetrics;
  readonly unresolvedFailedBatchCount: number;
}): readonly GraphBatchImportThresholdViolation[] {
  const failureRatio =
    input.metrics.attemptedBatchCount === 0
      ? 0
      : input.unresolvedFailedBatchCount / input.metrics.attemptedBatchCount;

  return [
    thresholdViolation(
      "failures.unresolvedBatchCount",
      input.unresolvedFailedBatchCount,
      input.thresholds.maxFailedBatches
    ),
    thresholdViolation("failures.ratio", failureRatio, input.thresholds.maxFailureRatio),
    thresholdViolation(
      "writes.maxBatchWriteMs",
      input.metrics.maxBatchWriteMs,
      input.thresholds.maxBatchWriteMs
    ),
    thresholdViolation(
      "writes.p95BatchWriteMs",
      input.metrics.p95BatchWriteMs,
      input.thresholds.maxWriteP95Ms
    ),
    thresholdViolation(
      "writes.totalWriteMs",
      input.metrics.totalWriteMs,
      input.thresholds.maxTotalWriteMs
    )
  ].filter((violation): violation is GraphBatchImportThresholdViolation => violation !== undefined);
}

function thresholdViolation(
  signalName: string,
  observedValue: number,
  threshold: number | undefined
): GraphBatchImportThresholdViolation | undefined {
  if (threshold === undefined || observedValue <= threshold) {
    return undefined;
  }

  return {
    signalName,
    observedValue: roundMs(observedValue),
    threshold,
    message: `${signalName} ${roundMs(observedValue)} exceeded threshold ${roundMs(threshold)}.`
  };
}

function statusFromState(input: {
  readonly stoppedOnFailure: boolean;
  readonly stoppedOnThreshold: boolean;
  readonly unresolvedFailedBatchCount: number;
}): GraphBatchImportStatus {
  if (input.stoppedOnFailure || input.stoppedOnThreshold) {
    return "failed";
  }
  if (input.unresolvedFailedBatchCount > 0) {
    return "partial";
  }
  return "succeeded";
}

function relationChunk(input: {
  readonly batch: GraphExtractionBatch;
  readonly id: string;
  readonly createdAt: string;
  readonly relations: readonly GraphRelationProposal[];
  readonly endpointIds: ReadonlySet<string>;
  readonly entityById: ReadonlyMap<string, GraphEntityProposal>;
  readonly entityOrder: ReadonlyMap<string, number>;
}): GraphExtractionBatch {
  const entities = [...input.endpointIds]
    .map((id) => {
      const entity = input.entityById.get(id);
      if (entity === undefined) {
        throw new Error(`Graph relation endpoint "${id}" is missing from the source batch.`);
      }
      return entity;
    })
    .sort(
      (left, right) =>
        (input.entityOrder.get(left.id) ?? 0) - (input.entityOrder.get(right.id) ?? 0)
    );

  return validChunk({
    batch: input.batch,
    id: input.id,
    createdAt: input.createdAt,
    entities,
    relations: input.relations
  });
}

function validChunk(input: {
  readonly batch: GraphExtractionBatch;
  readonly id: string;
  readonly createdAt: string;
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
}): GraphExtractionBatch {
  const chunk = {
    id: input.id,
    namespaceId: input.batch.namespaceId,
    ontology: input.batch.ontology,
    entities: input.entities,
    relations: input.relations,
    createdAt: input.createdAt
  };
  assertValidGraphExtractionBatch(chunk);
  return chunk;
}

function assertImportOptions(input: {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly thresholds: GraphBatchImportThresholds;
}): void {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("Graph batch import maxAttempts must be an integer >= 1.");
  }
  if (!Number.isFinite(input.retryDelayMs) || input.retryDelayMs < 0) {
    throw new Error("Graph batch import retryDelayMs must be a non-negative number.");
  }
  assertOptionalNonNegativeInteger(input.thresholds.maxFailedBatches, "maxFailedBatches");
  assertOptionalRatio(input.thresholds.maxFailureRatio, "maxFailureRatio");
  assertOptionalNonNegativeNumber(input.thresholds.maxBatchWriteMs, "maxBatchWriteMs");
  assertOptionalNonNegativeNumber(input.thresholds.maxWriteP95Ms, "maxWriteP95Ms");
  assertOptionalNonNegativeNumber(input.thresholds.maxTotalWriteMs, "maxTotalWriteMs");
}

function assertChunkOptions(options: GraphExtractionBatchChunkOptions): void {
  if (!Number.isInteger(options.maxEntitiesPerBatch) || options.maxEntitiesPerBatch < 1) {
    throw new Error("Graph chunk maxEntitiesPerBatch must be an integer >= 1.");
  }
  if (!Number.isInteger(options.maxRelationsPerBatch) || options.maxRelationsPerBatch < 1) {
    throw new Error("Graph chunk maxRelationsPerBatch must be an integer >= 1.");
  }
}

function assertCheckpoint(checkpoint: GraphBatchImportCheckpoint): void {
  if (checkpoint.schemaVersion !== 1 || !checkpoint.importId?.trim()) {
    throw new Error("Invalid graph batch import checkpoint.");
  }
  if (!["succeeded", "partial", "failed"].includes(checkpoint.status)) {
    throw new Error("Invalid graph batch import checkpoint status.");
  }
  if (!Array.isArray(checkpoint.completedBatchIds) || !Array.isArray(checkpoint.failedBatches)) {
    throw new Error("Invalid graph batch import checkpoint batch lists.");
  }
}

function assertOptionalNonNegativeNumber(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`Graph batch import threshold ${name} must be a non-negative number.`);
  }
}

function assertOptionalNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`Graph batch import threshold ${name} must be a non-negative integer.`);
  }
}

function assertOptionalRatio(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`Graph batch import threshold ${name} must be a ratio between 0 and 1.`);
  }
}

function measure<T>(action: () => T): { readonly durationMs: number; readonly result: T } {
  const startedAt = performance.now();
  const result = action();
  return {
    durationMs: performance.now() - startedAt,
    result
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatMs(value: number): string {
  return `${roundMs(value).toFixed(3)}ms`;
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Graph batch import failed.";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
