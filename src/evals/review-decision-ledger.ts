import { createHash } from "node:crypto";

import type {
  RagHumanReviewItemKind,
  RagHumanReviewQueue,
  RagHumanReviewQueueItem
} from "./human-review-queue.js";

export const RAG_REVIEW_DECISION_LEDGER_SCHEMA_VERSION = 1;

const REVIEW_DECISION_ACTIONS = [
  "approve",
  "revise",
  "reject",
  "escalate",
  "convert_to_eval",
  "dismiss"
] as const;

const REVIEW_DECISION_FEEDBACK_KINDS = [
  "eval_candidate",
  "profile_policy_update",
  "corpus_update",
  "incident_follow_up",
  "routing_update"
] as const;

export type RagReviewDecisionAction = (typeof REVIEW_DECISION_ACTIONS)[number];
export type RagReviewDecisionStatus = "accepted" | "needs_follow_up" | "invalid";
export type RagReviewDecisionFeedbackKind = (typeof REVIEW_DECISION_FEEDBACK_KINDS)[number];

export interface RagReviewEvalCandidateInput {
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly caseId?: string;
  readonly setKind?: string;
  readonly checks?: readonly string[];
  readonly reason?: string;
  readonly artifactPath?: string;
}

export interface RagReviewDecisionInput {
  readonly decisionId?: string;
  readonly queueItemId: string;
  readonly action: RagReviewDecisionAction;
  readonly decidedAt?: string;
  readonly reviewerId?: string;
  readonly reviewerIdHash?: string;
  readonly summary: string;
  readonly reasonCodes?: readonly string[];
  readonly followUpActions?: readonly string[];
  readonly feedbackKind?: RagReviewDecisionFeedbackKind;
  readonly evalCandidate?: RagReviewEvalCandidateInput;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RagReviewDecisionLedgerInput {
  readonly ledgerId?: string;
  readonly generatedAt?: string;
  readonly queue: RagHumanReviewQueue;
  readonly decisions?: readonly RagReviewDecisionInput[];
}

export interface RagReviewDecisionSourceQueue {
  readonly schemaVersion: number;
  readonly queueId: string;
  readonly generatedAt: string;
  readonly status: string;
  readonly itemCount: number;
  readonly openItemCount: number;
}

export interface RagReviewDecisionQueueItemSnapshot {
  readonly itemId: string;
  readonly kind: RagHumanReviewItemKind;
  readonly status: string;
  readonly priority: string;
  readonly createdAt: string;
  readonly dueAt?: string;
  readonly source: string;
  readonly summary: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly caseId?: string;
  readonly setKind?: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly answerId?: string;
  readonly generationId?: string;
  readonly incidentId?: string;
  readonly assignedTo?: string;
  readonly destinations: readonly string[];
  readonly escalationRuleIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly artifactPaths: readonly string[];
  readonly warningCodes: readonly string[];
}

export interface RagReviewEvalCandidate {
  readonly candidateId: string;
  readonly sourceDecisionId: string;
  readonly sourceQueueItemId: string;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly caseId?: string;
  readonly setKind?: string;
  readonly checks: readonly string[];
  readonly reason: string;
  readonly artifactPath?: string;
  readonly requiredAuthorInputs: readonly string[];
}

export interface RagReviewFeedbackSignal {
  readonly signalId: string;
  readonly kind: RagReviewDecisionFeedbackKind;
  readonly sourceDecisionId: string;
  readonly queueItemId: string;
  readonly action: RagReviewDecisionAction;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly traceId?: string;
  readonly incidentId?: string;
  readonly summary: string;
  readonly recommendedAction: string;
  readonly artifactPaths: readonly string[];
  readonly evalCandidate?: RagReviewEvalCandidate;
}

export interface RagReviewDecisionRecord {
  readonly decisionId: string;
  readonly queueItemId: string;
  readonly action: RagReviewDecisionAction;
  readonly status: RagReviewDecisionStatus;
  readonly decidedAt: string;
  readonly reviewerIdHash: string;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly followUpActions: readonly string[];
  readonly feedbackKind?: RagReviewDecisionFeedbackKind;
  readonly queueItem: RagReviewDecisionQueueItemSnapshot;
  readonly evalCandidate?: RagReviewEvalCandidate;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RagReviewInvalidDecision {
  readonly index: number;
  readonly queueItemId?: string;
  readonly action?: string;
  readonly reason: string;
  readonly reasonCodes: readonly string[];
}

export interface RagReviewDecisionLedgerMetrics {
  readonly decisionCount: number;
  readonly feedbackSignalCount: number;
  readonly invalidDecisionCount: number;
  readonly decisionsByAction: Readonly<Record<RagReviewDecisionAction, number>>;
  readonly decisionsByStatus: Readonly<Record<RagReviewDecisionStatus, number>>;
  readonly feedbackByKind: Readonly<Record<RagReviewDecisionFeedbackKind, number>>;
}

export interface RagReviewDecisionLedger {
  readonly schemaVersion: typeof RAG_REVIEW_DECISION_LEDGER_SCHEMA_VERSION;
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly sourceQueue: RagReviewDecisionSourceQueue;
  readonly decisions: readonly RagReviewDecisionRecord[];
  readonly feedback: readonly RagReviewFeedbackSignal[];
  readonly metrics: RagReviewDecisionLedgerMetrics;
  readonly invalidDecisions: readonly RagReviewInvalidDecision[];
  readonly evidenceBoundary: readonly string[];
}

export function buildReviewDecisionLedger(
  input: RagReviewDecisionLedgerInput
): RagReviewDecisionLedger {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ledgerId = input.ledgerId ?? `rag_review_ledger_${safeTimestamp(generatedAt)}`;
  const queueItems = new Map(input.queue.items.map((item) => [item.itemId, item]));
  const decisions: RagReviewDecisionRecord[] = [];
  const invalidDecisions: RagReviewInvalidDecision[] = [];

  for (const [index, decision] of (input.decisions ?? []).entries()) {
    const invalid = validateDecisionInput(decision, index, queueItems);
    if (invalid) {
      invalidDecisions.push(invalid);
      continue;
    }

    const queueItem = queueItems.get(decision.queueItemId);
    if (!queueItem) {
      invalidDecisions.push(
        invalidDecision(index, decision, "Queue item was not found.", ["unknown_queue_item"])
      );
      continue;
    }

    decisions.push(decisionRecord(decision, queueItem, generatedAt, index));
  }

  const feedback = decisions.flatMap((decision) => feedbackSignalsForDecision(decision));

  return {
    schemaVersion: RAG_REVIEW_DECISION_LEDGER_SCHEMA_VERSION,
    ledgerId,
    generatedAt,
    sourceQueue: {
      schemaVersion: input.queue.schemaVersion,
      queueId: input.queue.queueId,
      generatedAt: input.queue.generatedAt,
      status: input.queue.status,
      itemCount: input.queue.metrics.itemCount,
      openItemCount: input.queue.metrics.openItemCount
    },
    decisions,
    feedback,
    metrics: ledgerMetrics(decisions, feedback, invalidDecisions),
    invalidDecisions,
    evidenceBoundary: [
      "Includes queue item ids, action/status, hashed reviewer ids, short reviewer summaries, reason codes, follow-up actions, safe queue metadata, artifact paths, and feedback routing signals.",
      "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, full principal claims, and un-hashed reviewer identifiers.",
      "Eval feedback candidates are shells only; authors must fill raw question, expected answer, and source-grounded expectations in the project's controlled eval authoring workflow."
    ]
  };
}

export function renderReviewDecisionLedgerMarkdown(ledger: RagReviewDecisionLedger): string {
  return [
    "# Review Decision Ledger",
    "",
    `- Ledger ID: \`${md(ledger.ledgerId)}\``,
    `- Generated: \`${md(ledger.generatedAt)}\``,
    `- Source Queue: \`${md(ledger.sourceQueue.queueId)}\``,
    "",
    "## Metrics",
    "",
    `- Decisions: ${ledger.metrics.decisionCount}`,
    `- Feedback signals: ${ledger.metrics.feedbackSignalCount}`,
    `- Invalid decisions: ${ledger.metrics.invalidDecisionCount}`,
    "",
    "## Decisions",
    "",
    decisionTable(ledger.decisions),
    "",
    "## Feedback Signals",
    "",
    feedbackTable(ledger.feedback),
    "",
    "## Invalid Decisions",
    "",
    invalidDecisionTable(ledger.invalidDecisions),
    "",
    "## Evidence Boundary",
    "",
    ledger.evidenceBoundary.map((entry) => `- ${md(entry)}`).join("\n"),
    ""
  ].join("\n");
}

export function redactReviewDecisionText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redacted = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[redacted]"),
    normalized
  );
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function validateDecisionInput(
  decision: RagReviewDecisionInput,
  index: number,
  queueItems: ReadonlyMap<string, RagHumanReviewQueueItem>
): RagReviewInvalidDecision | undefined {
  if (!decision.queueItemId || typeof decision.queueItemId !== "string") {
    return invalidDecision(index, decision, "Decision is missing a queue item id.", [
      "missing_queue_item_id"
    ]);
  }

  if (!queueItems.has(decision.queueItemId)) {
    return invalidDecision(index, decision, "Decision references an unknown queue item.", [
      "unknown_queue_item"
    ]);
  }

  if (!isReviewDecisionAction(decision.action)) {
    return invalidDecision(index, decision, "Decision action is not supported.", [
      "unsupported_action"
    ]);
  }

  if (!decision.summary || redactReviewDecisionText(decision.summary).length === 0) {
    return invalidDecision(index, decision, "Decision is missing a reviewer summary.", [
      "missing_summary"
    ]);
  }

  if (!decision.reviewerIdHash && !decision.reviewerId) {
    return invalidDecision(index, decision, "Decision is missing a reviewer identity hash.", [
      "missing_reviewer_hash"
    ]);
  }

  if (decision.feedbackKind && !isReviewDecisionFeedbackKind(decision.feedbackKind)) {
    return invalidDecision(index, decision, "Decision feedback kind is not supported.", [
      "unsupported_feedback_kind"
    ]);
  }

  return undefined;
}

function decisionRecord(
  decision: RagReviewDecisionInput,
  queueItem: RagHumanReviewQueueItem,
  generatedAt: string,
  index: number
): RagReviewDecisionRecord {
  const decidedAt = decision.decidedAt ?? generatedAt;
  const decisionId =
    decision.decisionId ??
    `rag_review_decision_${safeTimestamp(decidedAt)}_${safeId(queueItem.itemId)}_${index + 1}`;
  const queueItemCopy = queueItemSnapshot(queueItem);
  const evalCandidate =
    decision.evalCandidate === undefined
      ? undefined
      : evalCandidateFromInput(decision.evalCandidate, decisionId, queueItemCopy);

  return {
    decisionId,
    queueItemId: queueItem.itemId,
    action: decision.action,
    status: statusForAction(decision.action),
    decidedAt,
    reviewerIdHash:
      decision.reviewerIdHash ?? hashReviewerId(decision.reviewerId ?? "missing_reviewer"),
    summary: redactReviewDecisionText(decision.summary),
    reasonCodes: safeStringList(decision.reasonCodes),
    followUpActions: safeStringList(decision.followUpActions).map(redactReviewDecisionText),
    ...(decision.feedbackKind === undefined ? {} : { feedbackKind: decision.feedbackKind }),
    queueItem: queueItemCopy,
    ...(evalCandidate === undefined ? {} : { evalCandidate }),
    metadata: safeMetadata(decision.metadata)
  };
}

function feedbackSignalsForDecision(
  decision: RagReviewDecisionRecord
): readonly RagReviewFeedbackSignal[] {
  const kind = feedbackKindForDecision(decision);
  if (!kind) {
    return [];
  }

  const signalId = `rag_review_feedback_${safeId(decision.decisionId)}_${kind}`;
  const recommendedAction = recommendedActionForFeedback(kind, decision);
  const base = {
    signalId,
    kind,
    sourceDecisionId: decision.decisionId,
    queueItemId: decision.queueItemId,
    action: decision.action,
    summary: feedbackSummary(kind, decision),
    recommendedAction,
    artifactPaths: decision.queueItem.artifactPaths
  };
  const evalCandidate =
    kind === "eval_candidate"
      ? (decision.evalCandidate ?? evalCandidateForDecision(decision))
      : undefined;

  return [
    {
      ...base,
      ...(decision.queueItem.profileId === undefined
        ? {}
        : { profileId: decision.queueItem.profileId }),
      ...(decision.queueItem.namespaceId === undefined
        ? {}
        : { namespaceId: decision.queueItem.namespaceId }),
      ...(decision.queueItem.traceId === undefined ? {} : { traceId: decision.queueItem.traceId }),
      ...(decision.queueItem.incidentId === undefined
        ? {}
        : { incidentId: decision.queueItem.incidentId }),
      ...(evalCandidate === undefined ? {} : { evalCandidate })
    }
  ];
}

function feedbackKindForDecision(
  decision: RagReviewDecisionRecord
): RagReviewDecisionFeedbackKind | undefined {
  const configured = decision.feedbackKind ?? feedbackKindFromMetadata(decision.metadata);
  if (configured) {
    return configured;
  }

  switch (decision.action) {
    case "convert_to_eval":
      return "eval_candidate";
    case "revise":
      return "profile_policy_update";
    case "reject":
      return decision.queueItem.kind === "incident_review" ? "incident_follow_up" : "corpus_update";
    case "escalate":
      return decision.queueItem.kind === "incident_review"
        ? "incident_follow_up"
        : "routing_update";
    case "approve":
    case "dismiss":
      return decision.followUpActions.length > 0 ? "routing_update" : undefined;
  }
}

function feedbackKindFromMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>
): RagReviewDecisionFeedbackKind | undefined {
  const value = metadata.feedbackKind;
  return typeof value === "string" && isReviewDecisionFeedbackKind(value) ? value : undefined;
}

function evalCandidateForDecision(decision: RagReviewDecisionRecord): RagReviewEvalCandidate {
  const metadata = decision.metadata;
  const candidateId =
    typeof metadata.evalCandidateId === "string"
      ? metadata.evalCandidateId
      : `rag_eval_candidate_${safeId(decision.queueItemId)}`;
  const reason =
    typeof metadata.evalReason === "string"
      ? metadata.evalReason
      : "Reviewer requested eval coverage.";
  const artifactPath =
    typeof metadata.evalArtifactPath === "string" ? metadata.evalArtifactPath : undefined;
  const checks =
    typeof metadata.evalCheck === "string"
      ? [metadata.evalCheck]
      : decision.queueItem.reasonCodes.includes("citation_required")
        ? ["citation_required"]
        : [];

  return {
    candidateId: safeId(candidateId),
    sourceDecisionId: decision.decisionId,
    sourceQueueItemId: decision.queueItemId,
    ...(decision.queueItem.profileId === undefined
      ? {}
      : { profileId: decision.queueItem.profileId }),
    ...(decision.queueItem.namespaceId === undefined
      ? {}
      : { namespaceId: decision.queueItem.namespaceId }),
    ...(decision.queueItem.caseId === undefined ? {} : { caseId: decision.queueItem.caseId }),
    ...(decision.queueItem.setKind === undefined ? {} : { setKind: decision.queueItem.setKind }),
    checks,
    reason: redactReviewDecisionText(reason),
    ...(artifactPath === undefined ? {} : { artifactPath: redactReviewDecisionText(artifactPath) }),
    requiredAuthorInputs: [
      "raw user question or synthetic regression question",
      "expected answer contract",
      "required citations or source ids",
      "negative prompt-injection assertions when relevant"
    ]
  };
}

function evalCandidateFromInput(
  candidate: RagReviewEvalCandidateInput,
  decisionId: string,
  queueItem: RagReviewDecisionQueueItemSnapshot
): RagReviewEvalCandidate {
  const candidateId = candidate.caseId ?? `rag_eval_candidate_${safeId(queueItem.itemId)}`;

  return {
    candidateId: safeId(candidateId),
    sourceDecisionId: decisionId,
    sourceQueueItemId: queueItem.itemId,
    ...(candidate.profileId === undefined
      ? queueItem.profileId === undefined
        ? {}
        : { profileId: queueItem.profileId }
      : { profileId: redactReviewDecisionText(candidate.profileId) }),
    ...(candidate.namespaceId === undefined
      ? queueItem.namespaceId === undefined
        ? {}
        : { namespaceId: queueItem.namespaceId }
      : { namespaceId: redactReviewDecisionText(candidate.namespaceId) }),
    ...(candidate.caseId === undefined
      ? queueItem.caseId === undefined
        ? {}
        : { caseId: queueItem.caseId }
      : { caseId: redactReviewDecisionText(candidate.caseId) }),
    ...(candidate.setKind === undefined
      ? queueItem.setKind === undefined
        ? {}
        : { setKind: queueItem.setKind }
      : { setKind: redactReviewDecisionText(candidate.setKind) }),
    checks: safeStringList(candidate.checks),
    reason:
      candidate.reason === undefined
        ? "Reviewer requested eval coverage."
        : redactReviewDecisionText(candidate.reason),
    ...(candidate.artifactPath === undefined
      ? {}
      : { artifactPath: redactReviewDecisionText(candidate.artifactPath) }),
    requiredAuthorInputs: [
      "raw user question or synthetic regression question",
      "expected answer contract",
      "required citations or source ids",
      "negative prompt-injection assertions when relevant"
    ]
  };
}

function recommendedActionForFeedback(
  kind: RagReviewDecisionFeedbackKind,
  decision: RagReviewDecisionRecord
): string {
  switch (kind) {
    case "eval_candidate":
      return "Create or update a JSONL eval case from the linked safe evidence.";
    case "profile_policy_update":
      return "Review profile policy, escalation, refusal, freshness, or rendering rules.";
    case "corpus_update":
      return "Review source trust, source content, ingestion metadata, or corpus ownership.";
    case "incident_follow_up":
      return "Attach the decision to the incident follow-up list or postmortem.";
    case "routing_update":
      return decision.queueItem.destinations.length > 0
        ? "Sync the decision to the configured escalation destination."
        : "Add or revise queue routing metadata for this project.";
  }
}

function feedbackSummary(
  kind: RagReviewDecisionFeedbackKind,
  decision: RagReviewDecisionRecord
): string {
  return redactReviewDecisionText(
    `${kind} from ${decision.action} decision on ${decision.queueItem.kind} item ${decision.queueItemId}: ${decision.summary}`
  );
}

function queueItemSnapshot(item: RagHumanReviewQueueItem): RagReviewDecisionQueueItemSnapshot {
  return {
    itemId: item.itemId,
    kind: item.kind,
    status: item.status,
    priority: item.priority,
    createdAt: item.createdAt,
    ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
    source: item.source,
    summary: redactReviewDecisionText(item.summary),
    ...(item.profileId === undefined ? {} : { profileId: item.profileId }),
    ...(item.namespaceId === undefined ? {} : { namespaceId: item.namespaceId }),
    ...(item.caseId === undefined ? {} : { caseId: item.caseId }),
    ...(item.setKind === undefined ? {} : { setKind: item.setKind }),
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...(item.traceId === undefined ? {} : { traceId: item.traceId }),
    ...(item.answerId === undefined ? {} : { answerId: item.answerId }),
    ...(item.generationId === undefined ? {} : { generationId: item.generationId }),
    ...(item.incidentId === undefined ? {} : { incidentId: item.incidentId }),
    ...(item.assignedTo === undefined
      ? {}
      : { assignedTo: redactReviewDecisionText(item.assignedTo) }),
    destinations: safeStringList(item.destinations),
    escalationRuleIds: item.escalationRules.map((route) => redactReviewDecisionText(route.ruleId)),
    reasonCodes: safeStringList(item.reasonCodes),
    artifactPaths: safeStringList(item.evidence.artifactPaths),
    warningCodes: safeStringList(item.evidence.warningCodes)
  };
}

function ledgerMetrics(
  decisions: readonly RagReviewDecisionRecord[],
  feedback: readonly RagReviewFeedbackSignal[],
  invalidDecisions: readonly RagReviewInvalidDecision[]
): RagReviewDecisionLedgerMetrics {
  const decisionsByAction = emptyDecisionActionCounts();
  const decisionsByStatus = emptyDecisionStatusCounts();
  const feedbackByKind = emptyFeedbackKindCounts();

  for (const decision of decisions) {
    decisionsByAction[decision.action] += 1;
    decisionsByStatus[decision.status] += 1;
  }

  for (const signal of feedback) {
    feedbackByKind[signal.kind] += 1;
  }

  return {
    decisionCount: decisions.length,
    feedbackSignalCount: feedback.length,
    invalidDecisionCount: invalidDecisions.length,
    decisionsByAction,
    decisionsByStatus,
    feedbackByKind
  };
}

function emptyDecisionActionCounts(): Record<RagReviewDecisionAction, number> {
  return {
    approve: 0,
    revise: 0,
    reject: 0,
    escalate: 0,
    convert_to_eval: 0,
    dismiss: 0
  };
}

function emptyDecisionStatusCounts(): Record<RagReviewDecisionStatus, number> {
  return {
    accepted: 0,
    needs_follow_up: 0,
    invalid: 0
  };
}

function emptyFeedbackKindCounts(): Record<RagReviewDecisionFeedbackKind, number> {
  return {
    eval_candidate: 0,
    profile_policy_update: 0,
    corpus_update: 0,
    incident_follow_up: 0,
    routing_update: 0
  };
}

function invalidDecision(
  index: number,
  decision: RagReviewDecisionInput,
  reason: string,
  reasonCodes: readonly string[]
): RagReviewInvalidDecision {
  return {
    index,
    ...(typeof decision.queueItemId === "string" ? { queueItemId: decision.queueItemId } : {}),
    ...(typeof decision.action === "string" ? { action: decision.action } : {}),
    reason,
    reasonCodes
  };
}

function statusForAction(action: RagReviewDecisionAction): RagReviewDecisionStatus {
  switch (action) {
    case "approve":
    case "dismiss":
      return "accepted";
    case "revise":
    case "reject":
    case "escalate":
    case "convert_to_eval":
      return "needs_follow_up";
  }
}

function hashReviewerId(reviewerId: string): string {
  return `sha256:${createHash("sha256").update(reviewerId).digest("hex")}`;
}

function safeMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined
): Readonly<Record<string, string | number | boolean | null>> {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      safeId(key),
      typeof value === "string" ? redactReviewDecisionText(value) : value
    ])
  );
}

function safeStringList(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string"))]
    .map(redactReviewDecisionText)
    .filter((value) => value.length > 0);
}

function isReviewDecisionAction(value: string): value is RagReviewDecisionAction {
  return REVIEW_DECISION_ACTIONS.includes(value as RagReviewDecisionAction);
}

function isReviewDecisionFeedbackKind(value: string): value is RagReviewDecisionFeedbackKind {
  return REVIEW_DECISION_FEEDBACK_KINDS.includes(value as RagReviewDecisionFeedbackKind);
}

function decisionTable(decisions: readonly RagReviewDecisionRecord[]): string {
  if (decisions.length === 0) {
    return "No valid review decisions were supplied.";
  }

  return [
    "| Decision | Queue Item | Action | Status | Reviewer | Summary |",
    "| --- | --- | --- | --- | --- | --- |",
    ...decisions.map(
      (decision) =>
        `| \`${md(decision.decisionId)}\` | \`${md(decision.queueItemId)}\` | ${md(decision.action)} | ${md(decision.status)} | \`${md(shortHash(decision.reviewerIdHash))}\` | ${md(decision.summary)} |`
    )
  ].join("\n");
}

function feedbackTable(feedback: readonly RagReviewFeedbackSignal[]): string {
  if (feedback.length === 0) {
    return "No feedback signals were produced.";
  }

  return [
    "| Signal | Kind | Decision | Queue Item | Recommended Action |",
    "| --- | --- | --- | --- | --- |",
    ...feedback.map(
      (signal) =>
        `| \`${md(signal.signalId)}\` | ${md(signal.kind)} | \`${md(signal.sourceDecisionId)}\` | \`${md(signal.queueItemId)}\` | ${md(signal.recommendedAction)} |`
    )
  ].join("\n");
}

function invalidDecisionTable(invalidDecisions: readonly RagReviewInvalidDecision[]): string {
  if (invalidDecisions.length === 0) {
    return "No invalid decisions were supplied.";
  }

  return [
    "| Index | Queue Item | Action | Reason |",
    "| --- | --- | --- | --- |",
    ...invalidDecisions.map(
      (decision) =>
        `| ${decision.index} | \`${md(decision.queueItemId ?? "unknown")}\` | ${md(decision.action ?? "unknown")} | ${md(decision.reason)} |`
    )
  ].join("\n");
}

function md(value: string): string {
  return redactReviewDecisionText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\|/gu, "\\|");
}

function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 18)}...`;
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function safeId(value: string): string {
  const safe = redactReviewDecisionText(value).replace(/[^0-9a-z_.:-]+/giu, "_");
  return safe.length === 0 ? "unknown" : safe;
}

const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/-]{16,}/giu,
  /\bsk_(?:live|test|proj)_[a-z0-9._-]{8,}/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"',\s]{8,}/giu
];
