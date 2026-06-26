import assert from "node:assert/strict";
import test from "node:test";

import {
  DryRunReviewTicketSyncSink,
  reviewTicketDedupeKey,
  syncReviewTickets,
  type ReviewTicketPayload,
  type ReviewTicketSyncSink,
  type ReviewTicketSyncSinkRequest,
  type ReviewTicketSyncSinkResult
} from "./review-ticket-sync.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("review ticket sync reports successful sink delivery", async () => {
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    syncId: "sync_test",
    mode: "live",
    tickets: [ticket()],
    sinks: [new FakeSink("synced")]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.syncedSinkCount, 1);
  assert.equal(report.syncedTicketCount, 1);
  assert.equal(report.failedTicketCount, 0);
});

test("review ticket sync fails closed when required sinks are missing", async () => {
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    mode: "live",
    tickets: [ticket()],
    sinks: [],
    requireSink: true
  });

  assert.equal(report.status, "failed");
  assert.equal(report.errors.includes("At least one review ticket sync sink is required."), true);
});

test("review ticket sync captures thrown sink failures", async () => {
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    mode: "live",
    tickets: [ticket()],
    sinks: [new ThrowingSink()]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedSinkCount, 1);
  assert.equal(report.failedTicketCount, 1);
  assert.equal(report.errors.includes("ticket sink failed"), true);
});

test("dry-run review ticket sink records dedupe keys without sending", async () => {
  const payload = ticket({ source: { queueItemId: "review_1", traceId: "trace_1" } });
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    mode: "dry_run",
    tickets: [payload],
    sinks: [new DryRunReviewTicketSyncSink()]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.skippedSinkCount, 1);
  assert.equal(report.skippedTicketCount, 1);
  assert.equal(report.results[0]?.dedupeKeys[0], payload.dedupeKey);
});

test("review ticket dedupe keys are stable and omit timestamps", () => {
  const first = reviewTicketDedupeKey({
    kind: "queue_item",
    operation: "create",
    source: { queueItemId: "review_1", traceId: "trace_1" }
  });
  const second = reviewTicketDedupeKey({
    kind: "queue_item",
    operation: "create",
    source: { queueItemId: "review_1", traceId: "trace_1" }
  });

  assert.equal(first, second);
  assert.equal(first.includes("2026"), false);
});

class FakeSink implements ReviewTicketSyncSink {
  readonly id = "fake_ticket_sink";
  readonly kind = "custom";

  constructor(private readonly resultStatus: ReviewTicketSyncSinkResult["status"]) {}

  async sync(request: ReviewTicketSyncSinkRequest): Promise<ReviewTicketSyncSinkResult> {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: this.resultStatus,
      mode: request.mode,
      syncedTicketCount: this.resultStatus === "synced" ? request.tickets.length : 0,
      failedTicketCount: this.resultStatus === "failed" ? request.tickets.length : 0,
      skippedTicketCount: this.resultStatus === "skipped" ? request.tickets.length : 0,
      attempts: [],
      dedupeKeys: request.tickets.map((payload) => payload.dedupeKey),
      externalIds: this.resultStatus === "synced" ? ["external_1"] : [],
      externalRefs:
        this.resultStatus === "synced"
          ? [
              {
                dedupeKey: request.tickets[0]?.dedupeKey ?? "missing",
                externalId: "external_1"
              }
            ]
          : [],
      warnings: [],
      errors: this.resultStatus === "failed" ? ["ticket sink failed"] : []
    };
  }
}

class ThrowingSink implements ReviewTicketSyncSink {
  readonly id = "throwing_ticket_sink";
  readonly kind = "custom";

  async sync(_request: ReviewTicketSyncSinkRequest): Promise<ReviewTicketSyncSinkResult> {
    throw new Error("ticket sink failed");
  }
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
