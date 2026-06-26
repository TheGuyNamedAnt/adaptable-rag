import assert from "node:assert/strict";
import test from "node:test";

import { buildRagSupportEventIdempotencyLedger } from "./idempotency-ledger.js";
import { buildRagSupportEvent, ragSupportEventIdempotencyKey } from "./support-event.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("support event contract builds a redacted stable operational event", () => {
  const event = knownIssueCandidateEvent({
    summary: "Anton marked this as matching a known issue. Bearer abcdefghijklmnop"
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(
    event.idempotencyKey,
    "rag_support_event:admin_support:ticket_123:known_issue_candidate_created:v1"
  );
  assert.equal(event.proposedKnowledgeAction.kind, "known_issue_candidate");
  assert.equal(event.proposedKnowledgeAction.requiresApproval, true);
  assert.equal(event.evidenceRefs[0]?.customerSafe, false);
  assert.equal(JSON.stringify(event).includes("abcdefghijklmnop"), false);
  assert.equal(event.summary.includes("Bearer [REDACTED]"), true);
  assert.equal(
    event.evidenceBoundary.some((entry) => entry.includes("operational evidence")),
    true
  );
});

test("support event idempotency ledger accepts a new event once", () => {
  const event = knownIssueCandidateEvent();
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [event],
    outputArtifactIdsByEventId: {
      [event.eventId]: ["candidate_known_issue_1"]
    }
  });

  assert.equal(ledger.status, "passed");
  assert.deepEqual(ledger.processableEventIds, [event.eventId]);
  assert.deepEqual(ledger.duplicateEventIds, []);
  assert.equal(ledger.entries[0]?.status, "processable");
  assert.equal(ledger.entries[0]?.outputArtifactIds[0], "candidate_known_issue_1");
});

test("support event idempotency ledger records duplicate events without duplicate work", () => {
  const first = knownIssueCandidateEvent({ eventId: "support_event_first" });
  const duplicate = knownIssueCandidateEvent({ eventId: "support_event_duplicate" });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [first, duplicate]
  });

  assert.equal(ledger.status, "passed");
  assert.deepEqual(ledger.processableEventIds, ["support_event_first"]);
  assert.deepEqual(ledger.duplicateEventIds, ["support_event_duplicate"]);
  assert.equal(ledger.metrics.entryCount, 1);
  assert.equal(ledger.metrics.occurrenceCount, 2);
  assert.equal(ledger.entries[0]?.status, "duplicate");
});

test("support event idempotency ledger blocks same key with different payload hash", () => {
  const first = knownIssueCandidateEvent({
    eventId: "support_event_first",
    summary: "Known issue candidate from ticket."
  });
  const conflict = knownIssueCandidateEvent({
    eventId: "support_event_conflict",
    summary: "Same idempotency key but different event payload."
  });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    events: [first, conflict]
  });

  assert.equal(ledger.status, "failed");
  assert.deepEqual(ledger.processableEventIds, ["support_event_first"]);
  assert.deepEqual(ledger.conflictEventIds, ["support_event_conflict"]);
  assert.equal(ledger.entries[0]?.status, "conflict");
  assert.equal(ledger.entries[0]?.errors[0]?.includes("different payload hash"), true);
});

test("support event idempotency ledger treats previously processed events as duplicates", () => {
  const first = knownIssueCandidateEvent({ eventId: "support_event_first" });
  const previousLedger = buildRagSupportEventIdempotencyLedger({
    generatedAt: "2026-06-23T00:00:00.000Z",
    events: [first]
  });
  const second = knownIssueCandidateEvent({ eventId: "support_event_second" });
  const ledger = buildRagSupportEventIdempotencyLedger({
    generatedAt: GENERATED_AT,
    previousLedger,
    events: [second]
  });

  assert.equal(ledger.status, "passed");
  assert.deepEqual(ledger.processableEventIds, []);
  assert.deepEqual(ledger.duplicateEventIds, ["support_event_second"]);
  assert.equal(ledger.entries[0]?.firstSeenAt, "2026-06-23T00:00:00.000Z");
  assert.equal(ledger.entries[0]?.lastSeenAt, GENERATED_AT);
});

test("support event idempotency key can fall back to run and trace ids", () => {
  assert.equal(
    ragSupportEventIdempotencyKey({
      sourceSystem: "support_bot",
      runId: "run_1",
      traceId: "trace_1",
      eventType: "ticket_triaged"
    }),
    "rag_support_event:support_bot:run_1:trace_1:ticket_triaged:v1"
  );
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
    profileId: "breakaway-support",
    eventType: "known_issue_candidate_created",
    occurredAt: GENERATED_AT,
    actor: "anton",
    summary: options.summary ?? "Anton marked this support ticket as a possible known issue.",
    evidenceRefs: [
      {
        refId: "triage_report_123",
        kind: "ticket",
        sourceSystem: "admin_support",
        artifactPath: "local-triage-reports/report_123.json",
        ticketId: "ticket_123",
        runId: "run_123",
        traceId: "trace_123",
        sensitivity: "internal_only",
        customerSafe: false
      }
    ],
    proposedKnowledgeAction: {
      kind: "known_issue_candidate",
      targetId: "known_issue_blocking_failure",
      knownIssueStatus: "candidate",
      title: "Possible blocking failure known issue",
      summary: "Create a candidate known issue from repeated blocking reports.",
      proposedWording: "We're checking whether this matches other reports.",
      requiresApproval: true,
      approverDestination: "engineering"
    },
    metadata: {
      route: "engineering_investigation",
      unsafeToken: "token=supersecretvalue"
    }
  });
}
