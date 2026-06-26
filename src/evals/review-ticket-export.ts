import {
  reviewTicketDedupeKey,
  type ReviewTicketPayload,
  type ReviewTicketPriority,
  type ReviewTicketSourceRef
} from "../observability/review-ticket-sync.js";
import type { RagHumanReviewQueue, RagHumanReviewQueueItem } from "./human-review-queue.js";
import {
  redactReviewDecisionText,
  type RagReviewDecisionLedger,
  type RagReviewDecisionRecord,
  type RagReviewFeedbackSignal
} from "./review-decision-ledger.js";

export interface ReviewTicketExportInput {
  readonly queue: RagHumanReviewQueue;
  readonly ledger?: RagReviewDecisionLedger;
  readonly includeResolved?: boolean;
}

export interface ReviewTicketExportResult {
  readonly tickets: readonly ReviewTicketPayload[];
  readonly evidenceBoundary: readonly string[];
}

export function buildReviewTicketPayloads(
  input: ReviewTicketExportInput
): ReviewTicketExportResult {
  const tickets = [
    ...queueItemTickets(input.queue, input.includeResolved ?? false),
    ...decisionTickets(input.queue, input.ledger),
    ...feedbackTickets(input.queue, input.ledger)
  ];

  return {
    tickets: dedupeTickets(tickets),
    evidenceBoundary: [
      "Ticket payloads are derived from the redacted human review queue and review decision ledger only.",
      "Ticket payloads include ids, statuses, safe summaries, destinations, labels, and artifact paths for external sync.",
      "Ticket payloads exclude raw user questions, raw source bodies, rendered context, generated answer text, secrets, routing keys, full principal claims, and un-hashed reviewer identifiers."
    ]
  };
}

function queueItemTickets(
  queue: RagHumanReviewQueue,
  includeResolved: boolean
): readonly ReviewTicketPayload[] {
  return queue.items
    .filter((item) => includeResolved || item.status === "open" || item.status === "assigned")
    .map((item) => {
      const source = sourceForQueueItem(queue.queueId, item);
      const kind = "queue_item";
      const operation = "create";

      return {
        payloadId: `review_ticket_queue_${safeId(item.itemId)}`,
        kind,
        operation,
        dedupeKey: reviewTicketDedupeKey({ kind, operation, source }),
        title: safeText(`[RAG Review] ${item.priority} ${item.kind}: ${item.itemId}`),
        body: queueItemBody(item),
        priority: priority(item.priority),
        status: item.status,
        source,
        ...(item.destinations[0] === undefined
          ? {}
          : { destination: safeText(item.destinations[0]) }),
        labels: labels(["rag", "human-review", item.kind, item.priority, item.profileId]),
        artifactPaths: safeList(item.evidence.artifactPaths),
        metadata: {
          source: safeText(item.source),
          reasonCodes: safeList(item.reasonCodes).join(","),
          escalationRuleIds: item.escalationRules.map((route) => safeText(route.ruleId)).join(",")
        }
      };
    });
}

function decisionTickets(
  queue: RagHumanReviewQueue,
  ledger: RagReviewDecisionLedger | undefined
): readonly ReviewTicketPayload[] {
  if (!ledger) {
    return [];
  }

  return ledger.decisions.map((decision) => {
    const source = sourceForDecision(queue.queueId, ledger.ledgerId, decision);
    const kind = "decision";
    const operation = "comment";

    return {
      payloadId: `review_ticket_decision_${safeId(decision.decisionId)}`,
      kind,
      operation,
      dedupeKey: reviewTicketDedupeKey({ kind, operation, source }),
      title: safeText(`[RAG Review Decision] ${decision.action}: ${decision.queueItemId}`),
      body: decisionBody(decision),
      priority: priority(decision.queueItem.priority),
      status: decision.status,
      source,
      ...(decision.queueItem.destinations[0] === undefined
        ? {}
        : { destination: safeText(decision.queueItem.destinations[0]) }),
      labels: labels([
        "rag",
        "review-decision",
        decision.action,
        decision.status,
        decision.queueItem.profileId
      ]),
      artifactPaths: safeList(decision.queueItem.artifactPaths),
      metadata: {
        reviewerIdHash: safeText(decision.reviewerIdHash),
        reasonCodes: safeList(decision.reasonCodes).join(","),
        followUpActions: safeList(decision.followUpActions).join(",")
      }
    };
  });
}

function feedbackTickets(
  queue: RagHumanReviewQueue,
  ledger: RagReviewDecisionLedger | undefined
): readonly ReviewTicketPayload[] {
  if (!ledger) {
    return [];
  }

  return ledger.feedback.map((feedback) => {
    const item = queue.items.find((queueItem) => queueItem.itemId === feedback.queueItemId);
    const source = sourceForFeedback(queue.queueId, ledger.ledgerId, feedback);
    const kind = "feedback";
    const operation = "update";

    return {
      payloadId: `review_ticket_feedback_${safeId(feedback.signalId)}`,
      kind,
      operation,
      dedupeKey: reviewTicketDedupeKey({ kind, operation, source }),
      title: safeText(`[RAG Feedback] ${feedback.kind}: ${feedback.queueItemId}`),
      body: feedbackBody(feedback),
      priority: priority(item?.priority ?? feedbackPriority(feedback.kind)),
      status: feedback.kind,
      source,
      ...(item?.destinations[0] === undefined
        ? {}
        : { destination: safeText(item.destinations[0]) }),
      labels: labels([
        "rag",
        "review-feedback",
        feedback.kind,
        feedback.action,
        feedback.profileId
      ]),
      artifactPaths: safeList(feedback.artifactPaths),
      metadata: {
        recommendedAction: safeText(feedback.recommendedAction),
        ...(feedback.evalCandidate === undefined
          ? {}
          : { evalCandidateId: safeText(feedback.evalCandidate.candidateId) })
      }
    };
  });
}

function sourceForQueueItem(queueId: string, item: RagHumanReviewQueueItem): ReviewTicketSourceRef {
  return {
    queueId,
    queueItemId: item.itemId,
    ...(item.profileId === undefined ? {} : { profileId: item.profileId }),
    ...(item.namespaceId === undefined ? {} : { namespaceId: item.namespaceId }),
    ...(item.traceId === undefined ? {} : { traceId: item.traceId }),
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...(item.incidentId === undefined ? {} : { incidentId: item.incidentId })
  };
}

function sourceForDecision(
  queueId: string,
  ledgerId: string,
  decision: RagReviewDecisionRecord
): ReviewTicketSourceRef {
  return {
    queueId,
    ledgerId,
    queueItemId: decision.queueItemId,
    decisionId: decision.decisionId,
    ...(decision.queueItem.profileId === undefined
      ? {}
      : { profileId: decision.queueItem.profileId }),
    ...(decision.queueItem.namespaceId === undefined
      ? {}
      : { namespaceId: decision.queueItem.namespaceId }),
    ...(decision.queueItem.traceId === undefined ? {} : { traceId: decision.queueItem.traceId }),
    ...(decision.queueItem.runId === undefined ? {} : { runId: decision.queueItem.runId }),
    ...(decision.queueItem.incidentId === undefined
      ? {}
      : { incidentId: decision.queueItem.incidentId })
  };
}

function sourceForFeedback(
  queueId: string,
  ledgerId: string,
  feedback: RagReviewFeedbackSignal
): ReviewTicketSourceRef {
  return {
    queueId,
    ledgerId,
    queueItemId: feedback.queueItemId,
    feedbackSignalId: feedback.signalId,
    ...(feedback.profileId === undefined ? {} : { profileId: feedback.profileId }),
    ...(feedback.namespaceId === undefined ? {} : { namespaceId: feedback.namespaceId }),
    ...(feedback.traceId === undefined ? {} : { traceId: feedback.traceId }),
    ...(feedback.incidentId === undefined ? {} : { incidentId: feedback.incidentId })
  };
}

function queueItemBody(item: RagHumanReviewQueueItem): string {
  return safeText(
    [
      item.summary,
      "",
      `Priority: ${item.priority}`,
      `Status: ${item.status}`,
      `Source: ${item.source}`,
      `Reason codes: ${item.reasonCodes.join(", ") || "none"}`,
      `Trace: ${item.traceId ?? "none"}`,
      `Incident: ${item.incidentId ?? "none"}`,
      `Recommended actions: ${item.recommendedActions.join("; ") || "none"}`,
      `Artifacts: ${item.evidence.artifactPaths.join(", ") || "none"}`
    ].join("\n")
  );
}

function decisionBody(decision: RagReviewDecisionRecord): string {
  return safeText(
    [
      decision.summary,
      "",
      `Action: ${decision.action}`,
      `Status: ${decision.status}`,
      `Decided at: ${decision.decidedAt}`,
      `Reviewer hash: ${decision.reviewerIdHash}`,
      `Reason codes: ${decision.reasonCodes.join(", ") || "none"}`,
      `Follow-up actions: ${decision.followUpActions.join("; ") || "none"}`,
      `Artifacts: ${decision.queueItem.artifactPaths.join(", ") || "none"}`
    ].join("\n")
  );
}

function feedbackBody(feedback: RagReviewFeedbackSignal): string {
  return safeText(
    [
      feedback.summary,
      "",
      `Feedback kind: ${feedback.kind}`,
      `Source action: ${feedback.action}`,
      `Recommended action: ${feedback.recommendedAction}`,
      `Trace: ${feedback.traceId ?? "none"}`,
      `Incident: ${feedback.incidentId ?? "none"}`,
      `Eval candidate: ${feedback.evalCandidate?.candidateId ?? "none"}`,
      `Artifacts: ${feedback.artifactPaths.join(", ") || "none"}`
    ].join("\n")
  );
}

function dedupeTickets(tickets: readonly ReviewTicketPayload[]): readonly ReviewTicketPayload[] {
  const byDedupeKey = new Map<string, ReviewTicketPayload>();
  for (const ticket of tickets) {
    byDedupeKey.set(ticket.dedupeKey, ticket);
  }
  return [...byDedupeKey.values()];
}

function priority(value: string): ReviewTicketPriority {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function feedbackPriority(kind: string): ReviewTicketPriority {
  return kind === "incident_follow_up" ? "critical" : "medium";
}

function labels(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.flatMap((value) => (value === undefined ? [] : [safeLabel(value)])))];
}

function safeList(values: readonly string[]): readonly string[] {
  return values.map(safeText).filter((value) => value.length > 0);
}

function safeText(value: string): string {
  return redactReviewDecisionText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function safeLabel(value: string): string {
  const safe = safeText(value)
    .toLowerCase()
    .replace(/[^0-9a-z._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe.length === 0 ? "unknown" : safe;
}

function safeId(value: string): string {
  const safe = safeText(value).replace(/[^0-9a-z_.:-]+/giu, "_");
  return safe.length === 0 ? "unknown" : safe;
}
