import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileReviewTickets,
  renderReviewTicketReconciliationMarkdown,
  type ReviewTicketIdempotencyStore
} from "./review-ticket-reconciliation.js";
import {
  reviewTicketDedupeKey,
  type ReviewTicketPayload,
  type ReviewTicketSyncReport
} from "./review-ticket-sync.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("review ticket reconciliation stores dry-run skipped entries without failing", () => {
  const payload = ticket();
  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload],
    syncReport: syncReport({
      mode: "dry_run",
      resultStatus: "skipped",
      ticket: payload
    })
  });

  assert.equal(result.report.status, "passed");
  assert.equal(result.store.metrics.ticketCount, 1);
  assert.equal(result.store.entries[0]?.reconciliationStatus, "skipped");
  assert.equal(result.store.entries[0]?.firstSeenAt, GENERATED_AT);
  assert.deepEqual(result.store.entries[0]?.externalRefs, []);
});

test("review ticket reconciliation links live external refs by dedupe key", () => {
  const payload = ticket();
  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload],
    syncReport: syncReport({
      mode: "live",
      resultStatus: "synced",
      ticket: payload,
      externalId: "linear_123"
    })
  });

  assert.equal(result.report.status, "passed");
  assert.equal(result.store.entries[0]?.reconciliationStatus, "synced");
  assert.equal(result.store.entries[0]?.lastSyncedAt, GENERATED_AT);
  assert.equal(result.store.entries[0]?.externalRefs[0]?.externalId, "linear_123");
});

test("review ticket reconciliation derives refs from legacy externalIds", () => {
  const payload = ticket();
  const report = syncReport({
    mode: "live",
    resultStatus: "synced",
    ticket: payload,
    externalId: "legacy_123"
  });
  const legacyResult = { ...report.results[0] };
  delete (legacyResult as { externalRefs?: unknown }).externalRefs;

  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload],
    syncReport: {
      ...report,
      results: [legacyResult as ReviewTicketSyncReport["results"][number]]
    }
  });

  assert.equal(result.report.status, "passed");
  assert.equal(result.store.entries[0]?.reconciliationStatus, "synced");
  assert.equal(result.store.entries[0]?.externalRefs[0]?.externalId, "legacy_123");
});

test("review ticket reconciliation preserves previous first-seen and external refs", () => {
  const payload = ticket();
  const previous = previousStore(payload);
  const result = reconcileReviewTickets({
    generatedAt: "2026-06-25T00:00:00.000Z",
    tickets: [payload],
    previousStore: previous
  });

  assert.equal(result.store.entries[0]?.firstSeenAt, "2026-06-23T00:00:00.000Z");
  assert.equal(result.store.entries[0]?.externalRefs[0]?.externalId, "ticket_previous");
  assert.equal(result.store.entries[0]?.reconciliationStatus, "pending");
});

test("review ticket reconciliation treats closed external statuses as closed", () => {
  const payload = ticket();
  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload],
    syncReport: syncReport({
      mode: "live",
      resultStatus: "synced",
      ticket: payload,
      externalId: "zendesk_1"
    }),
    externalStatuses: [
      {
        dedupeKey: payload.dedupeKey,
        externalId: "zendesk_1",
        status: "closed",
        updatedAt: GENERATED_AT
      }
    ]
  });

  assert.equal(result.store.entries[0]?.reconciliationStatus, "closed");
  assert.equal(result.report.metrics.closedCount, 1);
  assert.equal(result.report.status, "passed");
});

test("review ticket reconciliation flags stale external statuses", () => {
  const payload = ticket();
  const result = reconcileReviewTickets({
    generatedAt: "2026-06-24T00:00:00.000Z",
    staleAfterHours: 24,
    tickets: [payload],
    syncReport: syncReport({
      mode: "live",
      resultStatus: "synced",
      ticket: payload,
      externalId: "jira_1"
    }),
    externalStatuses: [
      {
        dedupeKey: payload.dedupeKey,
        externalId: "jira_1",
        status: "open",
        updatedAt: "2026-06-20T00:00:00.000Z"
      }
    ]
  });

  assert.equal(result.store.entries[0]?.reconciliationStatus, "stale");
  assert.equal(result.report.status, "needs_attention");
  assert.equal(result.report.metrics.staleCount, 1);
});

test("review ticket reconciliation redacts untrusted external status snapshots", () => {
  const payload = ticket();
  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload],
    externalStatuses: [
      {
        dedupeKey: payload.dedupeKey,
        externalId: "ticket_1",
        status: "open bearer live_token_123",
        updatedAt: GENERATED_AT,
        url: "https://tickets.example.test/T-1?token=live_token_123",
        metadata: {
          note: "api_key=live_token_123",
          count: 1
        }
      }
    ]
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("live_token_123"), false);
  assert.equal(result.store.entries[0]?.externalStatus?.status, "open Bearer [REDACTED]");
  assert.equal(
    result.store.entries[0]?.externalStatus?.url,
    "https://tickets.example.test/T-1?token=[REDACTED]"
  );
  assert.equal(result.store.entries[0]?.externalStatus?.metadata?.note, "api_key=[REDACTED]");
});

test("review ticket reconciliation fails duplicate dedupe keys", () => {
  const payload = ticket();
  const duplicate = { ...payload, payloadId: "review_ticket_duplicate" };
  const result = reconcileReviewTickets({
    generatedAt: GENERATED_AT,
    tickets: [payload, duplicate]
  });
  const markdown = renderReviewTicketReconciliationMarkdown(result.report);

  assert.equal(result.report.status, "failed");
  assert.equal(result.report.metrics.duplicateCount, 1);
  assert.equal(markdown.includes("Duplicate review ticket payloads"), true);
  assert.equal(markdown.includes("## Evidence Boundary"), true);
});

function previousStore(payload: ReviewTicketPayload): ReviewTicketIdempotencyStore {
  return {
    schemaVersion: 1,
    storeId: "previous_store",
    generatedAt: "2026-06-23T00:00:00.000Z",
    entries: [
      {
        dedupeKey: payload.dedupeKey,
        payloadId: payload.payloadId,
        kind: payload.kind,
        operation: payload.operation,
        title: payload.title,
        priority: payload.priority,
        ticketStatus: payload.status,
        reconciliationStatus: "synced",
        source: payload.source,
        labels: payload.labels,
        artifactPaths: payload.artifactPaths,
        payloadHash: "sha256:previous",
        firstSeenAt: "2026-06-23T00:00:00.000Z",
        lastSeenAt: "2026-06-23T00:00:00.000Z",
        lastSyncedAt: "2026-06-23T00:00:00.000Z",
        externalRefs: [
          {
            dedupeKey: payload.dedupeKey,
            externalId: "ticket_previous"
          }
        ],
        warnings: [],
        errors: []
      }
    ],
    metrics: {
      ticketCount: 1,
      pendingCount: 0,
      skippedCount: 0,
      syncedCount: 1,
      failedCount: 0,
      closedCount: 0,
      staleCount: 0,
      duplicateCount: 0,
      externalRefCount: 1,
      unmatchedExternalStatusCount: 0
    },
    evidenceBoundary: []
  };
}

function syncReport(input: {
  readonly mode: "dry_run" | "live";
  readonly resultStatus: "skipped" | "synced" | "failed";
  readonly ticket: ReviewTicketPayload;
  readonly externalId?: string;
}): ReviewTicketSyncReport {
  const externalRefs =
    input.externalId === undefined
      ? []
      : [
          {
            dedupeKey: input.ticket.dedupeKey,
            externalId: input.externalId
          }
        ];
  return {
    schemaVersion: 1,
    syncId: "sync_1",
    generatedAt: GENERATED_AT,
    mode: input.mode,
    status: input.resultStatus === "failed" ? "failed" : "passed",
    ticketCount: 1,
    sinkCount: 1,
    syncedSinkCount: input.resultStatus === "synced" ? 1 : 0,
    failedSinkCount: input.resultStatus === "failed" ? 1 : 0,
    skippedSinkCount: input.resultStatus === "skipped" ? 1 : 0,
    syncedTicketCount: input.resultStatus === "synced" ? 1 : 0,
    failedTicketCount: input.resultStatus === "failed" ? 1 : 0,
    skippedTicketCount: input.resultStatus === "skipped" ? 1 : 0,
    warnings: [],
    errors: input.resultStatus === "failed" ? ["sync failed"] : [],
    results: [
      {
        sinkId: "test_sink",
        kind: input.mode === "dry_run" ? "dry_run" : "webhook",
        status: input.resultStatus,
        mode: input.mode,
        syncedTicketCount: input.resultStatus === "synced" ? 1 : 0,
        failedTicketCount: input.resultStatus === "failed" ? 1 : 0,
        skippedTicketCount: input.resultStatus === "skipped" ? 1 : 0,
        attempts: [],
        dedupeKeys: [input.ticket.dedupeKey],
        externalIds: externalRefs.map((ref) => ref.externalId),
        externalRefs,
        warnings: [],
        errors: input.resultStatus === "failed" ? ["sync failed"] : []
      }
    ],
    evidenceBoundary: []
  };
}

function ticket(overrides: Partial<ReviewTicketPayload> = {}): ReviewTicketPayload {
  const source = overrides.source ?? { queueItemId: "review_1", traceId: "trace_1" };
  const kind = overrides.kind ?? "queue_item";
  const operation = overrides.operation ?? "create";
  return {
    payloadId: "review_ticket_1",
    kind,
    operation,
    dedupeKey: reviewTicketDedupeKey({ kind, operation, source }),
    title: "Review ticket",
    body: "Safe review summary.",
    priority: "medium",
    status: "open",
    source,
    labels: ["rag", "human-review"],
    artifactPaths: [".rag/human-review/latest/queue.json"],
    metadata: {},
    ...overrides
  };
}
