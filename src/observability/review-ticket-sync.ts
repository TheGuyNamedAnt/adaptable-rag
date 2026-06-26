export const REVIEW_TICKET_SYNC_SCHEMA_VERSION = 1;

export type ReviewTicketSyncMode = "dry_run" | "live";
export type ReviewTicketSyncReportStatus = "passed" | "failed";
export type ReviewTicketSyncSinkStatus = "synced" | "failed" | "skipped";
export type ReviewTicketSyncSinkKind = "dry_run" | "webhook" | "custom";
export type ReviewTicketPayloadKind = "queue_item" | "decision" | "feedback";
export type ReviewTicketOperation = "create" | "update" | "comment";
export type ReviewTicketPriority = "low" | "medium" | "high" | "critical";
export type ReviewTicketSyncErrorCode =
  | "auth_error"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_response"
  | "invalid_configuration";

export interface ReviewTicketSourceRef {
  readonly queueId?: string;
  readonly queueItemId?: string;
  readonly ledgerId?: string;
  readonly decisionId?: string;
  readonly feedbackSignalId?: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly traceId?: string;
  readonly runId?: string;
  readonly incidentId?: string;
}

export interface ReviewTicketPayload {
  readonly payloadId: string;
  readonly kind: ReviewTicketPayloadKind;
  readonly operation: ReviewTicketOperation;
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly priority: ReviewTicketPriority;
  readonly status: string;
  readonly source: ReviewTicketSourceRef;
  readonly destination?: string;
  readonly labels: readonly string[];
  readonly artifactPaths: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ReviewTicketSyncAttempt {
  readonly attempt: number;
  readonly status?: number;
  readonly latencyMs: number;
  readonly errorCode?: ReviewTicketSyncErrorCode;
  readonly retryable: boolean;
}

export interface ReviewTicketExternalRef {
  readonly dedupeKey: string;
  readonly externalId: string;
  readonly url?: string;
  readonly status?: string;
  readonly syncedAt?: string;
}

export interface ReviewTicketSyncSinkRequest {
  readonly syncId: string;
  readonly generatedAt: string;
  readonly mode: ReviewTicketSyncMode;
  readonly tickets: readonly ReviewTicketPayload[];
}

export interface ReviewTicketSyncSinkResult {
  readonly sinkId: string;
  readonly kind: ReviewTicketSyncSinkKind;
  readonly status: ReviewTicketSyncSinkStatus;
  readonly mode: ReviewTicketSyncMode;
  readonly syncedTicketCount: number;
  readonly failedTicketCount: number;
  readonly skippedTicketCount: number;
  readonly attempts: readonly ReviewTicketSyncAttempt[];
  readonly dedupeKeys: readonly string[];
  readonly externalIds: readonly string[];
  readonly externalRefs: readonly ReviewTicketExternalRef[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface ReviewTicketSyncSink {
  readonly id: string;
  readonly kind: ReviewTicketSyncSinkKind;
  sync(request: ReviewTicketSyncSinkRequest): Promise<ReviewTicketSyncSinkResult>;
}

export interface SyncReviewTicketsRequest {
  readonly tickets: readonly ReviewTicketPayload[];
  readonly sinks: readonly ReviewTicketSyncSink[];
  readonly mode: ReviewTicketSyncMode;
  readonly generatedAt?: string;
  readonly syncId?: string;
  readonly requireSink?: boolean;
}

export interface ReviewTicketSyncReport {
  readonly schemaVersion: typeof REVIEW_TICKET_SYNC_SCHEMA_VERSION;
  readonly syncId: string;
  readonly generatedAt: string;
  readonly mode: ReviewTicketSyncMode;
  readonly status: ReviewTicketSyncReportStatus;
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
  readonly results: readonly ReviewTicketSyncSinkResult[];
  readonly evidenceBoundary: readonly string[];
}

export interface DryRunReviewTicketSyncSinkOptions {
  readonly id?: string;
  readonly kind?: ReviewTicketSyncSinkKind;
}

export class DryRunReviewTicketSyncSink implements ReviewTicketSyncSink {
  readonly id: string;
  readonly kind: ReviewTicketSyncSinkKind;

  constructor(options: DryRunReviewTicketSyncSinkOptions = {}) {
    this.id = options.id ?? "dry_run";
    this.kind = options.kind ?? "dry_run";
  }

  async sync(request: ReviewTicketSyncSinkRequest): Promise<ReviewTicketSyncSinkResult> {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "skipped",
      mode: request.mode,
      syncedTicketCount: 0,
      failedTicketCount: 0,
      skippedTicketCount: request.tickets.length,
      attempts: [],
      dedupeKeys: request.tickets.map((ticket) => ticket.dedupeKey),
      externalIds: [],
      externalRefs: [],
      warnings:
        request.tickets.length === 0
          ? ["No review tickets were present; dry-run sync skipped."]
          : ["Dry-run mode recorded review tickets without sending them."],
      errors: []
    };
  }
}

export async function syncReviewTickets(
  request: SyncReviewTicketsRequest
): Promise<ReviewTicketSyncReport> {
  const generatedAt = request.generatedAt ?? new Date().toISOString();
  const syncId = request.syncId ?? `review_ticket_sync_${safeTimestamp(generatedAt)}`;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (request.sinks.length === 0 && request.requireSink === true) {
    errors.push("At least one review ticket sync sink is required.");
  }

  const results: ReviewTicketSyncSinkResult[] = [];
  for (const sink of request.sinks) {
    try {
      results.push(
        await sink.sync({
          syncId,
          generatedAt,
          mode: request.mode,
          tickets: request.tickets
        })
      );
    } catch (error) {
      results.push(failedSinkResult(sink, request, error));
    }
  }

  warnings.push(...results.flatMap((result) => result.warnings));
  errors.push(...results.flatMap((result) => result.errors));

  const failedSinkCount = results.filter((result) => result.status === "failed").length;
  return {
    schemaVersion: REVIEW_TICKET_SYNC_SCHEMA_VERSION,
    syncId,
    generatedAt,
    mode: request.mode,
    status: errors.length > 0 || failedSinkCount > 0 ? "failed" : "passed",
    ticketCount: request.tickets.length,
    sinkCount: request.sinks.length,
    syncedSinkCount: results.filter((result) => result.status === "synced").length,
    failedSinkCount,
    skippedSinkCount: results.filter((result) => result.status === "skipped").length,
    syncedTicketCount: sum(results.map((result) => result.syncedTicketCount)),
    failedTicketCount: sum(results.map((result) => result.failedTicketCount)),
    skippedTicketCount: sum(results.map((result) => result.skippedTicketCount)),
    warnings: uniqueSorted(warnings),
    errors: uniqueSorted(errors),
    results,
    evidenceBoundary: reviewTicketSyncEvidenceBoundary()
  };
}

export function reviewTicketDedupeKey(input: {
  readonly kind: ReviewTicketPayloadKind;
  readonly operation: ReviewTicketOperation;
  readonly source: ReviewTicketSourceRef;
}): string {
  return [
    "rag_review_ticket",
    input.kind,
    input.operation,
    input.source.queueItemId,
    input.source.decisionId,
    input.source.feedbackSignalId,
    input.source.traceId,
    input.source.incidentId
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(safeKeyPart)
    .join(":");
}

export function renderReviewTicketSyncMarkdown(report: ReviewTicketSyncReport): string {
  return [
    "# Review Ticket Sync",
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
    sinkTable(report.results),
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

export function reviewTicketSyncEvidenceBoundary(): readonly string[] {
  return [
    "Includes queue item ids, decision ids, feedback signal ids, trace ids, run ids, incident ids, profile ids, namespace ids, destinations, labels, artifact paths, priorities, statuses, and safe summaries.",
    "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, and un-hashed reviewer identifiers.",
    "External sinks receive idempotency keys so retries or repeated CI runs can upsert or de-duplicate without parsing unsafe evidence."
  ];
}

function failedSinkResult(
  sink: ReviewTicketSyncSink,
  request: SyncReviewTicketsRequest,
  error: unknown
): ReviewTicketSyncSinkResult {
  return {
    sinkId: sink.id,
    kind: sink.kind,
    status: "failed",
    mode: request.mode,
    syncedTicketCount: 0,
    failedTicketCount: request.tickets.length,
    skippedTicketCount: 0,
    attempts: [],
    dedupeKeys: request.tickets.map((ticket) => ticket.dedupeKey),
    externalIds: [],
    externalRefs: [],
    warnings: [],
    errors: [error instanceof Error ? error.message : "Review ticket sync sink failed."]
  };
}

function sinkTable(results: readonly ReviewTicketSyncSinkResult[]): string {
  if (results.length === 0) {
    return "No sinks were configured.";
  }

  return [
    "| Sink | Kind | Status | Synced | Failed | Skipped |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...results.map(
      (result) =>
        `| \`${md(result.sinkId)}\` | ${md(result.kind)} | ${md(result.status)} | ${result.syncedTicketCount} | ${result.failedTicketCount} | ${result.skippedTicketCount} |`
    )
  ].join("\n");
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function safeKeyPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^0-9a-z._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "unknown";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
