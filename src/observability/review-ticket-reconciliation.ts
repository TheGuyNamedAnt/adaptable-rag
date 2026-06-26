import { createHash } from "node:crypto";

import type {
  ReviewTicketExternalRef,
  ReviewTicketPayload,
  ReviewTicketSyncReport,
  ReviewTicketSyncSinkResult
} from "./review-ticket-sync.js";

export const REVIEW_TICKET_RECONCILIATION_SCHEMA_VERSION = 1;
const DEFAULT_REDACTION = "[REDACTED]";
const MAX_EXTERNAL_STATUS_TEXT_LENGTH = 500;

export type ReviewTicketReconciliationStatus = "passed" | "needs_attention" | "failed";
export type ReviewTicketStoreEntryStatus =
  | "pending"
  | "skipped"
  | "synced"
  | "failed"
  | "closed"
  | "stale"
  | "duplicate";

export interface ReviewTicketExternalStatusSnapshot {
  readonly dedupeKey?: string;
  readonly externalId?: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly url?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ReviewTicketIdempotencyStoreEntry {
  readonly dedupeKey: string;
  readonly payloadId: string;
  readonly kind: ReviewTicketPayload["kind"];
  readonly operation: ReviewTicketPayload["operation"];
  readonly title: string;
  readonly priority: ReviewTicketPayload["priority"];
  readonly ticketStatus: string;
  readonly reconciliationStatus: ReviewTicketStoreEntryStatus;
  readonly source: ReviewTicketPayload["source"];
  readonly destination?: string;
  readonly labels: readonly string[];
  readonly artifactPaths: readonly string[];
  readonly payloadHash: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastSyncedAt?: string;
  readonly externalRefs: readonly ReviewTicketExternalRef[];
  readonly externalStatus?: ReviewTicketExternalStatusSnapshot;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface ReviewTicketIdempotencyStoreMetrics {
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

export interface ReviewTicketIdempotencyStore {
  readonly schemaVersion: typeof REVIEW_TICKET_RECONCILIATION_SCHEMA_VERSION;
  readonly storeId: string;
  readonly generatedAt: string;
  readonly entries: readonly ReviewTicketIdempotencyStoreEntry[];
  readonly metrics: ReviewTicketIdempotencyStoreMetrics;
  readonly evidenceBoundary: readonly string[];
}

export interface ReviewTicketReconciliationReport {
  readonly schemaVersion: typeof REVIEW_TICKET_RECONCILIATION_SCHEMA_VERSION;
  readonly reconciliationId: string;
  readonly generatedAt: string;
  readonly status: ReviewTicketReconciliationStatus;
  readonly storeId: string;
  readonly syncId?: string;
  readonly metrics: ReviewTicketIdempotencyStoreMetrics;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly unmatchedExternalStatuses: readonly ReviewTicketExternalStatusSnapshot[];
  readonly evidenceBoundary: readonly string[];
}

export interface ReviewTicketReconciliationInput {
  readonly reconciliationId?: string;
  readonly storeId?: string;
  readonly generatedAt?: string;
  readonly tickets: readonly ReviewTicketPayload[];
  readonly syncReport?: ReviewTicketSyncReport;
  readonly previousStore?: ReviewTicketIdempotencyStore;
  readonly externalStatuses?: readonly ReviewTicketExternalStatusSnapshot[];
  readonly staleAfterHours?: number;
}

export interface ReviewTicketReconciliationResult {
  readonly store: ReviewTicketIdempotencyStore;
  readonly report: ReviewTicketReconciliationReport;
}

interface SyncEvidence {
  readonly status: ReviewTicketSyncSinkResult["status"] | "none";
  readonly externalRefs: readonly ReviewTicketExternalRef[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export function reconcileReviewTickets(
  input: ReviewTicketReconciliationInput
): ReviewTicketReconciliationResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const storeId = input.storeId ?? `review_ticket_store_${safeTimestamp(generatedAt)}`;
  const reconciliationId =
    input.reconciliationId ?? `review_ticket_reconciliation_${safeTimestamp(generatedAt)}`;
  const staleAfterHours = input.staleAfterHours ?? 168;
  const previousByDedupeKey = new Map(
    (input.previousStore?.entries ?? []).map((entry) => [entry.dedupeKey, entry])
  );
  const ticketsByDedupeKey = groupTickets(input.tickets);
  const syncByDedupeKey = syncEvidenceByDedupeKey(input.syncReport);
  const externalStatuses = (input.externalStatuses ?? []).flatMap((status) =>
    safeExternalStatusSnapshot(status)
  );

  const entries = [...ticketsByDedupeKey.entries()].map(([dedupeKey, tickets]) => {
    const ticket = tickets[0];
    if (!ticket) {
      throw new Error(`Review ticket group ${dedupeKey} did not contain a payload.`);
    }
    const previous = previousByDedupeKey.get(dedupeKey);
    const syncEvidence = syncByDedupeKey.get(dedupeKey) ?? emptySyncEvidence();
    const externalRefs = mergeExternalRefs([
      ...(previous?.externalRefs ?? []),
      ...syncEvidence.externalRefs,
      ...externalStatuses.flatMap((status) => refFromStatus(status, dedupeKey))
    ]);
    const externalStatus = matchingExternalStatus(externalStatuses, dedupeKey, externalRefs);
    const duplicate = tickets.length > 1;
    const status = entryStatus({
      duplicate,
      syncEvidence,
      externalStatus,
      generatedAt,
      staleAfterHours
    });
    const errors = [
      ...(duplicate ? [`Duplicate review ticket payloads share dedupe key ${dedupeKey}.`] : []),
      ...syncEvidence.errors
    ];
    const warnings = [
      ...syncEvidence.warnings,
      ...(syncEvidence.status === "synced" && externalRefs.length === 0
        ? ["Sync reported success but returned no external ticket reference."]
        : [])
    ];

    return storeEntry({
      ticket,
      previous,
      generatedAt,
      status,
      externalRefs,
      externalStatus,
      warnings,
      errors,
      syncReport: input.syncReport
    });
  });

  const unmatchedExternalStatuses = externalStatuses.filter(
    (status) =>
      !entries.some(
        (entry) =>
          status.dedupeKey === entry.dedupeKey ||
          (status.externalId !== undefined &&
            entry.externalRefs.some((ref) => ref.externalId === status.externalId))
      )
  );
  const metrics = storeMetrics(entries, unmatchedExternalStatuses);
  const warnings = uniqueSorted([
    ...entries.flatMap((entry) => entry.warnings),
    ...unmatchedExternalStatuses.map((status) =>
      status.externalId
        ? `External status ${status.externalId} did not match a review ticket.`
        : "External status without a matching review ticket was ignored."
    )
  ]);
  const errors = uniqueSorted(entries.flatMap((entry) => entry.errors));
  const evidenceBoundary = reviewTicketReconciliationEvidenceBoundary();
  const store: ReviewTicketIdempotencyStore = {
    schemaVersion: REVIEW_TICKET_RECONCILIATION_SCHEMA_VERSION,
    storeId,
    generatedAt,
    entries,
    metrics,
    evidenceBoundary
  };
  const report: ReviewTicketReconciliationReport = {
    schemaVersion: REVIEW_TICKET_RECONCILIATION_SCHEMA_VERSION,
    reconciliationId,
    generatedAt,
    status: reportStatus(metrics, errors),
    storeId,
    ...(input.syncReport === undefined ? {} : { syncId: input.syncReport.syncId }),
    metrics,
    warnings,
    errors,
    unmatchedExternalStatuses,
    evidenceBoundary
  };

  return { store, report };
}

export function renderReviewTicketReconciliationMarkdown(
  report: ReviewTicketReconciliationReport
): string {
  return [
    "# Review Ticket Reconciliation",
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

export function reviewTicketReconciliationEvidenceBoundary(): readonly string[] {
  return [
    "Includes review ticket payload ids, dedupe keys, external ticket ids, external ticket statuses, safe titles, source ids, artifact paths, and reconciliation status.",
    "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, and un-hashed reviewer identifiers.",
    "The idempotency store is safe to persist locally and use for duplicate prevention, status reconciliation, stale-ticket detection, and external-ticket audit trails."
  ];
}

function storeEntry(input: {
  readonly ticket: ReviewTicketPayload;
  readonly previous: ReviewTicketIdempotencyStoreEntry | undefined;
  readonly generatedAt: string;
  readonly status: ReviewTicketStoreEntryStatus;
  readonly externalRefs: readonly ReviewTicketExternalRef[];
  readonly externalStatus: ReviewTicketExternalStatusSnapshot | undefined;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly syncReport: ReviewTicketSyncReport | undefined;
}): ReviewTicketIdempotencyStoreEntry {
  return {
    dedupeKey: input.ticket.dedupeKey,
    payloadId: input.ticket.payloadId,
    kind: input.ticket.kind,
    operation: input.ticket.operation,
    title: input.ticket.title,
    priority: input.ticket.priority,
    ticketStatus: input.ticket.status,
    reconciliationStatus: input.status,
    source: input.ticket.source,
    ...(input.ticket.destination === undefined ? {} : { destination: input.ticket.destination }),
    labels: input.ticket.labels,
    artifactPaths: input.ticket.artifactPaths,
    payloadHash: payloadHash(input.ticket),
    firstSeenAt: input.previous?.firstSeenAt ?? input.generatedAt,
    lastSeenAt: input.generatedAt,
    ...(input.syncReport?.mode === "live" && input.status === "synced"
      ? { lastSyncedAt: input.syncReport.generatedAt }
      : input.previous?.lastSyncedAt === undefined
        ? {}
        : { lastSyncedAt: input.previous.lastSyncedAt }),
    externalRefs: input.externalRefs,
    ...(input.externalStatus === undefined ? {} : { externalStatus: input.externalStatus }),
    warnings: uniqueSorted(input.warnings),
    errors: uniqueSorted(input.errors)
  };
}

function entryStatus(input: {
  readonly duplicate: boolean;
  readonly syncEvidence: SyncEvidence;
  readonly externalStatus: ReviewTicketExternalStatusSnapshot | undefined;
  readonly generatedAt: string;
  readonly staleAfterHours: number;
}): ReviewTicketStoreEntryStatus {
  if (input.duplicate) {
    return "duplicate";
  }

  if (input.externalStatus && isClosedStatus(input.externalStatus.status)) {
    return "closed";
  }

  if (
    input.externalStatus?.updatedAt &&
    isStale(input.externalStatus.updatedAt, input.generatedAt, input.staleAfterHours)
  ) {
    return "stale";
  }

  switch (input.syncEvidence.status) {
    case "failed":
      return "failed";
    case "synced":
      return "synced";
    case "skipped":
      return "skipped";
    case "none":
      return "pending";
  }
}

function groupTickets(
  tickets: readonly ReviewTicketPayload[]
): Map<string, readonly ReviewTicketPayload[]> {
  const grouped = new Map<string, ReviewTicketPayload[]>();
  for (const ticket of tickets) {
    const existing = grouped.get(ticket.dedupeKey) ?? [];
    existing.push(ticket);
    grouped.set(ticket.dedupeKey, existing);
  }
  return grouped;
}

function syncEvidenceByDedupeKey(
  report: ReviewTicketSyncReport | undefined
): Map<string, SyncEvidence> {
  const byDedupeKey = new Map<string, SyncEvidence>();
  if (!report) {
    return byDedupeKey;
  }

  for (const result of report.results) {
    for (const dedupeKey of result.dedupeKeys) {
      const existing = byDedupeKey.get(dedupeKey) ?? emptySyncEvidence();
      byDedupeKey.set(dedupeKey, {
        status: strongestSyncStatus(existing.status, result.status),
        externalRefs: mergeExternalRefs([
          ...existing.externalRefs,
          ...safeExternalRefsForResult(result, dedupeKey)
        ]),
        warnings: uniqueSorted([...existing.warnings, ...result.warnings]),
        errors: uniqueSorted([...existing.errors, ...result.errors])
      });
    }
  }

  return byDedupeKey;
}

function strongestSyncStatus(
  first: SyncEvidence["status"],
  second: ReviewTicketSyncSinkResult["status"]
): SyncEvidence["status"] {
  if (first === "failed" || second === "failed") {
    return "failed";
  }
  if (first === "synced" || second === "synced") {
    return "synced";
  }
  return "skipped";
}

function emptySyncEvidence(): SyncEvidence {
  return {
    status: "none",
    externalRefs: [],
    warnings: [],
    errors: []
  };
}

function matchingExternalStatus(
  statuses: readonly ReviewTicketExternalStatusSnapshot[],
  dedupeKey: string,
  externalRefs: readonly ReviewTicketExternalRef[]
): ReviewTicketExternalStatusSnapshot | undefined {
  return statuses.find(
    (status) =>
      status.dedupeKey === dedupeKey ||
      (status.externalId !== undefined &&
        externalRefs.some((ref) => ref.externalId === status.externalId))
  );
}

function refFromStatus(
  status: ReviewTicketExternalStatusSnapshot,
  dedupeKey: string
): readonly ReviewTicketExternalRef[] {
  if (status.dedupeKey !== dedupeKey || !status.externalId) {
    return [];
  }

  return [
    {
      dedupeKey,
      externalId: status.externalId,
      ...(status.url === undefined ? {} : { url: status.url }),
      status: status.status,
      ...(status.updatedAt === undefined ? {} : { syncedAt: status.updatedAt })
    }
  ];
}

function mergeExternalRefs(
  refs: readonly ReviewTicketExternalRef[]
): readonly ReviewTicketExternalRef[] {
  const byKey = new Map<string, ReviewTicketExternalRef>();
  for (const ref of refs) {
    byKey.set(`${ref.dedupeKey}:${ref.externalId}`, ref);
  }
  return [...byKey.values()];
}

function safeExternalRefsForResult(
  result: ReviewTicketSyncSinkResult,
  dedupeKey: string
): readonly ReviewTicketExternalRef[] {
  const refs = (result as { readonly externalRefs?: unknown }).externalRefs;
  if (Array.isArray(refs)) {
    return refs.flatMap((ref) => safeExternalRef(ref, dedupeKey));
  }

  const ids = (result as { readonly externalIds?: unknown }).externalIds;
  if (Array.isArray(ids)) {
    return ids.flatMap((externalId) => safeExternalRef({ dedupeKey, externalId }, dedupeKey));
  }

  return [];
}

function safeExternalRef(
  value: unknown,
  fallbackDedupeKey: string
): readonly ReviewTicketExternalRef[] {
  if (!isRecord(value)) {
    return [];
  }

  const dedupeKey = safeOperationalString(value.dedupeKey) ?? fallbackDedupeKey;
  if (dedupeKey !== fallbackDedupeKey) {
    return [];
  }

  const externalId = safeOperationalString(value.externalId);
  if (externalId === undefined) {
    return [];
  }

  const url = safeUrl(value.url);
  const status = safeOperationalString(value.status);
  const syncedAt = safeOperationalString(value.syncedAt);
  return [
    {
      dedupeKey,
      externalId,
      ...(url === undefined ? {} : { url }),
      ...(status === undefined ? {} : { status }),
      ...(syncedAt === undefined ? {} : { syncedAt })
    }
  ];
}

function safeExternalStatusSnapshot(value: unknown): readonly ReviewTicketExternalStatusSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }

  const status = safeOperationalString(value.status);
  if (status === undefined) {
    return [];
  }

  const dedupeKey = safeOperationalString(value.dedupeKey);
  const externalId = safeOperationalString(value.externalId);
  const updatedAt = safeOperationalString(value.updatedAt);
  const url = safeUrl(value.url);
  const metadata = safeMetadata(value.metadata);
  return [
    {
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
      ...(externalId === undefined ? {} : { externalId }),
      status,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(url === undefined ? {} : { url }),
      ...(metadata === undefined ? {} : { metadata })
    }
  ];
}

function safeMetadata(
  value: unknown
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const safeKey = safeOperationalString(key);
    if (safeKey === undefined) {
      continue;
    }
    if (typeof rawValue === "string") {
      metadata[safeKey] = redactOperationalText(rawValue);
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      metadata[safeKey] = rawValue;
    } else if (typeof rawValue === "boolean" || rawValue === null) {
      metadata[safeKey] = rawValue;
    }
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function safeOperationalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const redacted = redactOperationalText(value.trim());
  return redacted.length === 0 ? undefined : redacted;
}

function safeUrl(value: unknown): string | undefined {
  const safe = safeOperationalString(value);
  if (safe === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(safe);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }

  return safe;
}

function redactOperationalText(value: string): string {
  return value
    .slice(0, MAX_EXTERNAL_STATUS_TEXT_LENGTH)
    .replace(/bearer\s+[a-z0-9._~+/=-]+/giu, `Bearer ${DEFAULT_REDACTION}`)
    .replace(/api[_-]?key\s*[:=]\s*\S+/giu, `api_key=${DEFAULT_REDACTION}`)
    .replace(/password\s*[:=]\s*\S+/giu, `password=${DEFAULT_REDACTION}`)
    .replace(
      /([?&](?:api[_-]?key|token|password|secret|signature|sig)=)[^&#\s]+/giu,
      `$1${DEFAULT_REDACTION}`
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storeMetrics(
  entries: readonly ReviewTicketIdempotencyStoreEntry[],
  unmatchedExternalStatuses: readonly ReviewTicketExternalStatusSnapshot[]
): ReviewTicketIdempotencyStoreMetrics {
  return {
    ticketCount: entries.length,
    pendingCount: count(entries, "pending"),
    skippedCount: count(entries, "skipped"),
    syncedCount: count(entries, "synced"),
    failedCount: count(entries, "failed"),
    closedCount: count(entries, "closed"),
    staleCount: count(entries, "stale"),
    duplicateCount: count(entries, "duplicate"),
    externalRefCount: entries.reduce((total, entry) => total + entry.externalRefs.length, 0),
    unmatchedExternalStatusCount: unmatchedExternalStatuses.length
  };
}

function reportStatus(
  metrics: ReviewTicketIdempotencyStoreMetrics,
  errors: readonly string[]
): ReviewTicketReconciliationStatus {
  if (errors.length > 0 || metrics.duplicateCount > 0) {
    return "failed";
  }
  if (
    metrics.failedCount > 0 ||
    metrics.staleCount > 0 ||
    metrics.unmatchedExternalStatusCount > 0
  ) {
    return "needs_attention";
  }
  return "passed";
}

function count(
  entries: readonly ReviewTicketIdempotencyStoreEntry[],
  status: ReviewTicketStoreEntryStatus
): number {
  return entries.filter((entry) => entry.reconciliationStatus === status).length;
}

function isClosedStatus(status: string): boolean {
  return ["closed", "done", "resolved", "complete", "completed"].includes(status.toLowerCase());
}

function isStale(updatedAt: string, generatedAt: string, staleAfterHours: number): boolean {
  const updated = Date.parse(updatedAt);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(updated) || !Number.isFinite(generated)) {
    return false;
  }
  return generated - updated > staleAfterHours * 60 * 60 * 1000;
}

function payloadHash(ticket: ReviewTicketPayload): string {
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

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function md(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\|/gu, "\\|");
}
