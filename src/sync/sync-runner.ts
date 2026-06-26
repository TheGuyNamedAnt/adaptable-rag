import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import { hashStableValue } from "../shared/stable-hash.js";
import type {
  SourceConnector,
  SourceConnectorDeleteItem,
  SourceConnectorErrorItem,
  SourceConnectorSyncResult,
  SourceConnectorUpsertItem,
  SourceConnectorWarning,
  SourceSyncMode
} from "./source-connector.js";
import {
  SOURCE_SYNC_LEDGER_SCHEMA_VERSION,
  sourceSyncLedgerEvidenceBoundary,
  sourceSyncLedgerMetrics,
  type SourceSyncLedger,
  type SourceSyncLedgerEntry,
  type SourceSyncLedgerStore,
  type SourceSyncLedgerStatus
} from "./sync-ledger.js";

export type SourceSyncRunStatus = SourceSyncLedgerStatus;

export interface SourceSyncRunnerOptions {
  readonly connector: SourceConnector;
  readonly ledgerStore?: SourceSyncLedgerStore;
  readonly now?: () => string;
}

export interface SourceSyncRunRequest {
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly mode?: SourceSyncMode;
  readonly previousLedger?: SourceSyncLedger;
  readonly runId?: string;
  readonly requestedAt?: string;
  readonly deleteMissingItems?: boolean;
}

export interface SourceSyncDeletedItem {
  readonly sourceItemId: string;
  readonly recordId?: string;
  readonly deletedAt: string;
}

export interface SourceSyncFailedItem {
  readonly sourceItemId: string;
  readonly recordId?: string;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface SourceSyncRunMetrics {
  readonly listedItemCount: number;
  readonly returnedRecordCount: number;
  readonly deletedItemCount: number;
  readonly failedItemCount: number;
  readonly skippedUnchangedCount: number;
  readonly tombstonedMissingCount: number;
  readonly warningCount: number;
}

export interface SourceSyncRunResult {
  readonly status: SourceSyncRunStatus;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: SourceSyncMode;
  readonly complete: boolean;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly records: readonly CorpusRecord[];
  readonly deleted: readonly SourceSyncDeletedItem[];
  readonly failed: readonly SourceSyncFailedItem[];
  readonly warnings: readonly SourceConnectorWarning[];
  readonly ledger: SourceSyncLedger;
  readonly metrics: SourceSyncRunMetrics;
}

export class SourceSyncRunner {
  private readonly connector: SourceConnector;
  private readonly ledgerStore: SourceSyncLedgerStore | undefined;
  private readonly now: () => string;

  constructor(options: SourceSyncRunnerOptions) {
    if (!options.connector.id.trim()) {
      throw new Error("Source connector id is required.");
    }
    if (!options.connector.description.trim()) {
      throw new Error("Source connector description is required.");
    }

    this.connector = options.connector;
    this.ledgerStore = options.ledgerStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async sync(request: SourceSyncRunRequest): Promise<SourceSyncRunResult> {
    const startedAt = request.requestedAt ?? this.now();
    const runId = request.runId ?? `source_sync_${safeTimestamp(startedAt)}`;
    const mode = request.mode ?? "delta";
    const previousLedger = request.previousLedger ?? (await this.loadPreviousLedger(request));

    try {
      const connectorResult = await this.connector.sync({
        profile: request.profile,
        source: request.source,
        requestedBy: request.requestedBy,
        runId,
        requestedAt: startedAt,
        mode,
        ...(previousLedger?.cursor === undefined ? {} : { previousCursor: previousLedger.cursor })
      });
      const result = this.buildResult({
        request,
        previousLedger,
        connectorResult,
        runId,
        startedAt,
        mode
      });
      await this.ledgerStore?.save(result.ledger);
      return result;
    } catch (error) {
      const result = this.failedRun({
        request,
        previousLedger,
        runId,
        startedAt,
        mode,
        error
      });
      await this.ledgerStore?.save(result.ledger);
      return result;
    }
  }

  private async loadPreviousLedger(
    request: SourceSyncRunRequest
  ): Promise<SourceSyncLedger | undefined> {
    return this.ledgerStore?.load({
      connectorId: this.connector.id,
      sourceId: request.source.id,
      namespaceId: request.profile.namespaceId
    });
  }

  private buildResult(input: {
    readonly request: SourceSyncRunRequest;
    readonly previousLedger: SourceSyncLedger | undefined;
    readonly connectorResult: SourceConnectorSyncResult;
    readonly runId: string;
    readonly startedAt: string;
    readonly mode: SourceSyncMode;
  }): SourceSyncRunResult {
    const warnings: SourceConnectorWarning[] = [...(input.connectorResult.warnings ?? [])];
    if (input.connectorResult.sourceId !== input.request.source.id) {
      warnings.push({
        sourceId: input.request.source.id,
        code: "source_id_mismatch",
        message: `Connector returned sourceId "${input.connectorResult.sourceId}" for configured source "${input.request.source.id}".`
      });
    }

    const previousBySourceItemId = new Map(
      (input.previousLedger?.entries ?? []).map((entry) => [entry.sourceItemId, entry])
    );
    const currentBySourceItemId = new Map<string, SourceSyncLedgerEntry>();
    const seen = new Set<string>();
    const records: CorpusRecord[] = [];
    const deleted: SourceSyncDeletedItem[] = [];
    const failed: SourceSyncFailedItem[] = [];
    let skippedUnchangedCount = 0;
    let tombstonedMissingCount = 0;

    for (const item of input.connectorResult.items) {
      if (!validSourceItemId(item.sourceItemId)) {
        warnings.push({
          sourceId: input.request.source.id,
          code: "invalid_source_item_id",
          message: "Connector returned an item without a stable sourceItemId."
        });
        continue;
      }

      const previous = previousBySourceItemId.get(item.sourceItemId);
      seen.add(item.sourceItemId);

      if (item.operation === "upsert") {
        const applied = applyUpsertItem(item, previous, input.startedAt);
        currentBySourceItemId.set(item.sourceItemId, applied.entry);
        if (applied.changed) {
          records.push(item.record);
        } else {
          skippedUnchangedCount += 1;
        }
        continue;
      }

      if (item.operation === "delete") {
        const applied = applyDeleteItem(item, previous, input.startedAt);
        currentBySourceItemId.set(item.sourceItemId, applied.entry);
        if (applied.deleted) {
          deleted.push(applied.deleted);
        }
        continue;
      }

      const applied = applyErrorItem(item, previous, input.startedAt);
      currentBySourceItemId.set(item.sourceItemId, applied.entry);
      failed.push(applied.failed);
    }

    const deleteMissing =
      input.mode === "full" &&
      input.connectorResult.complete === true &&
      input.request.deleteMissingItems !== false;
    for (const previous of previousBySourceItemId.values()) {
      if (seen.has(previous.sourceItemId)) {
        continue;
      }

      if (deleteMissing && previous.status !== "deleted") {
        const entry = tombstoneMissingEntry(previous, input.startedAt);
        currentBySourceItemId.set(previous.sourceItemId, entry);
        tombstonedMissingCount += 1;
        deleted.push({
          sourceItemId: previous.sourceItemId,
          ...(previous.recordId === undefined ? {} : { recordId: previous.recordId }),
          deletedAt: input.startedAt
        });
        continue;
      }

      currentBySourceItemId.set(previous.sourceItemId, {
        ...previous,
        lastAction: "unchanged",
        lastSeenAt: input.startedAt
      });
      skippedUnchangedCount += 1;
    }

    const entries = [...currentBySourceItemId.values()].sort((left, right) =>
      left.sourceItemId.localeCompare(right.sourceItemId)
    );
    const status: SourceSyncRunStatus = failed.length > 0 ? "partial" : "succeeded";
    const finishedAt = this.now();
    const ledger = buildLedger({
      runId: input.runId,
      generatedAt: finishedAt,
      status,
      connectorId: this.connector.id,
      sourceId: input.request.source.id,
      namespaceId: input.request.profile.namespaceId,
      ...(input.connectorResult.nextCursor === undefined
        ? {}
        : { cursor: input.connectorResult.nextCursor }),
      entries
    });

    return {
      status,
      runId: input.runId,
      startedAt: input.startedAt,
      finishedAt,
      mode: input.mode,
      complete: input.connectorResult.complete === true,
      connectorId: this.connector.id,
      sourceId: input.request.source.id,
      records,
      deleted,
      failed,
      warnings,
      ledger,
      metrics: {
        listedItemCount: input.connectorResult.items.length,
        returnedRecordCount: records.length,
        deletedItemCount: deleted.length,
        failedItemCount: failed.length,
        skippedUnchangedCount,
        tombstonedMissingCount,
        warningCount: warnings.length
      }
    };
  }

  private failedRun(input: {
    readonly request: SourceSyncRunRequest;
    readonly previousLedger: SourceSyncLedger | undefined;
    readonly runId: string;
    readonly startedAt: string;
    readonly mode: SourceSyncMode;
    readonly error: unknown;
  }): SourceSyncRunResult {
    const finishedAt = this.now();
    const previousEntries = input.previousLedger?.entries ?? [];
    const entries = previousEntries.map((entry) => ({
      ...entry,
      lastAction: "failed" as const,
      lastSeenAt: input.startedAt,
      failureCount: entry.failureCount + 1,
      lastErrorCode: errorName(input.error),
      retryable: true
    }));
    const ledger = buildLedger({
      runId: input.runId,
      generatedAt: finishedAt,
      status: "failed",
      connectorId: this.connector.id,
      sourceId: input.request.source.id,
      namespaceId: input.request.profile.namespaceId,
      ...(input.previousLedger?.cursor === undefined
        ? {}
        : { cursor: input.previousLedger.cursor }),
      entries
    });

    return {
      status: "failed",
      runId: input.runId,
      startedAt: input.startedAt,
      finishedAt,
      mode: input.mode,
      complete: false,
      connectorId: this.connector.id,
      sourceId: input.request.source.id,
      records: [],
      deleted: [],
      failed: [],
      warnings: [
        {
          sourceId: input.request.source.id,
          code: "connector_failed",
          message: `Source connector failed: ${errorName(input.error)}.`
        }
      ],
      ledger,
      metrics: {
        listedItemCount: 0,
        returnedRecordCount: 0,
        deletedItemCount: 0,
        failedItemCount: 0,
        skippedUnchangedCount: previousEntries.length,
        tombstonedMissingCount: 0,
        warningCount: 1
      }
    };
  }
}

function applyUpsertItem(
  item: SourceConnectorUpsertItem,
  previous: SourceSyncLedgerEntry | undefined,
  seenAt: string
): { readonly entry: SourceSyncLedgerEntry; readonly changed: boolean } {
  const contentHash = item.contentHash ?? recordContentHash(item.record);
  const accessScopeHash = hashStableValue(item.record.accessScope);
  const sourceAclHash = item.sourceAcl === undefined ? undefined : hashStableValue(item.sourceAcl);
  const changed =
    !previous ||
    previous.status !== "active" ||
    previous.recordId !== item.record.id ||
    previous.version !== item.version ||
    previous.contentHash !== contentHash ||
    previous.accessScopeHash !== accessScopeHash ||
    previous.sourceAclHash !== sourceAclHash;

  return {
    changed,
    entry: {
      sourceItemId: item.sourceItemId,
      recordId: item.record.id,
      status: "active",
      lastAction: previous === undefined ? "created" : changed ? "updated" : "unchanged",
      ...(item.version === undefined ? {} : { version: item.version }),
      contentHash,
      accessScopeHash,
      ...(sourceAclHash === undefined ? {} : { sourceAclHash }),
      firstSeenAt: previous?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
      ...(changed
        ? { lastChangedAt: seenAt }
        : previous?.lastChangedAt === undefined
          ? {}
          : { lastChangedAt: previous.lastChangedAt }),
      failureCount: 0
    }
  };
}

function applyDeleteItem(
  item: SourceConnectorDeleteItem,
  previous: SourceSyncLedgerEntry | undefined,
  seenAt: string
): { readonly entry: SourceSyncLedgerEntry; readonly deleted?: SourceSyncDeletedItem } {
  const recordId = item.recordId ?? previous?.recordId;
  const deletedAt = item.deletedAt ?? seenAt;
  const alreadyDeleted = previous?.status === "deleted";
  const entry: SourceSyncLedgerEntry = {
    sourceItemId: item.sourceItemId,
    ...(recordId === undefined ? {} : { recordId }),
    status: "deleted",
    lastAction: alreadyDeleted ? "unchanged" : "deleted",
    ...(item.version === undefined ? previousVersion(previous) : { version: item.version }),
    ...(previous?.contentHash === undefined ? {} : { contentHash: previous.contentHash }),
    ...(previous?.accessScopeHash === undefined
      ? {}
      : { accessScopeHash: previous.accessScopeHash }),
    ...(previous?.sourceAclHash === undefined ? {} : { sourceAclHash: previous.sourceAclHash }),
    firstSeenAt: previous?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
    ...(previous?.lastChangedAt === undefined ? {} : { lastChangedAt: previous.lastChangedAt }),
    deletedAt,
    failureCount: 0
  };

  return {
    entry,
    ...(alreadyDeleted
      ? {}
      : {
          deleted: {
            sourceItemId: item.sourceItemId,
            ...(recordId === undefined ? {} : { recordId }),
            deletedAt
          }
        })
  };
}

function applyErrorItem(
  item: SourceConnectorErrorItem,
  previous: SourceSyncLedgerEntry | undefined,
  seenAt: string
): { readonly entry: SourceSyncLedgerEntry; readonly failed: SourceSyncFailedItem } {
  const recordId = item.recordId ?? previous?.recordId;
  const retryable = item.retryable ?? true;
  return {
    entry: {
      sourceItemId: item.sourceItemId,
      ...(recordId === undefined ? {} : { recordId }),
      status: "failed",
      lastAction: "failed",
      ...(item.version === undefined ? previousVersion(previous) : { version: item.version }),
      ...(previous?.contentHash === undefined ? {} : { contentHash: previous.contentHash }),
      ...(previous?.accessScopeHash === undefined
        ? {}
        : { accessScopeHash: previous.accessScopeHash }),
      ...(previous?.sourceAclHash === undefined ? {} : { sourceAclHash: previous.sourceAclHash }),
      firstSeenAt: previous?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
      ...(previous?.lastChangedAt === undefined ? {} : { lastChangedAt: previous.lastChangedAt }),
      ...(previous?.deletedAt === undefined ? {} : { deletedAt: previous.deletedAt }),
      failureCount: (previous?.failureCount ?? 0) + 1,
      lastErrorCode: item.errorCode,
      retryable
    },
    failed: {
      sourceItemId: item.sourceItemId,
      ...(recordId === undefined ? {} : { recordId }),
      errorCode: item.errorCode,
      message: item.message,
      retryable
    }
  };
}

function tombstoneMissingEntry(
  previous: SourceSyncLedgerEntry,
  seenAt: string
): SourceSyncLedgerEntry {
  return {
    ...previous,
    status: "deleted",
    lastAction: "deleted",
    lastSeenAt: seenAt,
    deletedAt: seenAt,
    failureCount: 0
  };
}

function buildLedger(input: {
  readonly runId: string;
  readonly generatedAt: string;
  readonly status: SourceSyncRunStatus;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly namespaceId: string;
  readonly cursor?: string;
  readonly entries: readonly SourceSyncLedgerEntry[];
}): SourceSyncLedger {
  return {
    schemaVersion: SOURCE_SYNC_LEDGER_SCHEMA_VERSION,
    ledgerId: `${input.runId}_ledger`,
    generatedAt: input.generatedAt,
    status: input.status,
    connectorId: input.connectorId,
    sourceId: input.sourceId,
    namespaceId: input.namespaceId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    entries: input.entries,
    metrics: sourceSyncLedgerMetrics(input.entries),
    evidenceBoundary: sourceSyncLedgerEvidenceBoundary()
  };
}

function recordContentHash(record: CorpusRecord): string {
  return hashStableValue({
    id: record.id,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    title: record.title,
    body: record.body,
    trustTier: record.trustTier,
    sensitivity: record.sensitivity,
    originUri: record.originUri,
    path: record.path,
    owner: record.owner,
    capturedAt: record.capturedAt,
    checksum: record.checksum,
    layout: record.layout,
    metadata: record.metadata
  });
}

function previousVersion(
  previous: SourceSyncLedgerEntry | undefined
): { readonly version: string } | Record<string, never> {
  return previous?.version === undefined ? {} : { version: previous.version };
}

function validSourceItemId(value: string): boolean {
  return value.trim().length > 0;
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
