import assert from "node:assert/strict";
import test from "node:test";

import { buildRagSupportKnowledgeApprovalLedger } from "./approval-ledger.js";
import { buildRagSupportEventIdempotencyLedger } from "./idempotency-ledger.js";
import {
  buildRagSupportKnowledgeCandidateQueue,
  renderRagSupportKnowledgeCandidateQueueMarkdown
} from "./knowledge-candidate-queue.js";
import { renderRagSupportKnowledgeApprovalLedgerMarkdown } from "./approval-ledger.js";
import { buildRagSupportEvent } from "./support-event.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("approval ledger turns an approved candidate into a source-linked knowledge artifact", () => {
  const queue = candidateQueue();
  const candidate = queue.candidates[0];
  assert.ok(candidate);

  const ledger = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        decisionId: "approval_decision_1",
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "human_reviewer_1",
        summary: "Approved known issue wording for support use.",
        approvedTitle: "Blocking failure known issue",
        approvedBody: "We're aware of this blocking failure and are investigating a fix.",
        visibility: "customer_safe",
        reasonCodes: ["confirmed_by_engineering"]
      }
    ]
  });

  assert.equal(ledger.metrics.decisionCount, 1);
  assert.equal(ledger.metrics.approvedArtifactCount, 1);
  assert.equal(ledger.invalidDecisions.length, 0);
  assert.equal(ledger.approvedArtifacts[0]?.status, "approved_for_ingestion");
  assert.equal(ledger.approvedArtifacts[0]?.kind, "known_issue_candidate");
  assert.equal(ledger.approvedArtifacts[0]?.sourceCandidateId, candidate.candidateId);
  assert.deepEqual(ledger.approvedArtifacts[0]?.sourceEventIds, candidate.sourceEventIds);
  assert.equal(ledger.approvedArtifacts[0]?.corpusAdmission.currentRuntimeAnswerable, false);
  assert.equal(ledger.approvedArtifacts[0]?.corpusAdmission.approvedForIngestion, true);
  assert.equal(ledger.approvedArtifacts[0]?.corpusAdmission.answerableAfterIngestion, true);
  assert.equal(ledger.approvedArtifacts[0]?.ingestionHint.sourceKind, "derived_summary");
  assert.equal(ledger.approvedArtifacts[0]?.ingestionHint.adapter, "approved_knowledge_artifact");
});

test("approval ledger records reject and request changes without creating artifacts", () => {
  const queue = candidateQueue();
  const [first, second] = queue.candidates;
  assert.ok(first);
  assert.ok(second);

  const ledger = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        candidateId: first.candidateId,
        action: "reject",
        reviewerId: "human_reviewer_1",
        summary: "Not enough evidence yet.",
        reasonCodes: ["insufficient_evidence"]
      },
      {
        candidateId: second.candidateId,
        action: "request_changes",
        reviewerIdHash: "reviewer_hash_2",
        summary: "Needs clearer source wording.",
        followUpActions: ["Add engineering owner before approval."]
      }
    ]
  });

  assert.equal(ledger.metrics.decisionCount, 2);
  assert.equal(ledger.metrics.rejectedDecisionCount, 1);
  assert.equal(ledger.metrics.changeRequestDecisionCount, 1);
  assert.equal(ledger.metrics.approvedArtifactCount, 0);
  assert.deepEqual(
    ledger.decisions.map((decision) => decision.action),
    ["reject", "request_changes"]
  );
});

test("approval ledger rejects unknown, duplicate, and malformed approval decisions", () => {
  const queue = candidateQueue();
  const candidate = queue.candidates[0];
  assert.ok(candidate);

  const ledger = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "human_reviewer_1",
        summary: "Approved.",
        approvedBody: "Approved body."
      },
      {
        candidateId: candidate.candidateId,
        action: "reject",
        reviewerId: "human_reviewer_2",
        summary: "Conflicting second decision."
      },
      {
        candidateId: "missing_candidate",
        action: "approve",
        reviewerId: "human_reviewer_3",
        summary: "Unknown candidate.",
        approvedBody: "Unknown body."
      },
      {
        candidateId: queue.candidates[1]?.candidateId ?? "missing",
        action: "approve",
        summary: "Missing reviewer.",
        approvedBody: "Body."
      }
    ]
  });

  assert.equal(ledger.metrics.decisionCount, 1);
  assert.equal(ledger.metrics.approvedArtifactCount, 1);
  assert.deepEqual(
    ledger.invalidDecisions.map((decision) => decision.reasonCode),
    ["duplicate_candidate_decision", "unknown_candidate", "missing_reviewer_hash"]
  );
});

test("approval ledger redacts approved text and never stores raw reviewer ids", () => {
  const queue = candidateQueue();
  const candidate = queue.candidates[0];
  assert.ok(candidate);

  const ledger = buildRagSupportKnowledgeApprovalLedger({
    generatedAt: GENERATED_AT,
    queue,
    decisions: [
      {
        candidateId: candidate.candidateId,
        action: "approve",
        reviewerId: "raw_reviewer_should_not_leak",
        summary: "Approved after checking token=summary_secret_123.",
        approvedTitle: "Known issue api_key=title_secret_123",
        approvedBody: "Customer-safe body with Bearer body_secret_123456.",
        metadata: {
          unsafe: "password=metadata_secret_123"
        }
      }
    ]
  });
  const serialized = [
    JSON.stringify(ledger),
    renderRagSupportKnowledgeApprovalLedgerMarkdown(ledger),
    renderRagSupportKnowledgeCandidateQueueMarkdown(queue)
  ].join("\n");

  assert.equal(serialized.includes("raw_reviewer_should_not_leak"), false);
  assert.equal(serialized.includes("summary_secret_123"), false);
  assert.equal(serialized.includes("title_secret_123"), false);
  assert.equal(serialized.includes("body_secret_123456"), false);
  assert.equal(serialized.includes("metadata_secret_123"), false);
  assert.equal(ledger.decisions[0]?.reviewerIdHash.startsWith("reviewer_"), true);
});

function candidateQueue() {
  const events = [
    knownIssueCandidateEvent({
      eventId: "support_event_known_issue",
      sourceTicketId: "ticket_1",
      targetId: "known_issue_blocking_failure"
    }),
    routeUpdateEvent()
  ];
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events
  });

  return buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events,
    ledger
  });
}

function knownIssueCandidateEvent(options: {
  readonly eventId: string;
  readonly sourceTicketId: string;
  readonly targetId: string;
}) {
  return buildRagSupportEvent({
    eventId: options.eventId,
    sourceSystem: "admin_support",
    sourceEventId: `${options.sourceTicketId}:known_issue_signal`,
    sourceTicketId: options.sourceTicketId,
    runId: `run_${options.sourceTicketId}`,
    traceId: `trace_${options.sourceTicketId}`,
    profileId: "sample-support",
    eventType: "known_issue_candidate_created",
    occurredAt: GENERATED_AT,
    summary: "Support ticket indicates a possible known issue.",
    evidenceRefs: [evidenceRef(options.sourceTicketId)],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: options.targetId,
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a candidate known issue from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
}

function routeUpdateEvent() {
  return buildRagSupportEvent({
    eventId: "support_event_route_update",
    sourceSystem: "admin_support",
    sourceEventId: "route_event_1",
    sourceTicketId: "ticket_2",
    runId: "run_ticket_2",
    traceId: "trace_ticket_2",
    profileId: "sample-support",
    eventType: "route_corrected",
    occurredAt: GENERATED_AT,
    summary: "Support route correction should be reviewed.",
    evidenceRefs: [evidenceRef("ticket_2")],
    proposedKnowledgeAction: {
      kind: "routing_rule_update",
      targetId: "blocking_to_engineering",
      title: "Routing rule update candidate",
      summary: "Review routing rule after human correction.",
      requiresApproval: true,
      approverDestination: "human_support"
    }
  });
}

function evidenceRef(ticketId: string) {
  return {
    refId: `artifact_${ticketId}`,
    kind: "ticket" as const,
    sourceSystem: "admin_support" as const,
    artifactPath: `local-triage-reports/${ticketId}.json`,
    ticketId,
    runId: `run_${ticketId}`,
    traceId: `trace_${ticketId}`,
    sensitivity: "internal_only" as const,
    customerSafe: false
  };
}
