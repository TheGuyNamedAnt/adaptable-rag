import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRagSupportAutoApprovalDecisions,
  RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION
} from "./auto-approval.js";
import type {
  RagSupportKnowledgeCandidate,
  RagSupportKnowledgeCandidateKind,
  RagSupportKnowledgeCandidateQueue
} from "./knowledge-candidate-queue.js";
import type { RagKnownIssueStatus } from "./support-event.js";

const GENERATED_AT = "2026-06-25T00:00:00.000Z";

test("support auto approval stays disabled by default", () => {
  const result = buildRagSupportAutoApprovalDecisions({
    generatedAt: GENERATED_AT,
    queue: queue([
      candidate({
        candidateId: "candidate_1",
        kind: "known_issue_status_update",
        knownIssueStatus: "confirmed"
      })
    ])
  });

  assert.equal(result.enabled, false);
  assert.equal(result.policyVersion, RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION);
  assert.equal(result.metrics.candidateCount, 1);
  assert.equal(result.metrics.decisionCount, 0);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.evidenceBoundary.length > 0, true);
});

test("support auto approval records all structural skip reasons", () => {
  const result = buildRagSupportAutoApprovalDecisions({
    generatedAt: GENERATED_AT,
    queue: queue([
      candidate({
        candidateId: "explicit",
        kind: "known_issue_status_update",
        knownIssueStatus: "confirmed"
      }),
      candidate({
        candidateId: "approved_already",
        kind: "known_issue_status_update",
        knownIssueStatus: "confirmed",
        status: "approved"
      }),
      candidate({
        candidateId: "kind_not_allowed",
        kind: "routing_rule_update",
        knownIssueStatus: "confirmed"
      }),
      candidate({
        candidateId: "missing_status",
        kind: "known_issue_status_update"
      }),
      candidate({
        candidateId: "status_not_allowed",
        kind: "known_issue_status_update",
        knownIssueStatus: "closed"
      }),
      candidate({
        candidateId: "decision_1",
        kind: "known_issue_status_update",
        knownIssueStatus: "confirmed"
      }),
      candidate({
        candidateId: "over_limit",
        kind: "known_issue_status_update",
        knownIssueStatus: "fixed"
      })
    ]),
    explicitlyDecidedCandidateIds: ["explicit"],
    policy: {
      enabled: true,
      maxDecisions: 1
    }
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(
    result.skippedCandidates.map((skipped) => skipped.reasonCode),
    [
      "explicit_decision_exists",
      "candidate_not_pending",
      "kind_not_allowed",
      "missing_known_issue_status",
      "known_issue_status_not_allowed",
      "max_decisions_reached"
    ]
  );
  assert.deepEqual(
    result.decisions.map((decision) => decision.candidateId),
    ["decision_1"]
  );
  assert.equal(result.metrics.explicitDecisionCandidateCount, 1);
  assert.equal(result.metrics.skippedCandidateCount, 6);
});

test("support auto approval emits safe canned outputs for all allowed statuses", () => {
  const statuses: readonly RagKnownIssueStatus[] = [
    "candidate",
    "confirmed",
    "in_progress",
    "fixed",
    "verified",
    "duplicate",
    "blocked"
  ];
  const result = buildRagSupportAutoApprovalDecisions({
    generatedAt: GENERATED_AT,
    queue: queue(
      statuses.map((status) =>
        candidate({
          candidateId: `candidate_${status}`,
          kind: status === "candidate" ? "known_issue_candidate" : "known_issue_status_update",
          knownIssueStatus: status,
          targetId: `target ${status} <>`
        })
      )
    ),
    policy: {
      enabled: true,
      reviewerIdHash: " reviewer unsafe ! ",
      maxDecisions: 0,
      customerSafeStatuses: ["confirmed", "fixed"]
    }
  });

  assert.equal(result.decisions.length, statuses.length);
  assert.equal(result.decisions[0]?.reviewerIdHash, "reviewer_unsafe");
  assert.deepEqual(
    result.decisions.map((decision) => decision.visibility),
    ["internal", "customer_safe", "internal", "customer_safe", "internal", "internal", "internal"]
  );
  assert.deepEqual(
    result.decisions.map((decision) => decision.metadata?.["knownIssueStatus"]),
    statuses
  );
  assert.equal(
    result.decisions.every((decision) => !(decision.approvedTitle ?? "").includes("<")),
    true
  );
  assert.equal(
    result.decisions.every((decision) => (decision.reasonCodes ?? []).includes("auto_ticket_sync")),
    true
  );
});

function queue(
  candidates: readonly RagSupportKnowledgeCandidate[]
): RagSupportKnowledgeCandidateQueue {
  return {
    schemaVersion: 1,
    queueId: "queue_auto_approval_test",
    generatedAt: GENERATED_AT,
    status: candidates.length === 0 ? "empty" : "open",
    sourceLedger: {
      ledgerId: "ledger_auto_approval_test",
      generatedAt: GENERATED_AT,
      status: "passed",
      processableEventCount: candidates.length,
      duplicateEventCount: 0,
      conflictEventCount: 0
    },
    summary: "Auto approval test queue.",
    metrics: {
      candidateCount: candidates.length,
      pendingCandidateCount: candidates.filter((candidate) => candidate.status === "pending_review")
        .length,
      approvedCandidateCount: candidates.filter((candidate) => candidate.status === "approved")
        .length,
      rejectedCandidateCount: candidates.filter((candidate) => candidate.status === "rejected")
        .length,
      newCandidateCount: candidates.length,
      carriedOverCandidateCount: 0,
      rejectedEventCount: 0,
      duplicateEventCount: 0,
      conflictEventCount: 0
    },
    candidates,
    rejectedEvents: [],
    evidenceBoundary: ["synthetic auto approval test queue"]
  };
}

function candidate(
  overrides: Partial<RagSupportKnowledgeCandidate> & {
    readonly candidateId: string;
    readonly kind: RagSupportKnowledgeCandidateKind;
  }
): RagSupportKnowledgeCandidate {
  return {
    candidateId: overrides.candidateId,
    candidateKey: overrides.candidateKey ?? overrides.candidateId,
    kind: overrides.kind,
    status: overrides.status ?? "pending_review",
    priority: overrides.priority ?? "medium",
    createdAt: overrides.createdAt ?? GENERATED_AT,
    updatedAt: overrides.updatedAt ?? GENERATED_AT,
    title: overrides.title ?? "Known issue update",
    summary: overrides.summary ?? "Structured known issue update.",
    ...(overrides.proposedWording === undefined
      ? {}
      : { proposedWording: overrides.proposedWording }),
    ...(overrides.targetId === undefined ? {} : { targetId: overrides.targetId }),
    ...(overrides.knownIssueStatus === undefined
      ? {}
      : { knownIssueStatus: overrides.knownIssueStatus }),
    ...(overrides.profileId === undefined ? {} : { profileId: overrides.profileId }),
    ...(overrides.namespaceId === undefined ? {} : { namespaceId: overrides.namespaceId }),
    reviewerDestination: overrides.reviewerDestination ?? "support-review",
    requiresHumanApproval: true,
    corpusAdmission: overrides.corpusAdmission ?? {
      answerable: false,
      status: "not_admitted",
      reason: "Requires human approval.",
      requiredGate: "human_approval"
    },
    sourceEventIds: overrides.sourceEventIds ?? [`event_${overrides.candidateId}`],
    sourceIdempotencyKeys: overrides.sourceIdempotencyKeys ?? [`key_${overrides.candidateId}`],
    sourceTicketIds: overrides.sourceTicketIds ?? [`ticket_${overrides.candidateId}`],
    runIds: overrides.runIds ?? ["run_auto_approval_test"],
    traceIds: overrides.traceIds ?? ["trace_auto_approval_test"],
    payloadHashes: overrides.payloadHashes ?? ["payload_hash"],
    evidenceRefs: overrides.evidenceRefs ?? [],
    reasonCodes: overrides.reasonCodes ?? ["structured_support_event"]
  };
}
