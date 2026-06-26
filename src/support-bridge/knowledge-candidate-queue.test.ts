import assert from "node:assert/strict";
import test from "node:test";

import { buildRagSupportEventIdempotencyLedger } from "./idempotency-ledger.js";
import {
  buildRagSupportKnowledgeCandidateQueue,
  renderRagSupportKnowledgeCandidateQueueMarkdown
} from "./knowledge-candidate-queue.js";
import { buildRagSupportEvent } from "./support-event.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("knowledge candidate queue promotes only processable support events with proposed actions", () => {
  const candidateEvent = knownIssueCandidateEvent({ eventId: "support_event_first" });
  const noActionEvent = triageEvent();
  const duplicateEvent = knownIssueCandidateEvent({ eventId: "support_event_duplicate" });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [candidateEvent, noActionEvent, duplicateEvent]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events: [candidateEvent, noActionEvent, duplicateEvent],
    ledger
  });

  assert.equal(queue.status, "open");
  assert.equal(queue.metrics.candidateCount, 1);
  assert.equal(queue.metrics.newCandidateCount, 1);
  assert.equal(queue.metrics.rejectedEventCount, 2);
  assert.equal(queue.metrics.duplicateEventCount, 1);
  assert.equal(queue.candidates[0]?.kind, "known_issue_candidate");
  assert.equal(queue.candidates[0]?.requiresHumanApproval, true);
  assert.equal(queue.candidates[0]?.corpusAdmission.answerable, false);
  assert.equal(queue.candidates[0]?.corpusAdmission.status, "not_admitted");
  assert.deepEqual(queue.rejectedEvents.map((event) => event.reasonCode).sort(), [
    "duplicate_event",
    "no_proposed_knowledge_action"
  ]);
});

test("knowledge candidate queue blocks all promotion when the source ledger fails", () => {
  const first = knownIssueCandidateEvent({
    eventId: "support_event_first",
    summary: "Candidate from first ticket."
  });
  const conflict = knownIssueCandidateEvent({
    eventId: "support_event_conflict",
    summary: "Same key, different payload."
  });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [first, conflict]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events: [first, conflict],
    ledger
  });

  assert.equal(ledger.status, "failed");
  assert.equal(queue.status, "blocked");
  assert.equal(queue.metrics.candidateCount, 0);
  assert.equal(queue.metrics.rejectedEventCount, 2);
  assert.deepEqual(
    queue.rejectedEvents.map((event) => event.reasonCode),
    ["ledger_failed", "ledger_failed"]
  );
});

test("knowledge candidate queue groups multiple processable events for the same target action", () => {
  const first = knownIssueStatusEvent({
    eventId: "support_event_status_1",
    sourceEventId: "engineering_status_1",
    sourceTicketId: "ticket_1"
  });
  const second = knownIssueStatusEvent({
    eventId: "support_event_status_2",
    sourceEventId: "engineering_status_2",
    sourceTicketId: "ticket_2"
  });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [first, second]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events: [first, second],
    ledger
  });

  assert.equal(queue.metrics.candidateCount, 1);
  assert.equal(queue.candidates[0]?.kind, "known_issue_status_update");
  assert.equal(queue.candidates[0]?.knownIssueStatus, "in_progress");
  assert.deepEqual(queue.candidates[0]?.sourceEventIds, [
    "support_event_status_1",
    "support_event_status_2"
  ]);
  assert.deepEqual(queue.candidates[0]?.sourceTicketIds, ["ticket_1", "ticket_2"]);
  assert.equal(queue.candidates[0]?.payloadHashes.length, 2);
});

test("knowledge candidate queue forces approval and keeps unsafe text out of artifacts", () => {
  const event = policyUpdateEvent();
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [event]
  });
  const queue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events: [event],
    ledger
  });
  const markdown = renderRagSupportKnowledgeCandidateQueueMarkdown(queue);
  const serialized = `${JSON.stringify(queue)}\n${markdown}`;

  assert.equal(queue.candidates[0]?.kind, "support_policy_update");
  assert.equal(queue.candidates[0]?.requiresHumanApproval, true);
  assert.equal(queue.candidates[0]?.corpusAdmission.answerable, false);
  assert.equal(serialized.includes("super_secret_policy_key"), false);
  assert.equal(
    queue.evidenceBoundary.some((entry) => entry.includes("not answerable corpus knowledge")),
    true
  );
});

test("knowledge candidate queue carries over pending candidates without reprocessing duplicate events", () => {
  const event = knownIssueCandidateEvent({ eventId: "support_event_first" });
  const firstLedger = buildRagSupportEventIdempotencyLedger({
    generatedAt: "2026-06-23T00:00:00.000Z",
    events: [event]
  });
  const firstQueue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: "2026-06-23T00:00:00.000Z",
    events: [event],
    ledger: firstLedger
  });
  const nextLedger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: []
  });
  const nextQueue = buildRagSupportKnowledgeCandidateQueue({
    generatedAt: GENERATED_AT,
    events: [],
    ledger: nextLedger,
    previousQueue: firstQueue
  });

  assert.equal(nextQueue.metrics.candidateCount, 1);
  assert.equal(nextQueue.metrics.carriedOverCandidateCount, 1);
  assert.equal(nextQueue.metrics.newCandidateCount, 0);
  assert.equal(nextQueue.candidates[0]?.createdAt, "2026-06-23T00:00:00.000Z");
  assert.equal(nextQueue.candidates[0]?.updatedAt, GENERATED_AT);
});

function knownIssueCandidateEvent(
  options: {
    readonly eventId?: string;
    readonly summary?: string;
  } = {}
) {
  return buildRagSupportEvent({
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    sourceSystem: "admin_support",
    sourceTicketId: "ticket_123",
    runId: "run_123",
    traceId: "trace_123",
    profileId: "sample-support",
    eventType: "known_issue_candidate_created",
    occurredAt: GENERATED_AT,
    summary: options.summary ?? "Anton marked this support ticket as a possible known issue.",
    evidenceRefs: [evidenceRef("ticket_123", "trace_123")],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a candidate known issue from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
}

function knownIssueStatusEvent(options: {
  readonly eventId: string;
  readonly sourceEventId: string;
  readonly sourceTicketId: string;
}) {
  return buildRagSupportEvent({
    eventId: options.eventId,
    sourceSystem: "admin_support",
    sourceEventId: options.sourceEventId,
    sourceTicketId: options.sourceTicketId,
    runId: `run_${options.sourceTicketId}`,
    traceId: `trace_${options.sourceTicketId}`,
    profileId: "sample-support",
    eventType: "engineering_status_changed",
    occurredAt: GENERATED_AT,
    summary: "Engineering marked the known issue as in progress.",
    evidenceRefs: [evidenceRef(options.sourceTicketId, `trace_${options.sourceTicketId}`)],
    proposedKnowledgeAction: {
      kind: "known_issue_status_update",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "in_progress",
      summary: "Engineering is investigating a fix.",
      proposedWording: "We're investigating a fix.",
      requiresApproval: true,
      approverDestination: "engineering"
    }
  });
}

function policyUpdateEvent() {
  return buildRagSupportEvent({
    eventId: "support_event_policy",
    sourceSystem: "rag_review",
    sourceEventId: "policy_review_1",
    sourceTicketId: "ticket_policy",
    runId: "run_policy",
    traceId: "trace_policy",
    profileId: "sample-support",
    eventType: "rag_review_decision_recorded",
    occurredAt: GENERATED_AT,
    summary: "Reviewer proposed a policy update with api_key=super_secret_policy_key.",
    evidenceRefs: [evidenceRef("ticket_policy", "trace_policy")],
    proposedKnowledgeAction: {
      kind: "support_policy_update",
      targetId: "blocking_policy",
      title: "Policy update api_key=super_secret_policy_key",
      summary: "Update support policy after review.",
      requiresApproval: false
    }
  });
}

function triageEvent() {
  return buildRagSupportEvent({
    eventId: "support_event_triage",
    sourceSystem: "admin_support",
    sourceTicketId: "ticket_456",
    runId: "run_456",
    traceId: "trace_456",
    profileId: "sample-support",
    eventType: "ticket_triaged",
    occurredAt: GENERATED_AT,
    summary: "Ticket triaged without a knowledge action.",
    evidenceRefs: [evidenceRef("ticket_456", "trace_456")],
    proposedKnowledgeAction: {
      kind: "none",
      requiresApproval: false
    }
  });
}

function evidenceRef(ticketId: string, traceId: string) {
  return {
    refId: `artifact_${ticketId}`,
    kind: "ticket" as const,
    sourceSystem: "admin_support" as const,
    artifactPath: `local-triage-reports/${ticketId}.json`,
    ticketId,
    runId: `run_${ticketId}`,
    traceId,
    sensitivity: "internal_only" as const,
    customerSafe: false
  };
}
