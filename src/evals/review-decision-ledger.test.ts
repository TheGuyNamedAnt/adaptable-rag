import assert from "node:assert/strict";
import test from "node:test";

import type { RagHumanReviewQueue } from "./human-review-queue.js";
import { RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION } from "./human-review-queue.js";
import {
  buildReviewDecisionLedger,
  renderReviewDecisionLedgerMarkdown
} from "./review-decision-ledger.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("review decision ledger links decisions to queue items and hashes reviewers", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);

  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        queueItemId: item.itemId,
        action: "approve",
        reviewerId: "reviewer@example.test",
        summary: "Approved based on linked safe trace evidence."
      }
    ]
  });

  assert.equal(ledger.metrics.decisionCount, 1);
  assert.equal(ledger.metrics.invalidDecisionCount, 0);
  assert.equal(ledger.metrics.decisionsByAction.approve, 1);
  assert.equal(ledger.decisions[0]?.queueItem.traceId, "trace_review_1");
  assert.match(ledger.decisions[0]?.reviewerIdHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(ledger).includes("reviewer@example.test"), false);
  assert.equal(ledger.feedback.length, 0);
});

test("review decision ledger rejects decisions for unknown queue items", () => {
  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    queue: reviewQueue(),
    decisions: [
      {
        queueItemId: "missing_item",
        action: "approve",
        reviewerIdHash: "sha256:external",
        summary: "This should not be accepted."
      }
    ]
  });

  assert.equal(ledger.metrics.decisionCount, 0);
  assert.equal(ledger.metrics.invalidDecisionCount, 1);
  assert.equal(ledger.invalidDecisions[0]?.reasonCodes[0], "unknown_queue_item");
});

test("review decision ledger converts review decisions into safe eval feedback shells", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);

  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        queueItemId: item.itemId,
        action: "convert_to_eval",
        reviewerIdHash: "sha256:external",
        summary: "Create regression coverage; Bearer abcdefghijklmnop should be removed.",
        evalCandidate: {
          caseId: "refund_escalation_regression",
          setKind: "adversarial",
          checks: ["citation_required", "escalation_rule_match"],
          reason: "Needs durable coverage for refund escalation decisions."
        }
      }
    ]
  });

  assert.equal(ledger.metrics.feedbackSignalCount, 1);
  assert.equal(ledger.feedback[0]?.kind, "eval_candidate");
  assert.equal(ledger.feedback[0]?.evalCandidate?.caseId, "refund_escalation_regression");
  assert.deepEqual(ledger.feedback[0]?.evalCandidate?.checks, [
    "citation_required",
    "escalation_rule_match"
  ]);
  assert.equal(
    ledger.feedback[0]?.evalCandidate?.requiredAuthorInputs.includes("expected answer contract"),
    true
  );
  assert.equal(JSON.stringify(ledger).includes("abcdefghijklmnop"), false);
  assert.equal(JSON.stringify(ledger).includes("raw user question text"), false);
});

test("review decision ledger respects explicit feedback kinds", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);

  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        queueItemId: item.itemId,
        action: "revise",
        feedbackKind: "corpus_update",
        reviewerIdHash: "sha256:external",
        summary: "Source trust metadata needs correction."
      }
    ]
  });

  assert.equal(ledger.feedback[0]?.kind, "corpus_update");
  assert.equal(ledger.metrics.feedbackByKind.corpus_update, 1);
});

test("review decision ledger markdown escapes unsafe values and redacts secrets", () => {
  const queue = reviewQueue();
  const item = queue.items[0];
  assert.ok(item);

  const ledger = buildReviewDecisionLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        queueItemId: item.itemId,
        action: "revise",
        reviewerIdHash: "sha256:external",
        summary: "<script>alert(1)</script> token=supersecretvalue",
        followUpActions: ["Open policy ticket with api_key=anothersecretvalue"]
      }
    ]
  });
  const markdown = renderReviewDecisionLedgerMarkdown(ledger);

  assert.equal(markdown.includes("<script>"), false);
  assert.equal(markdown.includes("&lt;script&gt;"), true);
  assert.equal(markdown.includes("supersecretvalue"), false);
  assert.equal(markdown.includes("anothersecretvalue"), false);
  assert.equal(markdown.includes("## Evidence Boundary"), true);
});

function reviewQueue(): RagHumanReviewQueue {
  return {
    schemaVersion: RAG_HUMAN_REVIEW_QUEUE_SCHEMA_VERSION,
    queueId: "rag_review_queue_test",
    generatedAt: GENERATED_AT,
    status: "open",
    summary: "One queue item needs triage.",
    metrics: {
      itemCount: 1,
      openItemCount: 1,
      criticalItemCount: 0,
      highItemCount: 0,
      mediumItemCount: 1,
      lowItemCount: 0
    },
    items: [
      {
        itemId: "review_case_1",
        kind: "answer_review",
        status: "open",
        priority: "medium",
        createdAt: GENERATED_AT,
        dueAt: "2026-06-25T00:00:00.000Z",
        source: "eval",
        summary: "Eval case requires review.",
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
