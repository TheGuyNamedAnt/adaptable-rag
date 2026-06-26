import { hashStableValue } from "../shared/stable-hash.js";
import type { RagSupportEventIdempotencyLedger } from "./idempotency-ledger.js";
import type {
  RagKnownIssueStatus,
  RagSupportEvent,
  RagSupportEvidenceRef,
  RagSupportKnowledgeActionKind
} from "./support-event.js";

export const RAG_SUPPORT_KNOWLEDGE_CANDIDATE_QUEUE_SCHEMA_VERSION = 1;

export type RagSupportKnowledgeCandidateKind = Exclude<RagSupportKnowledgeActionKind, "none">;
export type RagSupportKnowledgeCandidateQueueStatus = "empty" | "open" | "blocked";
export type RagSupportKnowledgeCandidateStatus = "pending_review" | "approved" | "rejected";
export type RagSupportKnowledgeCandidatePriority = "low" | "medium" | "high" | "critical";
export type RagSupportKnowledgeCandidateRejectionReason =
  | "ledger_failed"
  | "duplicate_event"
  | "conflict_event"
  | "not_processable_by_ledger"
  | "no_proposed_knowledge_action";

export interface RagSupportKnowledgeCandidateQueueInput {
  readonly queueId?: string;
  readonly generatedAt?: string;
  readonly events: readonly RagSupportEvent[];
  readonly ledger: RagSupportEventIdempotencyLedger;
  readonly previousQueue?: RagSupportKnowledgeCandidateQueue;
  readonly defaultReviewerDestination?: string;
}

export interface RagSupportKnowledgeCandidateQueueLedgerSnapshot {
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly status: RagSupportEventIdempotencyLedger["status"];
  readonly processableEventCount: number;
  readonly duplicateEventCount: number;
  readonly conflictEventCount: number;
}

export interface RagSupportKnowledgeCandidateCorpusAdmission {
  readonly answerable: false;
  readonly status: "not_admitted";
  readonly reason: string;
  readonly requiredGate: "human_approval";
}

export interface RagSupportKnowledgeCandidate {
  readonly candidateId: string;
  readonly candidateKey: string;
  readonly kind: RagSupportKnowledgeCandidateKind;
  readonly status: RagSupportKnowledgeCandidateStatus;
  readonly priority: RagSupportKnowledgeCandidatePriority;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly summary: string;
  readonly proposedWording?: string;
  readonly targetId?: string;
  readonly knownIssueStatus?: RagKnownIssueStatus;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly reviewerDestination: string;
  readonly requiresHumanApproval: true;
  readonly corpusAdmission: RagSupportKnowledgeCandidateCorpusAdmission;
  readonly sourceEventIds: readonly string[];
  readonly sourceIdempotencyKeys: readonly string[];
  readonly sourceTicketIds: readonly string[];
  readonly runIds: readonly string[];
  readonly traceIds: readonly string[];
  readonly payloadHashes: readonly string[];
  readonly evidenceRefs: readonly RagSupportEvidenceRef[];
  readonly reasonCodes: readonly string[];
}

export interface RagSupportKnowledgeCandidateRejection {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly eventType: RagSupportEvent["eventType"];
  readonly reasonCode: RagSupportKnowledgeCandidateRejectionReason;
  readonly reason: string;
}

export interface RagSupportKnowledgeCandidateQueueMetrics {
  readonly candidateCount: number;
  readonly pendingCandidateCount: number;
  readonly approvedCandidateCount: number;
  readonly rejectedCandidateCount: number;
  readonly newCandidateCount: number;
  readonly carriedOverCandidateCount: number;
  readonly rejectedEventCount: number;
  readonly duplicateEventCount: number;
  readonly conflictEventCount: number;
}

export interface RagSupportKnowledgeCandidateQueue {
  readonly schemaVersion: typeof RAG_SUPPORT_KNOWLEDGE_CANDIDATE_QUEUE_SCHEMA_VERSION;
  readonly queueId: string;
  readonly generatedAt: string;
  readonly status: RagSupportKnowledgeCandidateQueueStatus;
  readonly sourceLedger: RagSupportKnowledgeCandidateQueueLedgerSnapshot;
  readonly summary: string;
  readonly metrics: RagSupportKnowledgeCandidateQueueMetrics;
  readonly candidates: readonly RagSupportKnowledgeCandidate[];
  readonly rejectedEvents: readonly RagSupportKnowledgeCandidateRejection[];
  readonly evidenceBoundary: readonly string[];
}

export function buildRagSupportKnowledgeCandidateQueue(
  input: RagSupportKnowledgeCandidateQueueInput
): RagSupportKnowledgeCandidateQueue {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const queueId = input.queueId ?? `rag_support_knowledge_candidates_${safeTimestamp(generatedAt)}`;
  const previousCandidates = new Map(
    (input.previousQueue?.candidates ?? []).map((candidate) => [candidate.candidateKey, candidate])
  );
  const candidatesByKey = new Map<string, RagSupportKnowledgeCandidate>();
  const rejectedEvents: RagSupportKnowledgeCandidateRejection[] = [];
  const newCandidateKeys = new Set<string>();
  const carriedOverCandidateKeys = new Set<string>();

  for (const previous of previousCandidates.values()) {
    if (previous.status === "pending_review") {
      candidatesByKey.set(previous.candidateKey, {
        ...previous,
        updatedAt: generatedAt
      });
      carriedOverCandidateKeys.add(previous.candidateKey);
    }
  }

  if (input.ledger.status === "failed") {
    rejectedEvents.push(
      ...input.events.map((event) =>
        rejection(
          event,
          "ledger_failed",
          "The support event ledger failed, so promotion is blocked."
        )
      )
    );
  } else {
    const remainingProcessableEventIds = countedSet(input.ledger.processableEventIds);
    const duplicateEventIds = new Set(input.ledger.duplicateEventIds);
    const conflictEventIds = new Set(input.ledger.conflictEventIds);
    const processedIdempotencyKeys = new Set<string>();

    for (const event of input.events) {
      const remainingCount = remainingProcessableEventIds.get(event.eventId) ?? 0;

      if (processedIdempotencyKeys.has(event.idempotencyKey)) {
        rejectedEvents.push(
          rejection(
            event,
            "duplicate_event",
            "This idempotency key was already handled in this queue build."
          )
        );
        continue;
      }

      if (remainingCount > 0) {
        remainingProcessableEventIds.set(event.eventId, remainingCount - 1);
        processedIdempotencyKeys.add(event.idempotencyKey);

        const candidate = candidateFromEvent({
          event,
          generatedAt,
          defaultReviewerDestination: input.defaultReviewerDestination
        });

        if (!candidate) {
          rejectedEvents.push(
            rejection(
              event,
              "no_proposed_knowledge_action",
              "The processable event did not propose a knowledge action."
            )
          );
          continue;
        }

        const existing = candidatesByKey.get(candidate.candidateKey);
        candidatesByKey.set(
          candidate.candidateKey,
          existing ? mergeCandidate(existing, candidate, generatedAt) : candidate
        );
        if (!previousCandidates.has(candidate.candidateKey)) {
          newCandidateKeys.add(candidate.candidateKey);
        }
        continue;
      }

      if (conflictEventIds.has(event.eventId)) {
        rejectedEvents.push(
          rejection(event, "conflict_event", "The event conflicted with an existing payload hash.")
        );
        continue;
      }

      if (duplicateEventIds.has(event.eventId)) {
        rejectedEvents.push(
          rejection(event, "duplicate_event", "The event was already represented in the ledger.")
        );
        continue;
      }

      rejectedEvents.push(
        rejection(
          event,
          "not_processable_by_ledger",
          "The event was not processable by the ledger."
        )
      );
    }
  }

  const candidates = [...candidatesByKey.values()].sort(compareCandidates);
  const metrics = candidateMetrics({
    candidates,
    rejectedEvents,
    newCandidateKeys,
    carriedOverCandidateKeys
  });
  const status =
    input.ledger.status === "failed" ? "blocked" : candidates.length === 0 ? "empty" : "open";

  return {
    schemaVersion: RAG_SUPPORT_KNOWLEDGE_CANDIDATE_QUEUE_SCHEMA_VERSION,
    queueId,
    generatedAt,
    status,
    sourceLedger: {
      ledgerId: input.ledger.ledgerId,
      generatedAt: input.ledger.generatedAt,
      status: input.ledger.status,
      processableEventCount: input.ledger.processableEventIds.length,
      duplicateEventCount: input.ledger.duplicateEventIds.length,
      conflictEventCount: input.ledger.conflictEventIds.length
    },
    summary: queueSummary(status, metrics),
    metrics,
    candidates,
    rejectedEvents,
    evidenceBoundary: ragSupportKnowledgeCandidateQueueEvidenceBoundary()
  };
}

export function ragSupportKnowledgeCandidateQueueEvidenceBoundary(): readonly string[] {
  return [
    "Includes safe support event ids, idempotency keys, profile/namespace ids, candidate actions, short redacted summaries, artifact paths, payload hashes, and approval routing metadata.",
    "Excludes raw customer messages, raw diagnostics, raw generated answers, rendered prompts, full source bodies, credentials, routing secrets, and full principal claims.",
    "Knowledge candidates are not answerable corpus knowledge; every candidate remains not admitted until a separate human approval gate writes an approved knowledge artifact."
  ];
}

export function renderRagSupportKnowledgeCandidateQueueMarkdown(
  queue: RagSupportKnowledgeCandidateQueue
): string {
  return [
    "# Support Knowledge Candidate Queue",
    "",
    `- Queue ID: \`${md(queue.queueId)}\``,
    `- Generated: \`${md(queue.generatedAt)}\``,
    `- Status: **${md(queue.status)}**`,
    `- Source ledger: \`${md(queue.sourceLedger.ledgerId)}\` (${md(queue.sourceLedger.status)})`,
    "",
    "## Summary",
    "",
    md(queue.summary),
    "",
    "## Metrics",
    "",
    `- Candidates: ${queue.metrics.candidateCount}`,
    `- Pending: ${queue.metrics.pendingCandidateCount}`,
    `- New: ${queue.metrics.newCandidateCount}`,
    `- Carried over: ${queue.metrics.carriedOverCandidateCount}`,
    `- Rejected events: ${queue.metrics.rejectedEventCount}`,
    "",
    "## Candidates",
    "",
    candidateTable(queue.candidates),
    "",
    "## Rejected Events",
    "",
    rejectionTable(queue.rejectedEvents),
    "",
    "## Evidence Boundary",
    "",
    queue.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

function candidateFromEvent(input: {
  readonly event: RagSupportEvent;
  readonly generatedAt: string;
  readonly defaultReviewerDestination: string | undefined;
}): RagSupportKnowledgeCandidate | undefined {
  const action = input.event.proposedKnowledgeAction;
  if (action.kind === "none") {
    return undefined;
  }

  const kind = action.kind as RagSupportKnowledgeCandidateKind;
  const candidateKey = candidateKeyForEvent(input.event);
  const title = action.title ?? titleForAction(kind, action.knownIssueStatus);
  const summary = action.summary ?? input.event.summary;
  const reviewerDestination =
    action.approverDestination ?? input.defaultReviewerDestination ?? "human_review";

  return {
    candidateId: `rag_support_candidate_${shortHash(candidateKey)}`,
    candidateKey,
    kind,
    status: "pending_review",
    priority: priorityForAction(kind, action.knownIssueStatus),
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    title: safeText(title),
    summary: safeText(summary),
    ...(action.proposedWording === undefined
      ? {}
      : { proposedWording: safeText(action.proposedWording) }),
    ...(action.targetId === undefined ? {} : { targetId: safeId(action.targetId) }),
    ...(action.knownIssueStatus === undefined ? {} : { knownIssueStatus: action.knownIssueStatus }),
    ...(input.event.profileId === undefined ? {} : { profileId: safeText(input.event.profileId) }),
    ...(input.event.namespaceId === undefined
      ? {}
      : { namespaceId: safeText(input.event.namespaceId) }),
    reviewerDestination: safeText(reviewerDestination),
    requiresHumanApproval: true,
    corpusAdmission: {
      answerable: false,
      status: "not_admitted",
      reason:
        "Candidate is reviewable operational evidence only; no answer may cite it until approval creates an approved knowledge artifact.",
      requiredGate: "human_approval"
    },
    sourceEventIds: [input.event.eventId],
    sourceIdempotencyKeys: [input.event.idempotencyKey],
    sourceTicketIds: listOf(input.event.sourceTicketId),
    runIds: listOf(input.event.runId),
    traceIds: listOf(input.event.traceId),
    payloadHashes: [input.event.payloadHash],
    evidenceRefs: input.event.evidenceRefs,
    reasonCodes: reasonCodesForCandidate(kind, input.event)
  };
}

function mergeCandidate(
  existing: RagSupportKnowledgeCandidate,
  next: RagSupportKnowledgeCandidate,
  generatedAt: string
): RagSupportKnowledgeCandidate {
  return {
    ...existing,
    updatedAt: generatedAt,
    priority: higherPriority(existing.priority, next.priority),
    sourceEventIds: uniqueSorted([...existing.sourceEventIds, ...next.sourceEventIds]),
    sourceIdempotencyKeys: uniqueSorted([
      ...existing.sourceIdempotencyKeys,
      ...next.sourceIdempotencyKeys
    ]),
    sourceTicketIds: uniqueSorted([...existing.sourceTicketIds, ...next.sourceTicketIds]),
    runIds: uniqueSorted([...existing.runIds, ...next.runIds]),
    traceIds: uniqueSorted([...existing.traceIds, ...next.traceIds]),
    payloadHashes: uniqueSorted([...existing.payloadHashes, ...next.payloadHashes]),
    evidenceRefs: mergeEvidenceRefs(existing.evidenceRefs, next.evidenceRefs),
    reasonCodes: uniqueSorted([...existing.reasonCodes, ...next.reasonCodes])
  };
}

function candidateKeyForEvent(event: RagSupportEvent): string {
  const action = event.proposedKnowledgeAction;
  return [
    "rag_support_knowledge_candidate",
    event.profileId ?? "no_profile",
    event.namespaceId ?? "no_namespace",
    action.kind,
    action.targetId ?? event.sourceTicketId ?? event.idempotencyKey,
    action.knownIssueStatus ?? "no_status"
  ]
    .map(safeId)
    .join(":");
}

function rejection(
  event: RagSupportEvent,
  reasonCode: RagSupportKnowledgeCandidateRejectionReason,
  reason: string
): RagSupportKnowledgeCandidateRejection {
  return {
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    eventType: event.eventType,
    reasonCode,
    reason
  };
}

function candidateMetrics(input: {
  readonly candidates: readonly RagSupportKnowledgeCandidate[];
  readonly rejectedEvents: readonly RagSupportKnowledgeCandidateRejection[];
  readonly newCandidateKeys: ReadonlySet<string>;
  readonly carriedOverCandidateKeys: ReadonlySet<string>;
}): RagSupportKnowledgeCandidateQueueMetrics {
  return {
    candidateCount: input.candidates.length,
    pendingCandidateCount: input.candidates.filter(
      (candidate) => candidate.status === "pending_review"
    ).length,
    approvedCandidateCount: input.candidates.filter((candidate) => candidate.status === "approved")
      .length,
    rejectedCandidateCount: input.candidates.filter((candidate) => candidate.status === "rejected")
      .length,
    newCandidateCount: input.newCandidateKeys.size,
    carriedOverCandidateCount: input.carriedOverCandidateKeys.size,
    rejectedEventCount: input.rejectedEvents.length,
    duplicateEventCount: input.rejectedEvents.filter(
      (event) => event.reasonCode === "duplicate_event"
    ).length,
    conflictEventCount: input.rejectedEvents.filter(
      (event) => event.reasonCode === "conflict_event"
    ).length
  };
}

function queueSummary(
  status: RagSupportKnowledgeCandidateQueueStatus,
  metrics: RagSupportKnowledgeCandidateQueueMetrics
): string {
  if (status === "blocked") {
    return `${metrics.rejectedEventCount} support event(s) were blocked because the source ledger failed.`;
  }
  if (metrics.candidateCount === 0) {
    return "No support knowledge candidates are awaiting review.";
  }
  return `${metrics.candidateCount} support knowledge candidate(s) await review; ${metrics.newCandidateCount} new and ${metrics.carriedOverCandidateCount} carried over.`;
}

function titleForAction(
  kind: RagSupportKnowledgeCandidateKind,
  status: RagKnownIssueStatus | undefined
): string {
  if (kind === "known_issue_candidate") return "Known issue candidate";
  if (kind === "known_issue_status_update") {
    return `Known issue ${status ?? "status"} update candidate`;
  }
  if (kind === "routing_rule_update") return "Routing rule update candidate";
  if (kind === "eval_case") return "Eval case candidate";
  if (kind === "customer_macro_update") return "Customer macro update candidate";
  if (kind === "corpus_doc_update") return "Corpus document update candidate";
  return "Support policy update candidate";
}

function priorityForAction(
  kind: RagSupportKnowledgeCandidateKind,
  status: RagKnownIssueStatus | undefined
): RagSupportKnowledgeCandidatePriority {
  if (status === "fixed" || status === "verified" || status === "blocked") return "critical";
  if (kind === "known_issue_status_update" || kind === "known_issue_candidate") return "high";
  if (kind === "routing_rule_update" || kind === "eval_case") return "medium";
  return "low";
}

function reasonCodesForCandidate(
  kind: RagSupportKnowledgeCandidateKind,
  event: RagSupportEvent
): readonly string[] {
  return uniqueSorted([
    "processable_support_event",
    "human_approval_required",
    `${kind}_proposed`,
    `${event.eventType}_source`
  ]);
}

function mergeEvidenceRefs(
  left: readonly RagSupportEvidenceRef[],
  right: readonly RagSupportEvidenceRef[]
): readonly RagSupportEvidenceRef[] {
  const refs = new Map<string, RagSupportEvidenceRef>();
  for (const ref of [...left, ...right]) {
    refs.set([ref.kind, ref.refId, ref.artifactPath ?? ""].join(":"), ref);
  }
  return [...refs.values()].sort((a, b) =>
    [a.kind, a.refId, a.artifactPath ?? ""]
      .join(":")
      .localeCompare([b.kind, b.refId, b.artifactPath ?? ""].join(":"))
  );
}

function compareCandidates(
  left: RagSupportKnowledgeCandidate,
  right: RagSupportKnowledgeCandidate
): number {
  const priorityComparison = priorityRank(right.priority) - priorityRank(left.priority);
  if (priorityComparison !== 0) return priorityComparison;
  return left.candidateKey.localeCompare(right.candidateKey);
}

function higherPriority(
  left: RagSupportKnowledgeCandidatePriority,
  right: RagSupportKnowledgeCandidatePriority
): RagSupportKnowledgeCandidatePriority {
  return priorityRank(left) >= priorityRank(right) ? left : right;
}

function priorityRank(priority: RagSupportKnowledgeCandidatePriority): number {
  if (priority === "critical") return 4;
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function candidateTable(candidates: readonly RagSupportKnowledgeCandidate[]): string {
  if (candidates.length === 0) {
    return "_No candidates._";
  }

  return [
    "| Candidate | Kind | Priority | Status | Destination | Answerable | Sources |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...candidates.map(
      (candidate) =>
        `| \`${md(candidate.candidateId)}\` | ${md(candidate.kind)} | ${md(candidate.priority)} | ${md(candidate.status)} | ${md(candidate.reviewerDestination)} | no | ${candidate.sourceEventIds.length} |`
    )
  ].join("\n");
}

function rejectionTable(rejections: readonly RagSupportKnowledgeCandidateRejection[]): string {
  if (rejections.length === 0) {
    return "_No rejected events._";
  }

  return [
    "| Event | Type | Reason |",
    "| --- | --- | --- |",
    ...rejections.map(
      (event) => `| \`${md(event.eventId)}\` | ${md(event.eventType)} | ${md(event.reasonCode)} |`
    )
  ].join("\n");
}

function countedSet(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function listOf(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function safeText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redacted = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1[REDACTED]"),
    normalized
  );
  return redacted.length > 1000 ? `${redacted.slice(0, 997)}...` : redacted;
}

function safeId(value: string): string {
  return (
    safeText(value)
      .toLowerCase()
      .replace(/[^0-9a-z._:-]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || "unknown"
  );
}

function safeTimestamp(value: string): string {
  return safeId(value).replace(/:/gu, "_");
}

function shortHash(value: string): string {
  return hashStableValue(value).slice(0, 16);
}

function md(value: string): string {
  return value.replace(/[[\]\\`|*_{}()#+.!-]/gu, "\\$&");
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(bearer\s+)[a-z0-9._-]{8,}/giu,
  /\b(api[_-]?key\s*[:=]\s*)[^\s,;]+/giu,
  /\b(token\s*[:=]\s*)[^\s,;]+/giu,
  /\b(password\s*[:=]\s*)[^\s,;]+/giu
];
