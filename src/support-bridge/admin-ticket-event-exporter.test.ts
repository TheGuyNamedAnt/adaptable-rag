import assert from "node:assert/strict";
import test from "node:test";

import { exportAdminSupportTicketEvents } from "./admin-ticket-event-exporter.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("admin support exporter emits ticket, review, route, and engineering events", () => {
  const result = exportAdminSupportTicketEvents({
    generatedAt: GENERATED_AT,
    defaultProfileId: "breakaway-support",
    defaultNamespaceId: "breakaway-support",
    triageReports: [
      {
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:01:00.000Z",
        artifactPath: "local-triage-reports/report_1.json",
        title: "Blocking failure",
        issueType: "bug",
        affectedArea: "blocking",
        severity: "high",
        supportRoute: {
          matchedRuleId: "high_blocking_to_engineering",
          queueId: "engineering_investigation",
          departmentId: "product_engineering",
          priority: "p1"
        }
      }
    ],
    ticketRecords: [
      {
        ticketId: "ticket_trace_1",
        runId: "run_1",
        traceId: "trace_1",
        updatedAt: "2026-06-24T00:02:00.000Z",
        state: "engineering_investigation",
        currentOwner: "engineering",
        flags: {
          knownIssueRelated: true,
          duplicatePossible: true
        }
      }
    ],
    humanReviews: [
      {
        reviewId: "review_1",
        runId: "run_1",
        traceId: "trace_1",
        reviewedAt: "2026-06-24T00:03:00.000Z",
        reviewer: "anton",
        humanReviewStatus: "corrected",
        correctedAffectedArea: "blocking",
        falseDeflection: true,
        notes: "Do not leak token=review_secret"
      }
    ],
    routeCorrections: [
      {
        eventId: "route_event_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:04:00.000Z",
        actor: "anton",
        reason: "Route to engineering investigation",
        nextRoute: {
          matchedRuleId: "high_blocking_to_engineering",
          queueId: "engineering_investigation",
          priority: "p1"
        }
      }
    ],
    investigations: [
      {
        investigationId: "investigation_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:05:00.000Z",
        status: "duplicate_known_issue",
        suggestedNextAction: "Link to known issue."
      }
    ],
    engineeringAutoRuns: [
      {
        autoRunId: "auto_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:06:00.000Z",
        actor: "anton",
        status: "patch_ready_for_review",
        outcomeSummary: "Patch candidate ready."
      }
    ]
  });

  assert.equal(result.ledger.status, "passed");
  assert.equal(result.metrics.eventCount, 6);
  assert.equal(result.metrics.proposedKnowledgeActionCount, 5);
  assert.equal(
    result.events.every((event) => event.namespaceId === "breakaway-support"),
    true
  );
  assert.deepEqual(
    result.events.map((event) => event.eventType),
    [
      "ticket_triaged",
      "known_issue_candidate_created",
      "human_review_saved",
      "route_corrected",
      "engineering_investigation_started",
      "engineering_status_changed"
    ]
  );
  assert.equal(
    result.events.find((event) => event.eventType === "route_corrected")?.proposedKnowledgeAction
      .kind,
    "routing_rule_update"
  );
  assert.equal(
    result.events.find((event) => event.eventType === "engineering_status_changed")
      ?.proposedKnowledgeAction.knownIssueStatus,
    "in_progress"
  );
});

test("admin support exporter uses idempotency to skip duplicate artifact events", () => {
  const routeCorrection = {
    eventId: "route_event_1",
    runId: "run_1",
    traceId: "trace_1",
    createdAt: "2026-06-24T00:04:00.000Z",
    actor: "anton",
    reason: "Route to engineering investigation",
    nextRoute: {
      matchedRuleId: "high_blocking_to_engineering",
      queueId: "engineering_investigation",
      priority: "p1"
    }
  };

  const result = exportAdminSupportTicketEvents({
    generatedAt: GENERATED_AT,
    routeCorrections: [routeCorrection, routeCorrection]
  });

  assert.equal(result.ledger.status, "passed");
  assert.equal(result.ledger.processableEventIds.length, 1);
  assert.equal(result.ledger.duplicateEventIds.length, 1);
  assert.equal(result.ledger.metrics.entryCount, 1);
});

test("admin support exporter maps blocked engineering auto-runs to blocked known issue updates", () => {
  const result = exportAdminSupportTicketEvents({
    generatedAt: GENERATED_AT,
    engineeringAutoRuns: [
      {
        autoRunId: "auto_blocked_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:06:00.000Z",
        status: "blocked",
        outcomeSummary: "Automation stopped and needs human engineering review."
      }
    ]
  });
  const event = result.events[0];

  assert.ok(event);
  assert.equal(event.eventType, "engineering_status_changed");
  assert.equal(event.proposedKnowledgeAction.kind, "known_issue_status_update");
  assert.equal(event.proposedKnowledgeAction.knownIssueStatus, "blocked");
});

test("admin support exporter flags conflicting reused source event ids", () => {
  const result = exportAdminSupportTicketEvents({
    generatedAt: GENERATED_AT,
    routeCorrections: [
      {
        eventId: "route_event_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:04:00.000Z",
        reason: "Route to engineering",
        nextRoute: {
          queueId: "engineering_investigation"
        }
      },
      {
        eventId: "route_event_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:04:00.000Z",
        reason: "Route to billing instead",
        nextRoute: {
          queueId: "billing_review"
        }
      }
    ]
  });

  assert.equal(result.ledger.status, "failed");
  assert.equal(result.ledger.conflictEventIds.length, 1);
  assert.equal(result.ledger.entries[0]?.status, "conflict");
});

test("admin support exporter does not expose raw drafts or secrets", () => {
  const result = exportAdminSupportTicketEvents({
    generatedAt: GENERATED_AT,
    replyApprovals: [
      {
        approvalId: "approval_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:07:00.000Z",
        approver: "anton",
        decision: "needs_revision",
        allowedDeliveryMode: "no_delivery",
        gateDecision: "blocked",
        notes: "api_key=should_not_leak"
      }
    ],
    replyDeliveryPreviews: [
      {
        deliveryPreviewId: "preview_1",
        approvalId: "approval_1",
        runId: "run_1",
        traceId: "trace_1",
        createdAt: "2026-06-24T00:08:00.000Z",
        status: "send_disabled_pending_integration",
        sendEnabled: false,
        sendDisabledReason: "integration disabled Bearer preview_secret_123"
      }
    ]
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("should_not_leak"), false);
  assert.equal(serialized.includes("preview_secret_123"), false);
  assert.equal(serialized.includes("api_key=[REDACTED]"), false);
  assert.equal(
    result.events.find((event) => event.eventType === "reply_approved")?.proposedKnowledgeAction
      .kind,
    "customer_macro_update"
  );
  assert.equal(
    result.evidenceBoundary.some((entry) => entry.includes("raw customer messages")),
    true
  );
});
