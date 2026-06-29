import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAdminReviewWorkflowExport,
  renderAdminReviewWorkflowExportMarkdown,
  type AdminReviewTicketPayload
} from "@/lib/review-workflow-export";
import { resolveRagRepoRoot } from "@/lib/repo-root";

export const ADMIN_REVIEW_SYNC_ARTIFACT_SCHEMA_VERSION = 1;

type ArtifactAvailability = "available" | "missing" | "invalid";
type AdminReviewSyncOverallStatus = "ready" | "partial" | "empty" | "failed";
type AdminReviewSyncMode = "dry_run";
type AdminReviewSyncReportStatus = "passed" | "failed";
type AdminReviewSyncSinkStatus = "skipped" | "synced" | "failed";
type AdminReviewReconciliationStatus = "passed" | "needs_attention" | "failed";
type AdminReviewStoreEntryStatus =
  | "pending"
  | "skipped"
  | "synced"
  | "failed"
  | "closed"
  | "stale"
  | "duplicate";

export interface ReviewSyncArtifactState<TSummary> {
  readonly status: ArtifactAvailability;
  readonly path: string;
  readonly updatedAt?: string;
  readonly summary?: TSummary;
  readonly error?: string;
}

export interface AdminReviewExportSummary {
  readonly exportId?: string;
  readonly generatedAt?: string;
  readonly status?: string;
  readonly storageKind?: string;
  readonly exportedDecisionCount: number;
  readonly exportedTicketCount: number;
  readonly queueSnapshotCount: number;
  readonly missingQueueSnapshotCount: number;
  readonly hasMore: boolean;
}

export interface AdminReviewTicketsSummary {
  readonly ticketCount: number;
  readonly decisionCount: number;
  readonly operations: readonly string[];
  readonly statuses: readonly string[];
}

export interface AdminReviewSyncSummary {
  readonly syncId?: string;
  readonly generatedAt?: string;
  readonly mode?: string;
  readonly status?: string;
  readonly ticketCount: number;
  readonly sinkCount: number;
  readonly syncedTicketCount: number;
  readonly failedTicketCount: number;
  readonly skippedTicketCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
}

export interface AdminReviewReconciliationSummary {
  readonly reconciliationId?: string;
  readonly generatedAt?: string;
  readonly status?: string;
  readonly storeId?: string;
  readonly ticketCount: number;
  readonly pendingCount: number;
  readonly skippedCount: number;
  readonly syncedCount: number;
  readonly failedCount: number;
  readonly closedCount: number;
  readonly staleCount: number;
  readonly duplicateCount: number;
  readonly externalRefCount: number;
  readonly unmatchedExternalStatusCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
}

export interface AdminReviewSyncArtifactStatus {
  readonly schemaVersion: typeof ADMIN_REVIEW_SYNC_ARTIFACT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: AdminReviewSyncOverallStatus;
  readonly exportArtifact: ReviewSyncArtifactState<AdminReviewExportSummary>;
  readonly ticketsArtifact: ReviewSyncArtifactState<AdminReviewTicketsSummary>;
  readonly syncArtifact: ReviewSyncArtifactState<AdminReviewSyncSummary>;
  readonly reconciliationArtifact: ReviewSyncArtifactState<AdminReviewReconciliationSummary>;
  readonly artifactPaths: ReviewSyncArtifactPaths;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly evidenceBoundary: readonly string[];
}

export interface ReviewSyncArtifactPaths {
  readonly exportJson: string;
  readonly exportMarkdown: string;
  readonly ticketsJson: string;
  readonly syncTicketsJson: string;
  readonly syncJson: string;
  readonly syncMarkdown: string;
  readonly idempotencyStoreJson: string;
  readonly reconciliationJson: string;
  readonly reconciliationMarkdown: string;
}

interface AdminReviewSyncReport {
  readonly schemaVersion: 1;
  readonly syncId: string;
  readonly generatedAt: string;
  readonly mode: AdminReviewSyncMode;
  readonly status: AdminReviewSyncReportStatus;
  readonly ticketCount: number;
  readonly sinkCount: number;
  readonly syncedSinkCount: number;
  readonly failedSinkCount: number;
  readonly skippedSinkCount: number;
  readonly syncedTicketCount: number;
  readonly failedTicketCount: number;
  readonly skippedTicketCount: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly results: readonly AdminReviewSyncSinkResult[];
  readonly evidenceBoundary: readonly string[];
}

interface AdminReviewSyncSinkResult {
  readonly sinkId: string;
  readonly kind: "dry_run";
  readonly status: AdminReviewSyncSinkStatus;
  readonly mode: AdminReviewSyncMode;
  readonly syncedTicketCount: number;
  readonly failedTicketCount: number;
  readonly skippedTicketCount: number;
  readonly attempts: readonly unknown[];
  readonly dedupeKeys: readonly string[];
  readonly externalIds: readonly string[];
  readonly externalRefs: readonly AdminReviewTicketExternalRef[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

interface AdminReviewTicketExternalRef {
  readonly dedupeKey: string;
  readonly externalId: string;
  readonly url?: string;
  readonly status?: string;
  readonly syncedAt?: string;
}

interface AdminReviewTicketIdempotencyStoreEntry {
  readonly dedupeKey: string;
  readonly payloadId: string;
  readonly kind: AdminReviewTicketPayload["kind"];
  readonly operation: AdminReviewTicketPayload["operation"];
  readonly title: string;
  readonly priority: AdminReviewTicketPayload["priority"];
  readonly ticketStatus: string;
  readonly reconciliationStatus: AdminReviewStoreEntryStatus;
  readonly source: AdminReviewTicketPayload["source"];
  readonly destination?: string;
  readonly labels: readonly string[];
  readonly artifactPaths: readonly string[];
  readonly payloadHash: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastSyncedAt?: string;
  readonly externalRefs: readonly AdminReviewTicketExternalRef[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

interface AdminReviewTicketIdempotencyMetrics {
  readonly ticketCount: number;
  readonly pendingCount: number;
  readonly skippedCount: number;
  readonly syncedCount: number;
  readonly failedCount: number;
  readonly closedCount: number;
  readonly staleCount: number;
  readonly duplicateCount: number;
  readonly externalRefCount: number;
  readonly unmatchedExternalStatusCount: number;
}

interface AdminReviewTicketIdempotencyStore {
  readonly schemaVersion: 1;
  readonly storeId: string;
  readonly generatedAt: string;
  readonly entries: readonly AdminReviewTicketIdempotencyStoreEntry[];
  readonly metrics: AdminReviewTicketIdempotencyMetrics;
  readonly evidenceBoundary: readonly string[];
}

interface AdminReviewReconciliationReport {
  readonly schemaVersion: 1;
  readonly reconciliationId: string;
  readonly generatedAt: string;
  readonly status: AdminReviewReconciliationStatus;
  readonly storeId: string;
  readonly syncId?: string;
  readonly metrics: AdminReviewTicketIdempotencyMetrics;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly unmatchedExternalStatuses: readonly unknown[];
  readonly evidenceBoundary: readonly string[];
}

interface AdminReviewReconciliationResult {
  readonly store: AdminReviewTicketIdempotencyStore;
  readonly report: AdminReviewReconciliationReport;
}

interface PreviousStoreReadResult {
  readonly store?: AdminReviewTicketIdempotencyStore;
  readonly warning?: string;
}

const ARTIFACT_PATHS: ReviewSyncArtifactPaths = {
  exportJson: ".rag/admin-review-export/latest/export.json",
  exportMarkdown: ".rag/admin-review-export/latest/export.md",
  ticketsJson: ".rag/admin-review-export/latest/tickets.json",
  syncTicketsJson: ".rag/review-sync/admin-ui/tickets.json",
  syncJson: ".rag/review-sync/admin-ui/sync.json",
  syncMarkdown: ".rag/review-sync/admin-ui/sync.md",
  idempotencyStoreJson: ".rag/review-reconciliation/admin-ui/idempotency-store.json",
  reconciliationJson: ".rag/review-reconciliation/admin-ui/reconciliation.json",
  reconciliationMarkdown: ".rag/review-reconciliation/admin-ui/reconciliation.md"
};

export async function getAdminReviewSyncArtifactStatus(): Promise<AdminReviewSyncArtifactStatus> {
  const [exportArtifact, ticketsArtifact, syncArtifact, reconciliationArtifact] = await Promise.all(
    [
      readJsonArtifact(ARTIFACT_PATHS.exportJson, summarizeExportArtifact),
      readJsonArtifact(ARTIFACT_PATHS.ticketsJson, summarizeTicketsArtifact),
      readJsonArtifact(ARTIFACT_PATHS.syncJson, summarizeSyncArtifact),
      readJsonArtifact(ARTIFACT_PATHS.reconciliationJson, summarizeReconciliationArtifact)
    ]
  );
  return buildArtifactStatus({
    exportArtifact,
    ticketsArtifact,
    syncArtifact,
    reconciliationArtifact
  });
}

export async function runAdminReviewDryRunSync(): Promise<AdminReviewSyncArtifactStatus> {
  const generatedAt = new Date().toISOString();
  const exportArtifact = await buildAdminReviewWorkflowExport({
    generatedAt,
    exportId: `admin_review_workflow_${safeTimestamp(generatedAt)}`,
    limit: 100,
    offset: 0
  });

  await writeJsonArtifact(ARTIFACT_PATHS.exportJson, exportArtifact);
  await writeJsonArtifact(ARTIFACT_PATHS.ticketsJson, exportArtifact.tickets);
  await writeTextArtifact(
    ARTIFACT_PATHS.exportMarkdown,
    renderAdminReviewWorkflowExportMarkdown(exportArtifact)
  );

  const syncReport = buildDryRunSyncReport(exportArtifact.tickets, generatedAt, {
    exportHasMore: exportArtifact.source.hasMore
  });
  await writeJsonArtifact(ARTIFACT_PATHS.syncTicketsJson, exportArtifact.tickets);
  await writeJsonArtifact(ARTIFACT_PATHS.syncJson, syncReport);
  await writeTextArtifact(ARTIFACT_PATHS.syncMarkdown, renderReviewSyncMarkdown(syncReport));

  const previousStore = await readPreviousStore();
  const reconciliation = reconcileAdminReviewTickets({
    tickets: exportArtifact.tickets,
    syncReport,
    generatedAt,
    previousStore: previousStore.store,
    warnings: previousStore.warning ? [previousStore.warning] : []
  });
  await writeJsonArtifact(ARTIFACT_PATHS.idempotencyStoreJson, reconciliation.store);
  await writeJsonArtifact(ARTIFACT_PATHS.reconciliationJson, reconciliation.report);
  await writeTextArtifact(
    ARTIFACT_PATHS.reconciliationMarkdown,
    renderReviewReconciliationMarkdown(reconciliation.report)
  );

  return getAdminReviewSyncArtifactStatus();
}

function buildArtifactStatus(input: {
  readonly exportArtifact: ReviewSyncArtifactState<AdminReviewExportSummary>;
  readonly ticketsArtifact: ReviewSyncArtifactState<AdminReviewTicketsSummary>;
  readonly syncArtifact: ReviewSyncArtifactState<AdminReviewSyncSummary>;
  readonly reconciliationArtifact: ReviewSyncArtifactState<AdminReviewReconciliationSummary>;
}): AdminReviewSyncArtifactStatus {
  const artifacts = [
    input.exportArtifact,
    input.ticketsArtifact,
    input.syncArtifact,
    input.reconciliationArtifact
  ];
  const errors = artifacts.flatMap((artifact) =>
    artifact.status === "invalid" && artifact.error ? [`${artifact.path}: ${artifact.error}`] : []
  );
  const warnings = [
    ...(input.exportArtifact.status === "missing"
      ? ["Admin review export has not been built."]
      : []),
    ...(input.ticketsArtifact.status === "missing" ? ["Ticket payload export is missing."] : []),
    ...(input.syncArtifact.status === "missing" ? ["Review ticket sync has not been run."] : []),
    ...(input.reconciliationArtifact.status === "missing"
      ? ["Review ticket reconciliation has not been run."]
      : []),
    ...(input.exportArtifact.summary?.hasMore
      ? [
          "The latest export is paginated. Use the CLI export path for a complete external sync when workflow history exceeds 100 records."
        ]
      : []),
    ...(input.syncArtifact.summary?.failedTicketCount
      ? ["The latest sync report contains failed tickets."]
      : []),
    ...(input.syncArtifact.summary?.warningCount
      ? [`The latest sync report contains ${input.syncArtifact.summary.warningCount} warning(s).`]
      : []),
    ...(input.syncArtifact.summary?.errorCount
      ? [`The latest sync report contains ${input.syncArtifact.summary.errorCount} error(s).`]
      : []),
    ...(input.reconciliationArtifact.summary?.duplicateCount
      ? ["The latest reconciliation found duplicate dedupe keys."]
      : []),
    ...(input.reconciliationArtifact.summary?.staleCount
      ? ["The latest reconciliation found stale external ticket status."]
      : []),
    ...(input.reconciliationArtifact.summary?.warningCount
      ? [
          `The latest reconciliation contains ${input.reconciliationArtifact.summary.warningCount} warning(s).`
        ]
      : []),
    ...(input.reconciliationArtifact.summary?.errorCount
      ? [
          `The latest reconciliation contains ${input.reconciliationArtifact.summary.errorCount} error(s).`
        ]
      : [])
  ];

  return {
    schemaVersion: ADMIN_REVIEW_SYNC_ARTIFACT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: overallStatus({
      artifacts,
      errors,
      syncStatus: input.syncArtifact.summary?.status,
      reconciliationStatus: input.reconciliationArtifact.summary?.status
    }),
    exportArtifact: input.exportArtifact,
    ticketsArtifact: input.ticketsArtifact,
    syncArtifact: input.syncArtifact,
    reconciliationArtifact: input.reconciliationArtifact,
    artifactPaths: ARTIFACT_PATHS,
    warnings: uniqueSorted(warnings),
    errors: uniqueSorted(errors),
    evidenceBoundary: [
      "Shows artifact freshness, counts, statuses, hashes, dedupe keys, and repo-relative artifact paths.",
      "Does not return document bodies, raw prompts, generated answer text, provider payloads, credentials, raw connector content, or raw reviewer identifiers.",
      "The admin UI dry-run sink proves payload shape and idempotency without sending data to an external ticketing system."
    ]
  };
}

function overallStatus(input: {
  readonly artifacts: readonly ReviewSyncArtifactState<unknown>[];
  readonly errors: readonly string[];
  readonly syncStatus?: string;
  readonly reconciliationStatus?: string;
}): AdminReviewSyncOverallStatus {
  if (
    input.errors.length > 0 ||
    input.syncStatus === "failed" ||
    input.reconciliationStatus === "failed"
  ) {
    return "failed";
  }
  if (input.reconciliationStatus === "needs_attention") return "partial";
  const artifacts = input.artifacts;
  if (artifacts.every((artifact) => artifact.status === "missing")) return "empty";
  if (artifacts.every((artifact) => artifact.status === "available")) return "ready";
  return "partial";
}

function buildDryRunSyncReport(
  tickets: readonly AdminReviewTicketPayload[],
  generatedAt: string,
  options: { readonly exportHasMore: boolean }
): AdminReviewSyncReport {
  const syncId = `admin_review_sync_${safeTimestamp(generatedAt)}`;
  const dryRunWarnings =
    tickets.length === 0
      ? ["No review tickets were present; dry-run sync skipped."]
      : ["Dry-run mode recorded review tickets without sending them."];
  const sinkResult: AdminReviewSyncSinkResult = {
    sinkId: "admin_ui_dry_run",
    kind: "dry_run",
    status: "skipped",
    mode: "dry_run",
    syncedTicketCount: 0,
    failedTicketCount: 0,
    skippedTicketCount: tickets.length,
    attempts: [],
    dedupeKeys: tickets.map((ticket) => ticket.dedupeKey),
    externalIds: [],
    externalRefs: [],
    warnings: dryRunWarnings,
    errors: []
  };
  const warnings = uniqueSorted([
    ...dryRunWarnings,
    ...(options.exportHasMore
      ? [
          "Admin review export is paginated; only the first 100 workflow records were included in this dry-run."
        ]
      : [])
  ]);

  return {
    schemaVersion: 1,
    syncId,
    generatedAt,
    mode: "dry_run",
    status: "passed",
    ticketCount: tickets.length,
    sinkCount: 1,
    syncedSinkCount: 0,
    failedSinkCount: 0,
    skippedSinkCount: 1,
    syncedTicketCount: 0,
    failedTicketCount: 0,
    skippedTicketCount: tickets.length,
    warnings,
    errors: [],
    results: [sinkResult],
    evidenceBoundary: reviewTicketSyncEvidenceBoundary()
  };
}

function reconcileAdminReviewTickets(input: {
  readonly tickets: readonly AdminReviewTicketPayload[];
  readonly syncReport: AdminReviewSyncReport;
  readonly generatedAt: string;
  readonly previousStore?: AdminReviewTicketIdempotencyStore;
  readonly warnings: readonly string[];
}): AdminReviewReconciliationResult {
  const storeId = `admin_review_ticket_store_${safeTimestamp(input.generatedAt)}`;
  const reconciliationId = `admin_review_ticket_reconciliation_${safeTimestamp(input.generatedAt)}`;
  const previousByDedupeKey = new Map(
    (input.previousStore?.entries ?? []).map((entry) => [entry.dedupeKey, entry])
  );
  const ticketsByDedupeKey = groupTickets(input.tickets);
  const syncByDedupeKey = syncEvidenceByDedupeKey(input.syncReport);
  const entries = [...ticketsByDedupeKey.entries()].map(([dedupeKey, tickets]) => {
    const ticket = tickets[0];
    if (!ticket) {
      throw new Error(`Review ticket group ${dedupeKey} did not contain a payload.`);
    }
    const duplicate = tickets.length > 1;
    const syncEvidence = syncByDedupeKey.get(dedupeKey) ?? {
      status: "pending" as const,
      warnings: [],
      errors: []
    };
    const reconciliationStatus = duplicate ? "duplicate" : syncEvidence.status;
    const previous = previousByDedupeKey.get(dedupeKey);
    const errors = [
      ...(duplicate ? [`Duplicate review ticket payloads share dedupe key ${dedupeKey}.`] : []),
      ...syncEvidence.errors
    ];

    return {
      dedupeKey,
      payloadId: ticket.payloadId,
      kind: ticket.kind,
      operation: ticket.operation,
      title: ticket.title,
      priority: ticket.priority,
      ticketStatus: ticket.status,
      reconciliationStatus,
      source: ticket.source,
      ...(ticket.destination === undefined ? {} : { destination: ticket.destination }),
      labels: ticket.labels,
      artifactPaths: ticket.artifactPaths,
      payloadHash: payloadHash(ticket),
      firstSeenAt: previous?.firstSeenAt ?? input.generatedAt,
      lastSeenAt: input.generatedAt,
      ...(previous?.lastSyncedAt === undefined ? {} : { lastSyncedAt: previous.lastSyncedAt }),
      externalRefs: [],
      warnings: uniqueSorted(syncEvidence.warnings),
      errors: uniqueSorted(errors)
    } satisfies AdminReviewTicketIdempotencyStoreEntry;
  });
  const metrics = storeMetrics(entries);
  const entryWarnings = entries.flatMap((entry) => entry.warnings);
  const entryErrors = entries.flatMap((entry) => entry.errors);
  const warnings = uniqueSorted([
    ...input.warnings,
    ...entryWarnings,
    "Admin UI dry-run reconciliation did not query external ticket statuses."
  ]);
  const errors = uniqueSorted(entryErrors);
  const evidenceBoundary = reviewTicketReconciliationEvidenceBoundary();
  const store: AdminReviewTicketIdempotencyStore = {
    schemaVersion: 1,
    storeId,
    generatedAt: input.generatedAt,
    entries,
    metrics,
    evidenceBoundary
  };
  const report: AdminReviewReconciliationReport = {
    schemaVersion: 1,
    reconciliationId,
    generatedAt: input.generatedAt,
    status: reconciliationStatus(metrics, errors),
    storeId,
    syncId: input.syncReport.syncId,
    metrics,
    warnings,
    errors,
    unmatchedExternalStatuses: [],
    evidenceBoundary
  };
  return { store, report };
}

function syncEvidenceByDedupeKey(report: AdminReviewSyncReport): Map<
  string,
  {
    readonly status: AdminReviewStoreEntryStatus;
    readonly warnings: readonly string[];
    readonly errors: readonly string[];
  }
> {
  const byDedupeKey = new Map<
    string,
    {
      readonly status: AdminReviewStoreEntryStatus;
      readonly warnings: readonly string[];
      readonly errors: readonly string[];
    }
  >();
  for (const result of report.results) {
    for (const dedupeKey of result.dedupeKeys) {
      const existing = byDedupeKey.get(dedupeKey);
      byDedupeKey.set(dedupeKey, {
        status: strongestSyncStatus(existing?.status ?? "pending", result.status),
        warnings: uniqueSorted([...(existing?.warnings ?? []), ...result.warnings]),
        errors: uniqueSorted([...(existing?.errors ?? []), ...result.errors])
      });
    }
  }
  return byDedupeKey;
}

function strongestSyncStatus(
  current: AdminReviewStoreEntryStatus,
  next: AdminReviewSyncSinkStatus
): AdminReviewStoreEntryStatus {
  if (current === "failed" || next === "failed") return "failed";
  if (current === "synced" || next === "synced") return "synced";
  return "skipped";
}

function groupTickets(
  tickets: readonly AdminReviewTicketPayload[]
): Map<string, readonly AdminReviewTicketPayload[]> {
  const grouped = new Map<string, AdminReviewTicketPayload[]>();
  for (const ticket of tickets) {
    const existing = grouped.get(ticket.dedupeKey) ?? [];
    existing.push(ticket);
    grouped.set(ticket.dedupeKey, existing);
  }
  return grouped;
}

function storeMetrics(
  entries: readonly AdminReviewTicketIdempotencyStoreEntry[]
): AdminReviewTicketIdempotencyMetrics {
  return {
    ticketCount: entries.length,
    pendingCount: countEntries(entries, "pending"),
    skippedCount: countEntries(entries, "skipped"),
    syncedCount: countEntries(entries, "synced"),
    failedCount: countEntries(entries, "failed"),
    closedCount: countEntries(entries, "closed"),
    staleCount: countEntries(entries, "stale"),
    duplicateCount: countEntries(entries, "duplicate"),
    externalRefCount: entries.reduce((total, entry) => total + entry.externalRefs.length, 0),
    unmatchedExternalStatusCount: 0
  };
}

function reconciliationStatus(
  metrics: AdminReviewTicketIdempotencyMetrics,
  errors: readonly string[]
): AdminReviewReconciliationStatus {
  if (errors.length > 0 || metrics.duplicateCount > 0) return "failed";
  if (
    metrics.failedCount > 0 ||
    metrics.staleCount > 0 ||
    metrics.unmatchedExternalStatusCount > 0
  ) {
    return "needs_attention";
  }
  return "passed";
}

function countEntries(
  entries: readonly AdminReviewTicketIdempotencyStoreEntry[],
  status: AdminReviewStoreEntryStatus
): number {
  return entries.filter((entry) => entry.reconciliationStatus === status).length;
}

async function readPreviousStore(): Promise<PreviousStoreReadResult> {
  try {
    const parsed = JSON.parse(
      await readFile(
        /*turbopackIgnore: true*/ artifactAbsolutePath(ARTIFACT_PATHS.idempotencyStoreJson),
        "utf8"
      )
    ) as unknown;
    if (!isIdempotencyStore(parsed)) {
      return { warning: "Previous admin UI idempotency store was invalid and was ignored." };
    }
    return { store: parsed };
  } catch (error) {
    if (isNotFound(error)) return {};
    if (error instanceof SyntaxError) {
      return { warning: "Previous admin UI idempotency store was invalid and was ignored." };
    }
    throw error;
  }
}

async function readJsonArtifact<TSummary>(
  relativePath: string,
  summarize: (value: unknown) => TSummary
): Promise<ReviewSyncArtifactState<TSummary>> {
  const updatedAt = await artifactUpdatedAt(relativePath);
  try {
    const parsed = JSON.parse(
      await readFile(/*turbopackIgnore: true*/ artifactAbsolutePath(relativePath), "utf8")
    ) as unknown;
    return {
      status: "available",
      path: relativePath,
      ...(updatedAt ? { updatedAt } : {}),
      summary: summarize(parsed)
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "missing", path: relativePath };
    }
    return {
      status: "invalid",
      path: relativePath,
      ...(updatedAt ? { updatedAt } : {}),
      error:
        error instanceof Error && error.message.trim()
          ? redactText(error.message).slice(0, 800)
          : "Artifact could not be parsed."
    };
  }
}

async function artifactUpdatedAt(relativePath: string): Promise<string | undefined> {
  try {
    return (
      await stat(/*turbopackIgnore: true*/ artifactAbsolutePath(relativePath))
    ).mtime.toISOString();
  } catch {
    return undefined;
  }
}

async function writeJsonArtifact(relativePath: string, value: unknown): Promise<void> {
  await writeTextArtifact(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextArtifact(relativePath: string, body: string): Promise<void> {
  const target = artifactAbsolutePath(relativePath);
  await mkdir(/*turbopackIgnore: true*/ path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(/*turbopackIgnore: true*/ temporary, body, "utf8");
  await rename(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ target);
}

function summarizeExportArtifact(value: unknown): AdminReviewExportSummary {
  const record = requiredRecord(value, "Admin review export");
  const summary = requiredRecord(record.summary, "Admin review export summary");
  const source = requiredRecord(record.source, "Admin review export source");
  return {
    exportId: optionalString(record.exportId),
    generatedAt: optionalString(record.generatedAt),
    status: optionalString(record.status),
    storageKind: optionalString(source.workflowStorageKind),
    exportedDecisionCount: numberValue(summary.exportedDecisionCount),
    exportedTicketCount: numberValue(summary.exportedTicketCount),
    queueSnapshotCount: numberValue(summary.queueSnapshotCount),
    missingQueueSnapshotCount: numberValue(summary.missingQueueSnapshotCount),
    hasMore: source.hasMore === true
  };
}

function summarizeTicketsArtifact(value: unknown): AdminReviewTicketsSummary {
  if (!Array.isArray(value)) {
    throw new Error("Ticket payload artifact must be an array.");
  }
  return {
    ticketCount: value.length,
    decisionCount: value.filter((ticket) => isRecord(ticket) && ticket.kind === "decision").length,
    operations: uniqueSorted(value.flatMap((ticket) => safeRecordString(ticket, "operation"))),
    statuses: uniqueSorted(value.flatMap((ticket) => safeRecordString(ticket, "status")))
  };
}

function summarizeSyncArtifact(value: unknown): AdminReviewSyncSummary {
  const record = requiredRecord(value, "Review ticket sync report");
  return {
    syncId: optionalString(record.syncId),
    generatedAt: optionalString(record.generatedAt),
    mode: optionalString(record.mode),
    status: optionalString(record.status),
    ticketCount: numberValue(record.ticketCount),
    sinkCount: numberValue(record.sinkCount),
    syncedTicketCount: numberValue(record.syncedTicketCount),
    failedTicketCount: numberValue(record.failedTicketCount),
    skippedTicketCount: numberValue(record.skippedTicketCount),
    warningCount: Array.isArray(record.warnings) ? record.warnings.length : 0,
    errorCount: Array.isArray(record.errors) ? record.errors.length : 0
  };
}

function summarizeReconciliationArtifact(value: unknown): AdminReviewReconciliationSummary {
  const record = requiredRecord(value, "Review ticket reconciliation report");
  const metrics = requiredRecord(record.metrics, "Review ticket reconciliation metrics");
  return {
    reconciliationId: optionalString(record.reconciliationId),
    generatedAt: optionalString(record.generatedAt),
    status: optionalString(record.status),
    storeId: optionalString(record.storeId),
    ticketCount: numberValue(metrics.ticketCount),
    pendingCount: numberValue(metrics.pendingCount),
    skippedCount: numberValue(metrics.skippedCount),
    syncedCount: numberValue(metrics.syncedCount),
    failedCount: numberValue(metrics.failedCount),
    closedCount: numberValue(metrics.closedCount),
    staleCount: numberValue(metrics.staleCount),
    duplicateCount: numberValue(metrics.duplicateCount),
    externalRefCount: numberValue(metrics.externalRefCount),
    unmatchedExternalStatusCount: numberValue(metrics.unmatchedExternalStatusCount),
    warningCount: Array.isArray(record.warnings) ? record.warnings.length : 0,
    errorCount: Array.isArray(record.errors) ? record.errors.length : 0
  };
}

function isIdempotencyStore(value: unknown): value is AdminReviewTicketIdempotencyStore {
  return isRecord(value) && Array.isArray(value.entries) && isRecord(value.metrics);
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function safeRecordString(value: unknown, key: string): readonly string[] {
  if (!isRecord(value)) return [];
  const found = optionalString(value[key]);
  return found ? [found] : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? redactText(value.trim()).slice(0, 500)
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadHash(ticket: AdminReviewTicketPayload): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        payloadId: ticket.payloadId,
        kind: ticket.kind,
        operation: ticket.operation,
        dedupeKey: ticket.dedupeKey,
        title: ticket.title,
        body: ticket.body,
        priority: ticket.priority,
        status: ticket.status,
        source: ticket.source,
        destination: ticket.destination,
        labels: ticket.labels,
        artifactPaths: ticket.artifactPaths,
        metadata: ticket.metadata
      })
    )
    .digest("hex")}`;
}

function renderReviewSyncMarkdown(report: AdminReviewSyncReport): string {
  return [
    "# Admin Review Ticket Sync",
    "",
    `- Sync ID: \`${md(report.syncId)}\``,
    `- Generated: \`${md(report.generatedAt)}\``,
    `- Mode: **${md(report.mode)}**`,
    `- Status: **${md(report.status)}**`,
    "",
    "## Metrics",
    "",
    `- Tickets: ${report.ticketCount}`,
    `- Sinks: ${report.sinkCount}`,
    `- Synced tickets: ${report.syncedTicketCount}`,
    `- Failed tickets: ${report.failedTicketCount}`,
    `- Skipped tickets: ${report.skippedTicketCount}`,
    "",
    "## Sink Results",
    "",
    "| Sink | Kind | Status | Synced | Failed | Skipped |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...report.results.map(
      (result) =>
        `| \`${md(result.sinkId)}\` | ${md(result.kind)} | ${md(result.status)} | ${result.syncedTicketCount} | ${result.failedTicketCount} | ${result.skippedTicketCount} |`
    ),
    "",
    "## Warnings",
    "",
    report.warnings.length === 0
      ? "No warnings."
      : report.warnings.map((entry) => `- ${md(entry)}`).join("\n"),
    "",
    "## Errors",
    "",
    report.errors.length === 0
      ? "No errors."
      : report.errors.map((entry) => `- ${md(entry)}`).join("\n"),
    "",
    "## Evidence Boundary",
    "",
    report.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function renderReviewReconciliationMarkdown(report: AdminReviewReconciliationReport): string {
  return [
    "# Admin Review Ticket Reconciliation",
    "",
    `- Reconciliation ID: \`${md(report.reconciliationId)}\``,
    `- Store ID: \`${md(report.storeId)}\``,
    `- Generated: \`${md(report.generatedAt)}\``,
    `- Status: **${md(report.status)}**`,
    "",
    "## Metrics",
    "",
    `- Tickets: ${report.metrics.ticketCount}`,
    `- Synced: ${report.metrics.syncedCount}`,
    `- Skipped: ${report.metrics.skippedCount}`,
    `- Pending: ${report.metrics.pendingCount}`,
    `- Failed: ${report.metrics.failedCount}`,
    `- Closed: ${report.metrics.closedCount}`,
    `- Stale: ${report.metrics.staleCount}`,
    `- Duplicates: ${report.metrics.duplicateCount}`,
    `- External refs: ${report.metrics.externalRefCount}`,
    `- Unmatched external statuses: ${report.metrics.unmatchedExternalStatusCount}`,
    "",
    "## Warnings",
    "",
    report.warnings.length === 0
      ? "No warnings."
      : report.warnings.map((entry) => `- ${md(entry)}`).join("\n"),
    "",
    "## Errors",
    "",
    report.errors.length === 0
      ? "No errors."
      : report.errors.map((entry) => `- ${md(entry)}`).join("\n"),
    "",
    "## Evidence Boundary",
    "",
    report.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function reviewTicketSyncEvidenceBoundary(): readonly string[] {
  return [
    "Includes queue item ids, decision ids, trace ids, run ids, destinations, labels, artifact paths, priorities, statuses, and safe summaries.",
    "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, and un-hashed reviewer identifiers.",
    "Dry-run mode records idempotency keys without sending ticket payloads to an external sink."
  ];
}

function reviewTicketReconciliationEvidenceBoundary(): readonly string[] {
  return [
    "Includes review ticket payload ids, dedupe keys, safe titles, source ids, artifact paths, payload hashes, and reconciliation status.",
    "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, and un-hashed reviewer identifiers.",
    "The admin UI idempotency store is safe to persist locally for duplicate prevention and external-ticket audit handoff."
  ];
}

function artifactAbsolutePath(relativePath: string): string {
  const configured = process.env.RAG_ADMIN_REPO_ROOT?.trim();
  if (configured) {
    return path.join(/*turbopackIgnore: true*/ configured, relativePath);
  }
  return path.join(/*turbopackIgnore: true*/ resolveRagRepoRoot(), relativePath);
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[redacted]");
}

function md(value: string): string {
  return redactText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\|/gu, "\\|")
    .replace(/`/gu, "\\`");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
