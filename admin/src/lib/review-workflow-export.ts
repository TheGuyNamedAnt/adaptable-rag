import "server-only";

import { createHash } from "node:crypto";
import { getReviewQueue, type ReviewQueueItem, type ReviewQueuePriority } from "@/lib/review-queue";
import {
  getReviewWorkflowStorageKind,
  listReviewWorkflowHistory,
  type ReviewWorkflowHistoryQuery,
  type ReviewWorkflowHistorySummary
} from "@/lib/review-workflow-store";
import type { ReviewWorkflowState, ReviewWorkflowStatus } from "@/lib/review-workflow-types";

export const ADMIN_REVIEW_WORKFLOW_EXPORT_SCHEMA_VERSION = 1;

export type AdminReviewWorkflowAction =
  | "reopen"
  | "acknowledge"
  | "start_review"
  | "resolve"
  | "dismiss";
export type AdminReviewTicketPayloadKind = "decision";
export type AdminReviewTicketOperation = "comment" | "update";
export type AdminReviewTicketPriority = "low" | "medium" | "high" | "critical";

export interface AdminReviewWorkflowExportQuery extends ReviewWorkflowHistoryQuery {
  readonly exportId?: string;
  readonly generatedAt?: string;
}

export interface AdminReviewWorkflowExport {
  readonly schemaVersion: typeof ADMIN_REVIEW_WORKFLOW_EXPORT_SCHEMA_VERSION;
  readonly exportId: string;
  readonly generatedAt: string;
  readonly status: "empty" | "ready";
  readonly source: {
    readonly queueGeneratedAt: string;
    readonly queueStatus: string;
    readonly workflowStorageKind: string;
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    readonly filters: {
      readonly status?: ReviewWorkflowStatus;
      readonly ownerHash?: string;
    };
  };
  readonly summary: AdminReviewWorkflowExportSummary;
  readonly queueItems: readonly AdminReviewWorkflowQueueSnapshot[];
  readonly decisions: readonly AdminReviewWorkflowDecision[];
  readonly tickets: readonly AdminReviewTicketPayload[];
  readonly evidenceBoundary: readonly string[];
}

export interface AdminReviewWorkflowExportSummary extends ReviewWorkflowHistorySummary {
  readonly exportedDecisionCount: number;
  readonly exportedTicketCount: number;
  readonly queueSnapshotCount: number;
  readonly missingQueueSnapshotCount: number;
}

export interface AdminReviewWorkflowQueueSnapshot {
  readonly itemId: string;
  readonly kind: string;
  readonly priority: ReviewQueuePriority;
  readonly sourceStatus: string;
  readonly reviewStatus: ReviewWorkflowStatus;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly actionLabel: string;
  readonly occurredAt?: string;
  readonly primaryId?: string;
  readonly secondaryId?: string;
  readonly scope: readonly AdminReviewWorkflowFact[];
  readonly signals: readonly AdminReviewWorkflowFact[];
}

export interface AdminReviewWorkflowFact {
  readonly label: string;
  readonly value: string;
}

export interface AdminReviewWorkflowDecision {
  readonly decisionId: string;
  readonly queueItemId: string;
  readonly action: AdminReviewWorkflowAction;
  readonly workflowStatus: ReviewWorkflowStatus;
  readonly decidedAt: string;
  readonly reviewerIdHash: string;
  readonly ownerHash?: string;
  readonly summary: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedByHash?: string;
  readonly queueItem?: AdminReviewWorkflowQueueSnapshot;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdminReviewTicketSourceRef {
  readonly queueId: string;
  readonly queueItemId: string;
  readonly decisionId: string;
  readonly runId?: string;
  readonly traceId?: string;
}

export interface AdminReviewTicketPayload {
  readonly payloadId: string;
  readonly kind: AdminReviewTicketPayloadKind;
  readonly operation: AdminReviewTicketOperation;
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  readonly priority: AdminReviewTicketPriority;
  readonly status: string;
  readonly source: AdminReviewTicketSourceRef;
  readonly destination?: string;
  readonly labels: readonly string[];
  readonly artifactPaths: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export async function buildAdminReviewWorkflowExport(
  query: AdminReviewWorkflowExportQuery = {}
): Promise<AdminReviewWorkflowExport> {
  const generatedAt = query.generatedAt ?? new Date().toISOString();
  const exportId = query.exportId ?? `admin_review_workflow_${safeTimestamp(generatedAt)}`;
  const [queue, history] = await Promise.all([getReviewQueue(), listReviewWorkflowHistory(query)]);
  const queueSnapshots = new Map(queue.items.map((item) => [item.id, snapshotQueueItem(item)]));
  const decisions = history.states.map((state) =>
    decisionFromWorkflowState(state, queueSnapshots.get(state.itemId), generatedAt)
  );
  const queueItems = [...queueSnapshots.values()].sort((left, right) =>
    left.itemId.localeCompare(right.itemId)
  );
  const tickets = decisions.map((decision) => ticketForDecision(exportId, decision));
  const missingQueueSnapshotCount = decisions.filter((decision) => !decision.queueItem).length;

  return {
    schemaVersion: ADMIN_REVIEW_WORKFLOW_EXPORT_SCHEMA_VERSION,
    exportId,
    generatedAt,
    status: decisions.length === 0 && queueItems.length === 0 ? "empty" : "ready",
    source: {
      queueGeneratedAt: queue.generatedAt,
      queueStatus: queue.status,
      workflowStorageKind: getReviewWorkflowStorageKind(),
      limit: history.page.limit,
      offset: history.page.offset,
      hasMore: history.page.hasMore,
      filters: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.owner ? { ownerHash: hashIdentity(query.owner) } : {})
      }
    },
    summary: {
      ...history.summary,
      exportedDecisionCount: decisions.length,
      exportedTicketCount: tickets.length,
      queueSnapshotCount: queueItems.length,
      missingQueueSnapshotCount
    },
    queueItems,
    decisions,
    tickets,
    evidenceBoundary: [
      "Includes admin review queue item ids, operational statuses, owner/reviewer hashes, bounded operator notes, safe queue facts, counts, timestamps, and generic ticket payloads.",
      "Excludes document bodies, raw prompts, generated answer text, provider payloads, credentials, full principal claims, raw connector content, and raw reviewer identifiers.",
      "Closed review rows may not have a current queue snapshot because the open queue intentionally hides resolved and dismissed items; the stable queue item id remains the join key."
    ]
  };
}

export function renderAdminReviewWorkflowExportMarkdown(
  artifact: AdminReviewWorkflowExport
): string {
  return [
    "# Admin Review Workflow Export",
    "",
    `- Export ID: \`${md(artifact.exportId)}\``,
    `- Generated: \`${md(artifact.generatedAt)}\``,
    `- Status: **${md(artifact.status)}**`,
    `- Workflow storage: \`${md(artifact.source.workflowStorageKind)}\``,
    "",
    "## Summary",
    "",
    `- Decisions: ${artifact.summary.exportedDecisionCount}`,
    `- Tickets: ${artifact.summary.exportedTicketCount}`,
    `- Queue snapshots: ${artifact.summary.queueSnapshotCount}`,
    `- Missing queue snapshots: ${artifact.summary.missingQueueSnapshotCount}`,
    `- Total workflow records: ${artifact.summary.totalCount}`,
    `- Filtered workflow records: ${artifact.summary.filteredCount}`,
    `- Open: ${artifact.summary.openCount}`,
    `- Acknowledged: ${artifact.summary.acknowledgedCount}`,
    `- In review: ${artifact.summary.inReviewCount}`,
    `- Resolved: ${artifact.summary.resolvedCount}`,
    `- Dismissed: ${artifact.summary.dismissedCount}`,
    "",
    "## Decisions",
    "",
    decisionTable(artifact.decisions),
    "",
    "## Ticket Payloads",
    "",
    ticketTable(artifact.tickets),
    "",
    "## Evidence Boundary",
    "",
    artifact.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function snapshotQueueItem(item: ReviewQueueItem): AdminReviewWorkflowQueueSnapshot {
  return {
    itemId: safeText(item.id),
    kind: safeText(item.kind),
    priority: item.priority,
    sourceStatus: safeText(item.status),
    reviewStatus: item.reviewStatus ?? "open",
    title: safeText(item.title),
    detail: safeText(item.detail),
    href: safeText(item.href),
    actionLabel: safeText(item.actionLabel),
    ...(item.occurredAt ? { occurredAt: safeText(item.occurredAt) } : {}),
    ...(item.primaryId ? { primaryId: safeText(item.primaryId) } : {}),
    ...(item.secondaryId ? { secondaryId: safeText(item.secondaryId) } : {}),
    scope: item.scope.map((fact) => ({ label: safeText(fact.label), value: safeText(fact.value) })),
    signals: item.signals.map((fact) => ({
      label: safeText(fact.label),
      value: safeText(fact.value)
    }))
  };
}

function decisionFromWorkflowState(
  state: ReviewWorkflowState,
  queueItem: AdminReviewWorkflowQueueSnapshot | undefined,
  generatedAt: string
): AdminReviewWorkflowDecision {
  const action = actionForStatus(state.status);
  const summary = safeText(
    state.note ??
      `Admin review workflow marked ${state.itemId} as ${state.status.replace("_", " ")}.`
  );
  return {
    decisionId: `admin_review_decision_${safeId(state.itemId)}_${safeTimestamp(state.updatedAt)}`,
    queueItemId: safeText(state.itemId),
    action,
    workflowStatus: state.status,
    decidedAt: safeText(state.updatedAt || generatedAt),
    reviewerIdHash: hashIdentity(state.updatedBy),
    ...(state.owner ? { ownerHash: hashIdentity(state.owner) } : {}),
    summary,
    ...(state.acknowledgedAt ? { acknowledgedAt: safeText(state.acknowledgedAt) } : {}),
    ...(state.acknowledgedBy ? { acknowledgedByHash: hashIdentity(state.acknowledgedBy) } : {}),
    ...(queueItem ? { queueItem } : {}),
    metadata: {
      source: "admin_review_workflow",
      workflowStatus: state.status,
      action,
      hasQueueSnapshot: queueItem !== undefined
    }
  };
}

function ticketForDecision(
  exportId: string,
  decision: AdminReviewWorkflowDecision
): AdminReviewTicketPayload {
  const source = sourceForDecision(decision);
  const kind = "decision";
  const operation: AdminReviewTicketOperation =
    decision.workflowStatus === "open" ? "update" : "comment";
  return {
    payloadId: `admin_review_ticket_${safeId(decision.decisionId)}`,
    kind,
    operation,
    dedupeKey: reviewTicketDedupeKey({ kind, operation, source }),
    title: safeText(`[RAG Admin Review] ${decision.action}: ${decision.queueItemId}`),
    body: decisionTicketBody(decision),
    priority: priority(decision.queueItem?.priority),
    status: decision.workflowStatus,
    source,
    labels: labels([
      "rag",
      "admin-review",
      decision.action,
      decision.workflowStatus,
      decision.queueItem?.kind
    ]),
    artifactPaths: [".rag/admin-review-export/latest/export.json"],
    metadata: {
      exportId: safeText(exportId),
      reviewerIdHash: decision.reviewerIdHash,
      ...(decision.ownerHash ? { ownerHash: decision.ownerHash } : {}),
      hasQueueSnapshot: decision.queueItem !== undefined
    }
  };
}

function sourceForDecision(decision: AdminReviewWorkflowDecision): AdminReviewTicketSourceRef {
  return {
    queueId: "admin_review_queue",
    queueItemId: decision.queueItemId,
    decisionId: decision.decisionId,
    ...(decision.queueItem?.primaryId === undefined ? {} : { runId: decision.queueItem.primaryId }),
    ...(decision.queueItem?.secondaryId === undefined
      ? {}
      : { traceId: decision.queueItem.secondaryId })
  };
}

function decisionTicketBody(decision: AdminReviewWorkflowDecision): string {
  return safeText(
    [
      decision.summary,
      "",
      `Action: ${decision.action}`,
      `Workflow status: ${decision.workflowStatus}`,
      `Decided at: ${decision.decidedAt}`,
      `Reviewer hash: ${decision.reviewerIdHash}`,
      `Owner hash: ${decision.ownerHash ?? "none"}`,
      `Queue snapshot: ${decision.queueItem ? "available" : "missing"}`,
      `Queue title: ${decision.queueItem?.title ?? "n/a"}`,
      `Queue detail: ${decision.queueItem?.detail ?? "n/a"}`
    ].join("\n")
  );
}

function actionForStatus(status: ReviewWorkflowStatus): AdminReviewWorkflowAction {
  switch (status) {
    case "open":
      return "reopen";
    case "acknowledged":
      return "acknowledge";
    case "in_review":
      return "start_review";
    case "resolved":
      return "resolve";
    case "dismissed":
      return "dismiss";
  }
}

function priority(value: ReviewQueuePriority | undefined): AdminReviewTicketPriority {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function labels(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.flatMap((value) => (value ? [safeLabel(value)] : [])))];
}

function reviewTicketDedupeKey(input: {
  readonly kind: AdminReviewTicketPayloadKind;
  readonly operation: AdminReviewTicketOperation;
  readonly source: AdminReviewTicketSourceRef;
}): string {
  return [
    "rag_review_ticket",
    input.kind,
    input.operation,
    input.source.queueItemId,
    input.source.decisionId,
    input.source.traceId
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(safeLabel)
    .join(":");
}

function hashIdentity(value: string): string {
  return `reviewer_${createHash("sha256").update(`reviewer:${value}`).digest("hex").slice(0, 16)}`;
}

function safeText(value: string): string {
  return redactOperationalText(value).replace(/\s+/gu, " ").trim().slice(0, 1000);
}

function safeLabel(value: string): string {
  const safe = safeText(value)
    .toLowerCase()
    .replace(/[^0-9a-z._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe.length === 0 ? "unknown" : safe;
}

function safeId(value: string): string {
  const safe = safeText(value).replace(/[^0-9a-z_.:-]+/giu, "_");
  return safe.length === 0 ? "unknown" : safe;
}

function safeTimestamp(value: string): string {
  return safeId(value).replace(/[^0-9a-z]+/giu, "");
}

function redactOperationalText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[redacted]");
}

function decisionTable(decisions: readonly AdminReviewWorkflowDecision[]): string {
  if (decisions.length === 0) return "No admin review workflow decisions.";
  return [
    "| Decision | Item | Action | Status | Reviewer | Snapshot |",
    "| --- | --- | --- | --- | --- | --- |",
    ...decisions.map(
      (decision) =>
        `| \`${md(decision.decisionId)}\` | \`${md(decision.queueItemId)}\` | ${md(decision.action)} | ${md(decision.workflowStatus)} | \`${md(decision.reviewerIdHash)}\` | ${decision.queueItem ? "yes" : "no"} |`
    )
  ].join("\n");
}

function ticketTable(tickets: readonly AdminReviewTicketPayload[]): string {
  if (tickets.length === 0) return "No admin review ticket payloads.";
  return [
    "| Payload | Operation | Status | Dedupe key |",
    "| --- | --- | --- | --- |",
    ...tickets.map(
      (ticket) =>
        `| \`${md(ticket.payloadId)}\` | ${md(ticket.operation)} | ${md(ticket.status)} | \`${md(ticket.dedupeKey)}\` |`
    )
  ].join("\n");
}

function md(value: string): string {
  return safeText(value).replace(/\|/gu, "\\|").replace(/`/gu, "\\`");
}
