import assert from "node:assert/strict";
import test from "node:test";

import type { RagHumanReviewQueue } from "./human-review-queue.js";
import { RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION } from "./human-review-queue.js";
import { buildReviewDecisionLedger } from "./review-decision-ledger.js";
import { buildReviewTicketPayloads } from "./review-ticket-export.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("review ticket export turns open queue items into safe create payloads", () => {
  const result = buildReviewTicketPayloads({ queue: reviewQueue() });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.kind, "queue_item");
  assert.equal(result.tickets[0]?.operation, "create");
  assert.equal(result.tickets[0]?.destination, "human_support");
  assert.equal(result.tickets[0]?.source.traceId, "trace_review_1");
  assert.equal(result.tickets[0]?.dedupeKey.includes("review_case_1"), true);
  assert.equal(JSON.stringify(result).includes("abcdefghijklmnop"), false);
});

test("review ticket export emits decision comments and feedback updates", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);
  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    ledgerId: "review_ledger_1",
    queue,
    decisions: [
      {
        decisionId: "decision_1",
        queueItemId: item.itemId,
        action: "revise",
        feedbackKind: "corpus_update",
        reviewerIdHash: "sha256:external",
        summary: "Source trust metadata needs correction.",
        followUpActions: ["Patch source floor metadata."]
      }
    ]
  });

  const result = buildReviewTicketPayloads({ queue, ledger });

  assert.equal(result.tickets.length, 3);
  assert.equal(
    result.tickets.some((ticket) => ticket.kind === "decision"),
    true
  );
  assert.equal(
    result.tickets.some((ticket) => ticket.kind === "feedback"),
    true
  );
  assert.equal(
    result.tickets.find((ticket) => ticket.kind === "feedback")?.metadata.recommendedAction,
    "Review source trust, source content, ingestion metadata, or corpus ownership."
  );
  assert.equal(JSON.stringify(result).includes("reviewer@example.test"), false);
});

test("review ticket export skips resolved queue items unless requested", () => {
  const queue = reviewQueue({ itemStatus: "resolved" });

  const defaultResult = buildReviewTicketPayloads({ queue });
  const includeResolvedResult = buildReviewTicketPayloads({ queue, includeResolved: true });

  assert.equal(defaultResult.tickets.length, 0);
  assert.equal(includeResolvedResult.tickets.length, 1);
});

test("review ticket export redacts unsafe decision text", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);
  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    ledgerId: "review_ledger_secret",
    queue,
    decisions: [
      {
        decisionId: "decision_secret",
        queueItemId: item.itemId,
        action: "convert_to_eval",
        reviewerIdHash: "sha256:external",
        summary: "Create eval from <script>alert(1)</script> token=supersecretvalue"
      }
    ]
  });

  const result = buildReviewTicketPayloads({ queue, ledger });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("supersecretvalue"), false);
  assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
  assert.equal(serialized.includes("<script>"), false);
  assert.equal(serialized.includes("&lt;script&gt;"), true);
});

function reviewQueue(
  options: { readonly itemStatus?: "open" | "assigned" | "resolved" | "dismissed" } = {}
): RagHumanReviewQueue {
  const status = options.itemStatus ?? "open";
  return {
    schemaVersion: RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION,
    queueId: "rag_review_queue_test",
    generatedAt: GENERATED_AT,
    status: "open",
    summary: "One queue item needs triage.",
    metrics: {
      itemCount: 1,
      openItemCount: status === "open" ? 1 : 0,
      criticalItemCount: 0,
      highItemCount: 0,
      mediumItemCount: 1,
      lowItemCount: 0
    },
    items: [
      {
        itemId: "review_case_1",
        kind: "answer_review",
        status,
        priority: "medium",
        createdAt: GENERATED_AT,
        dueAt: "2026-06-25T00:00:00.000Z",
        source: "eval",
        summary: "Eval case requires review. Bearer abcdefghijklmnop",
        profileId: "breakaway-support",
        namespaceId: "breakaway-support",
        caseId: "refund_review_case",
        setKind: "golden",
        runId: "run_review_1",
        traceId: "trace_review_1",
        destinations: ["human_support"],
        escalationRules: [
          {
            ruleId: "support_review",
            description: "Support review route.",
            trigger: "human review required",
            destination: "human_support"
          }
        ],
        reasonCodes: ["human_review_required", "citation_required"],
        evidence: {
          status: "human_review_required",
          artifactPaths: [".rag/eval-runs/latest/summary.json"],
          warningCodes: [],
          citationCount: 1,
          rejectedChunkCount: 0,
          safetyFlagCount: 0
        },
        recommendedActions: ["Open the linked safe eval summary."]
      }
    ],
    evidenceBoundary: ["Queue excludes raw prompt, source, and generated answer text."]
  };
}
