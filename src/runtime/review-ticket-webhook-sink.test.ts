import assert from "node:assert/strict";
import test from "node:test";

import {
  reviewTicketDedupeKey,
  syncReviewTickets,
  type ReviewTicketPayload
} from "../observability/review-ticket-sync.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { ReviewTicketWebhookSink } from "./review-ticket-webhook-sink.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("review ticket webhook sink dry-run does not send HTTP requests", async () => {
  const transport = new RecordingTransport([{ status: 200 }]);
  const sink = new ReviewTicketWebhookSink({
    id: "review_tickets",
    endpoint: "https://tickets.example.test/webhook",
    transport
  });
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    syncId: "sync_dry_run",
    mode: "dry_run",
    tickets: [ticket()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.skippedTicketCount, 1);
  assert.equal(transport.requests.length, 0);
});

test("review ticket webhook sink sends generic redacted ticket payloads", async () => {
  const transport = new RecordingTransport([{ status: 202, body: { externalIds: ["ticket_1"] } }]);
  const sink = new ReviewTicketWebhookSink({
    id: "review_tickets",
    endpoint: "https://tickets.example.test/webhook",
    transport,
    secrets: {
      apiKeyProvider: () => "live-ticket-token",
      secretId: "REVIEW_TICKET_WEBHOOK_TOKEN"
    }
  });
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    syncId: "sync_live",
    mode: "live",
    tickets: [ticket()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.syncedTicketCount, 1);
  assert.deepEqual(report.results[0]?.externalIds, ["ticket_1"]);
  assert.equal(report.results[0]?.externalRefs[0]?.dedupeKey.includes("review_1"), true);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer live-ticket-token");
  assert.equal(JSON.stringify(report).includes("live-ticket-token"), false);

  const body = transport.requests[0]?.body as {
    readonly event: string;
    readonly tickets: readonly [{ readonly dedupeKey: string; readonly title: string }];
  };
  assert.equal(body.event, "rag_review_ticket_sync");
  assert.equal(body.tickets[0]?.title, "Review ticket");
  assert.equal(body.tickets[0]?.dedupeKey.includes("review_1"), true);
});

test("review ticket webhook sink retries retryable responses", async () => {
  const transport = new RecordingTransport([{ status: 500 }, { status: 200 }]);
  const sleeps: number[] = [];
  const sink = new ReviewTicketWebhookSink({
    id: "review_tickets",
    endpoint: "https://tickets.example.test/webhook",
    transport,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 5,
      retryStatusCodes: [500]
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    mode: "live",
    tickets: [ticket()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.results[0]?.attempts.length, 2);
  assert.deepEqual(sleeps, [5]);
});

test("review ticket webhook sink redacts secrets from failed responses", async () => {
  const transport = new RecordingTransport([
    {
      status: 401,
      body: { error: { message: "bad bearer live-ticket-token" } }
    }
  ]);
  const sink = new ReviewTicketWebhookSink({
    id: "review_tickets",
    endpoint: "https://tickets.example.test/webhook",
    transport,
    secrets: {
      apiKeyProvider: () => "live-ticket-token"
    }
  });
  const report = await syncReviewTickets({
    generatedAt: GENERATED_AT,
    mode: "live",
    tickets: [ticket()],
    sinks: [sink]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.errors[0]?.includes("live-ticket-token"), false);
  assert.equal(JSON.stringify(report).includes("live-ticket-token"), false);
  assert.equal(report.results[0]?.attempts[0]?.errorCode, "auth_error");
});

test("review ticket webhook sink rejects unsafe non-local HTTP endpoints", () => {
  assert.throws(
    () =>
      new ReviewTicketWebhookSink({
        id: "review_tickets",
        endpoint: "http://tickets.example.test/webhook",
        transport: new RecordingTransport([])
      }),
    /https unless it targets localhost/u
  );
});

class RecordingTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private nextIndex = 0;

  constructor(private readonly responses: readonly Partial<ProviderHttpResponse>[]) {}

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.nextIndex] ?? { status: 200 };
    this.nextIndex += 1;
    return {
      status: response.status ?? 200,
      headers: response.headers ?? {},
      body: response.body ?? {},
      latencyMs: response.latencyMs ?? 1
    };
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
