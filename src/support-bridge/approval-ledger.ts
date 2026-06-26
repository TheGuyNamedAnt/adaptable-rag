import { hashStableValue } from "../shared/stable-hash.js";
import type {
  RagSupportKnowledgeCandidate,
  RagSupportKnowledgeCandidateKind,
  RagSupportKnowledgeCandidateQueue
} from "./knowledge-candidate-queue.js";
import type { RagKnownIssueStatus, RagSupportEvidenceRef } from "./support-event.js";

export const RAG_SUPPORT_KNOWLEDGE_APPROVAL_LEDGER_SCHEMA_VERSION = 1;

const APPROVAL_ACTIONS = ["approve", "reject", "request_changes"] as const;

export type RagSupportKnowledgeApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type RagSupportKnowledgeApprovalDecisionStatus = "accepted" | "invalid";
export type RagSupportApprovedKnowledgeArtifactStatus = "approved_for_ingestion";
export type RagSupportApprovedKnowledgeArtifactVisibility = "internal" | "customer_safe" | "public";

export type RagSupportKnowledgeApprovalInvalidReason =
  | "missing_candidate_id"
  | "unknown_candidate"
  | "candidate_not_pending"
  | "duplicate_candidate_decision"
  | "unsupported_action"
  | "missing_reviewer_hash"
  | "missing_summary"
  | "empty_approved_body";

export interface RagSupportKnowledgeApprovalDecisionInput {
  readonly decisionId?: string;
  readonly candidateId: string;
  readonly action: RagSupportKnowledgeApprovalAction;
  readonly decidedAt?: string;
  readonly reviewerId?: string;
  readonly reviewerIdHash?: string;
  readonly summary: string;
  readonly approvedTitle?: string;
  readonly approvedBody?: string;
  readonly visibility?: RagSupportApprovedKnowledgeArtifactVisibility;
  readonly reasonCodes?: readonly string[];
  readonly followUpActions?: readonly string[];
  readonly metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export interface RagSupportKnowledgeApprovalLedgerInput {
  readonly ledgerId?: string;
  readonly generatedAt?: string;
  readonly queue: RagSupportKnowledgeCandidateQueue;
  readonly decisions?: readonly RagSupportKnowledgeApprovalDecisionInput[];
}

export interface RagSupportKnowledgeApprovalSourceQueueSnapshot {
  readonly queueId: string;
  readonly generatedAt: string;
  readonly status: RagSupportKnowledgeCandidateQueue["status"];
  readonly candidateCount: number;
  readonly pendingCandidateCount: number;
}

export interface RagSupportKnowledgeApprovalCandidateSnapshot {
  readonly candidateId: string;
  readonly candidateKey: string;
  readonly kind: RagSupportKnowledgeCandidateKind;
  readonly status: string;
  readonly priority: string;
  readonly title: string;
  readonly summary: string;
  readonly targetId?: string;
  readonly knownIssueStatus?: RagKnownIssueStatus;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceTicketIds: readonly string[];
  readonly traceIds: readonly string[];
}

export interface RagSupportApprovedKnowledgeArtifactCorpusAdmission {
  readonly currentRuntimeAnswerable: false;
  readonly approvedForIngestion: true;
  readonly answerableAfterIngestion: true;
  readonly requiredNextGate: "corpus_ingestion";
  readonly reason: string;
}

export interface RagSupportApprovedKnowledgeArtifactIngestionHint {
  readonly sourceId: string;
  readonly sourceKind: "derived_summary";
  readonly trustTier: "generated_or_derived";
  readonly sensitivity: "internal" | "public";
  readonly adapter: "approved_knowledge_artifact";
}

export interface RagSupportApprovedKnowledgeArtifact {
  readonly artifactId: string;
  readonly artifactKey: string;
  readonly status: RagSupportApprovedKnowledgeArtifactStatus;
  readonly kind: RagSupportKnowledgeCandidateKind;
  readonly title: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly visibility: RagSupportApprovedKnowledgeArtifactVisibility;
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly targetId?: string;
  readonly knownIssueStatus?: RagKnownIssueStatus;
  readonly sourceCandidateId: string;
  readonly sourceCandidateKey: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceIdempotencyKeys: readonly string[];
  readonly sourceTicketIds: readonly string[];
  readonly runIds: readonly string[];
  readonly traceIds: readonly string[];
  readonly payloadHashes: readonly string[];
  readonly evidenceRefs: readonly RagSupportEvidenceRef[];
  readonly approvedAt: string;
  readonly approvalDecisionId: string;
  readonly reviewerIdHash: string;
  readonly approvalSummary: string;
  readonly corpusAdmission: RagSupportApprovedKnowledgeArtifactCorpusAdmission;
  readonly ingestionHint: RagSupportApprovedKnowledgeArtifactIngestionHint;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RagSupportKnowledgeApprovalDecisionRecord {
  readonly decisionId: string;
  readonly candidateId: string;
  readonly candidateKey: string;
  readonly action: RagSupportKnowledgeApprovalAction;
  readonly status: RagSupportKnowledgeApprovalDecisionStatus;
  readonly decidedAt: string;
  readonly reviewerIdHash: string;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly followUpActions: readonly string[];
  readonly candidate: RagSupportKnowledgeApprovalCandidateSnapshot;
  readonly approvedArtifactId?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RagSupportKnowledgeApprovalInvalidDecision {
  readonly index: number;
  readonly candidateId?: string;
  readonly action?: string;
  readonly reasonCode: RagSupportKnowledgeApprovalInvalidReason;
  readonly reason: string;
}

export interface RagSupportKnowledgeApprovalLedgerMetrics {
  readonly decisionCount: number;
  readonly approvedDecisionCount: number;
  readonly rejectedDecisionCount: number;
  readonly changeRequestDecisionCount: number;
  readonly invalidDecisionCount: number;
  readonly approvedArtifactCount: number;
}

export interface RagSupportKnowledgeApprovalLedger {
  readonly schemaVersion: typeof RAG_SUPPORT_KNOWLEDGE_APPROVAL_LEDGER_SCHEMA_VERSION;
  readonly ledgerId: string;
  readonly generatedAt: string;
  readonly sourceQueue: RagSupportKnowledgeApprovalSourceQueueSnapshot;
  readonly decisions: readonly RagSupportKnowledgeApprovalDecisionRecord[];
  readonly approvedArtifacts: readonly RagSupportApprovedKnowledgeArtifact[];
  readonly invalidDecisions: readonly RagSupportKnowledgeApprovalInvalidDecision[];
  readonly metrics: RagSupportKnowledgeApprovalLedgerMetrics;
  readonly evidenceBoundary: readonly string[];
}

export function buildRagSupportKnowledgeApprovalLedger(
  input: RagSupportKnowledgeApprovalLedgerInput
): RagSupportKnowledgeApprovalLedger {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ledgerId =
    input.ledgerId ?? `rag_support_knowledge_approval_ledger_${safeTimestamp(generatedAt)}`;
  const candidatesById = new Map(
    input.queue.candidates.map((candidate) => [candidate.candidateId, candidate])
  );
  const decidedCandidateIds = new Set<string>();
  const decisions: RagSupportKnowledgeApprovalDecisionRecord[] = [];
  const approvedArtifacts: RagSupportApprovedKnowledgeArtifact[] = [];
  const invalidDecisions: RagSupportKnowledgeApprovalInvalidDecision[] = [];

  for (const [index, decision] of (input.decisions ?? []).entries()) {
    const invalid = validateDecisionInput(decision, index, candidatesById, decidedCandidateIds);
    if (invalid) {
      invalidDecisions.push(invalid);
      continue;
    }

    const candidate = candidatesById.get(decision.candidateId);
    if (!candidate) {
      invalidDecisions.push(
        invalidDecision(
          index,
          decision,
          "unknown_candidate",
          "Decision references an unknown candidate."
        )
      );
      continue;
    }

    const record = decisionRecord(decision, candidate, generatedAt, index);
    decisions.push(record);
    decidedCandidateIds.add(candidate.candidateId);

    if (decision.action === "approve") {
      approvedArtifacts.push(approvedArtifact(record, decision, candidate));
    }
  }

  return {
    schemaVersion: RAG_SUPPORT_KNOWLEDGE_APPROVAL_LEDGER_SCHEMA_VERSION,
    ledgerId,
    generatedAt,
    sourceQueue: {
      queueId: input.queue.queueId,
      generatedAt: input.queue.generatedAt,
      status: input.queue.status,
      candidateCount: input.queue.metrics.candidateCount,
      pendingCandidateCount: input.queue.metrics.pendingCandidateCount
    },
    decisions,
    approvedArtifacts,
    invalidDecisions,
    metrics: approvalMetrics(decisions, approvedArtifacts, invalidDecisions),
    evidenceBoundary: ragSupportKnowledgeApprovalLedgerEvidenceBoundary()
  };
}

export function ragSupportKnowledgeApprovalLedgerEvidenceBoundary(): readonly string[] {
  return [
    "Includes candidate ids, safe candidate snapshots, approval actions, hashed reviewer ids, redacted approval summaries, approved artifact text, source event ids, payload hashes, and evidence refs.",
    "Excludes raw customer messages, raw diagnostics, raw generated answers, rendered prompts, full source bodies, credentials, routing secrets, and raw reviewer identifiers.",
    "Approved artifacts are approved for ingestion only; the runtime must not answer from them until a separate corpus ingestion and indexing pass accepts them."
  ];
}

export function renderRagSupportKnowledgeApprovalLedgerMarkdown(
  ledger: RagSupportKnowledgeApprovalLedger
): string {
  return [
    "# Support Knowledge Approval Ledger",
    "",
    `- Ledger ID: \`${md(ledger.ledgerId)}\``,
    `- Generated: \`${md(ledger.generatedAt)}\``,
    `- Source queue: \`${md(ledger.sourceQueue.queueId)}\` (${md(ledger.sourceQueue.status)})`,
    "",
    "## Metrics",
    "",
    `- Decisions: ${ledger.metrics.decisionCount}`,
    `- Approved artifacts: ${ledger.metrics.approvedArtifactCount}`,
    `- Invalid decisions: ${ledger.metrics.invalidDecisionCount}`,
    "",
    "## Decisions",
    "",
    decisionTable(ledger.decisions),
    "",
    "## Approved Artifacts",
    "",
    artifactTable(ledger.approvedArtifacts),
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

function validateDecisionInput(
  decision: RagSupportKnowledgeApprovalDecisionInput,
  index: number,
  candidatesById: ReadonlyMap<string, RagSupportKnowledgeCandidate>,
  decidedCandidateIds: ReadonlySet<string>
): RagSupportKnowledgeApprovalInvalidDecision | undefined {
  if (!decision.candidateId || typeof decision.candidateId !== "string") {
    return invalidDecision(
      index,
      decision,
      "missing_candidate_id",
      "Decision is missing a candidate id."
    );
  }

  const candidate = candidatesById.get(decision.candidateId);
  if (!candidate) {
    return invalidDecision(
      index,
      decision,
      "unknown_candidate",
      "Decision references an unknown candidate."
    );
  }

  if (candidate.status !== "pending_review") {
    return invalidDecision(
      index,
      decision,
      "candidate_not_pending",
      "Decision references a candidate that is not pending review."
    );
  }

  if (decidedCandidateIds.has(decision.candidateId)) {
    return invalidDecision(
      index,
      decision,
      "duplicate_candidate_decision",
      "Only one accepted decision is allowed per candidate in a ledger build."
    );
  }

  if (!isApprovalAction(decision.action)) {
    return invalidDecision(
      index,
      decision,
      "unsupported_action",
      "Decision action is not supported."
    );
  }

  if (!decision.reviewerIdHash && !decision.reviewerId) {
    return invalidDecision(
      index,
      decision,
      "missing_reviewer_hash",
      "Decision is missing a reviewer identity hash."
    );
  }

  if (!decision.summary || safeText(decision.summary).length === 0) {
    return invalidDecision(
      index,
      decision,
      "missing_summary",
      "Decision is missing a reviewer summary."
    );
  }

  if (decision.action === "approve" && approvedBody(decision, candidate).length === 0) {
    return invalidDecision(
      index,
      decision,
      "empty_approved_body",
      "Approval did not produce safe artifact body text."
    );
  }

  return undefined;
}

function decisionRecord(
  decision: RagSupportKnowledgeApprovalDecisionInput,
  candidate: RagSupportKnowledgeCandidate,
  generatedAt: string,
  index: number
): RagSupportKnowledgeApprovalDecisionRecord {
  const decidedAt = decision.decidedAt ?? generatedAt;
  const decisionId =
    decision.decisionId ??
    `rag_support_knowledge_decision_${safeTimestamp(decidedAt)}_${safeId(candidate.candidateId)}_${index + 1}`;
  const artifactId =
    decision.action === "approve"
      ? `rag_approved_knowledge_${shortHash(`${decisionId}:${candidate.candidateKey}`)}`
      : undefined;

  return {
    decisionId,
    candidateId: candidate.candidateId,
    candidateKey: candidate.candidateKey,
    action: decision.action,
    status: "accepted",
    decidedAt,
    reviewerIdHash:
      decision.reviewerIdHash === undefined
        ? hashReviewerId(decision.reviewerId ?? "missing_reviewer")
        : safeId(decision.reviewerIdHash),
    summary: safeText(decision.summary),
    reasonCodes: uniqueSorted(decision.reasonCodes ?? []),
    followUpActions: safeStringList(decision.followUpActions),
    candidate: candidateSnapshot(candidate),
    ...(artifactId === undefined ? {} : { approvedArtifactId: artifactId }),
    metadata: safeMetadata(decision.metadata ?? {})
  };
}

function approvedArtifact(
  record: RagSupportKnowledgeApprovalDecisionRecord,
  decision: RagSupportKnowledgeApprovalDecisionInput,
  candidate: RagSupportKnowledgeCandidate
): RagSupportApprovedKnowledgeArtifact {
  const body = approvedBody(decision, candidate);
  const title = safeText(decision.approvedTitle ?? candidate.title);
  const bodyHash = `sha256:${hashStableValue(body)}`;
  const artifactKey = ["approved_knowledge", candidate.candidateKey, record.decisionId, bodyHash]
    .map(safeId)
    .join(":");
  const visibility = decision.visibility ?? "internal";
  const sourceId = candidate.profileId
    ? `approved_knowledge_${safeId(candidate.profileId)}`
    : "approved_knowledge";

  return {
    artifactId: record.approvedArtifactId ?? `rag_approved_knowledge_${shortHash(artifactKey)}`,
    artifactKey,
    status: "approved_for_ingestion",
    kind: candidate.kind,
    title,
    body,
    bodyHash,
    visibility,
    ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
    ...(candidate.namespaceId === undefined ? {} : { namespaceId: candidate.namespaceId }),
    ...(candidate.targetId === undefined ? {} : { targetId: candidate.targetId }),
    ...(candidate.knownIssueStatus === undefined
      ? {}
      : { knownIssueStatus: candidate.knownIssueStatus }),
    sourceCandidateId: candidate.candidateId,
    sourceCandidateKey: candidate.candidateKey,
    sourceEventIds: candidate.sourceEventIds,
    sourceIdempotencyKeys: candidate.sourceIdempotencyKeys,
    sourceTicketIds: candidate.sourceTicketIds,
    runIds: candidate.runIds,
    traceIds: candidate.traceIds,
    payloadHashes: candidate.payloadHashes,
    evidenceRefs: candidate.evidenceRefs,
    approvedAt: record.decidedAt,
    approvalDecisionId: record.decisionId,
    reviewerIdHash: record.reviewerIdHash,
    approvalSummary: record.summary,
    corpusAdmission: {
      currentRuntimeAnswerable: false,
      approvedForIngestion: true,
      answerableAfterIngestion: true,
      requiredNextGate: "corpus_ingestion",
      reason:
        "This artifact has human approval, but it must still pass corpus normalization, chunking, indexing, and access controls before retrieval."
    },
    ingestionHint: {
      sourceId,
      sourceKind: "derived_summary",
      trustTier: "generated_or_derived",
      sensitivity: visibility === "public" ? "public" : "internal",
      adapter: "approved_knowledge_artifact"
    },
    metadata: {
      candidateKind: candidate.kind,
      candidatePriority: candidate.priority,
      candidateReasonCodes: candidate.reasonCodes.join(","),
      approvalReasonCodes: record.reasonCodes.join(",")
    }
  };
}

function approvedBody(
  decision: RagSupportKnowledgeApprovalDecisionInput,
  candidate: RagSupportKnowledgeCandidate
): string {
  return safeText(decision.approvedBody ?? candidate.proposedWording ?? candidate.summary);
}

function candidateSnapshot(
  candidate: RagSupportKnowledgeCandidate
): RagSupportKnowledgeApprovalCandidateSnapshot {
  return {
    candidateId: candidate.candidateId,
    candidateKey: candidate.candidateKey,
    kind: candidate.kind,
    status: candidate.status,
    priority: candidate.priority,
    title: safeText(candidate.title),
    summary: safeText(candidate.summary),
    ...(candidate.targetId === undefined ? {} : { targetId: candidate.targetId }),
    ...(candidate.knownIssueStatus === undefined
      ? {}
      : { knownIssueStatus: candidate.knownIssueStatus }),
    ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
    ...(candidate.namespaceId === undefined ? {} : { namespaceId: candidate.namespaceId }),
    sourceEventIds: candidate.sourceEventIds,
    sourceTicketIds: candidate.sourceTicketIds,
    traceIds: candidate.traceIds
  };
}

function invalidDecision(
  index: number,
  decision: Partial<RagSupportKnowledgeApprovalDecisionInput>,
  reasonCode: RagSupportKnowledgeApprovalInvalidReason,
  reason: string
): RagSupportKnowledgeApprovalInvalidDecision {
  return {
    index,
    ...(decision.candidateId === undefined ? {} : { candidateId: safeId(decision.candidateId) }),
    ...(decision.action === undefined ? {} : { action: safeText(String(decision.action)) }),
    reasonCode,
    reason
  };
}

function approvalMetrics(
  decisions: readonly RagSupportKnowledgeApprovalDecisionRecord[],
  approvedArtifacts: readonly RagSupportApprovedKnowledgeArtifact[],
  invalidDecisions: readonly RagSupportKnowledgeApprovalInvalidDecision[]
): RagSupportKnowledgeApprovalLedgerMetrics {
  return {
    decisionCount: decisions.length,
    approvedDecisionCount: decisions.filter((decision) => decision.action === "approve").length,
    rejectedDecisionCount: decisions.filter((decision) => decision.action === "reject").length,
    changeRequestDecisionCount: decisions.filter(
      (decision) => decision.action === "request_changes"
    ).length,
    invalidDecisionCount: invalidDecisions.length,
    approvedArtifactCount: approvedArtifacts.length
  };
}

function decisionTable(decisions: readonly RagSupportKnowledgeApprovalDecisionRecord[]): string {
  if (decisions.length === 0) {
    return "_No accepted decisions._";
  }

  return [
    "| Decision | Candidate | Action | Reviewer | Artifact |",
    "| --- | --- | --- | --- | --- |",
    ...decisions.map(
      (decision) =>
        `| \`${md(decision.decisionId)}\` | \`${md(decision.candidateId)}\` | ${md(decision.action)} | \`${md(decision.reviewerIdHash)}\` | ${decision.approvedArtifactId ? `\`${md(decision.approvedArtifactId)}\`` : "none"} |`
    )
  ].join("\n");
}

function artifactTable(artifacts: readonly RagSupportApprovedKnowledgeArtifact[]): string {
  if (artifacts.length === 0) {
    return "_No approved artifacts._";
  }

  return [
    "| Artifact | Kind | Visibility | Runtime Answerable | Next Gate |",
    "| --- | --- | --- | --- | --- |",
    ...artifacts.map(
      (artifact) =>
        `| \`${md(artifact.artifactId)}\` | ${md(artifact.kind)} | ${md(artifact.visibility)} | no | ${md(artifact.corpusAdmission.requiredNextGate)} |`
    )
  ].join("\n");
}

function invalidDecisionTable(
  invalidDecisions: readonly RagSupportKnowledgeApprovalInvalidDecision[]
): string {
  if (invalidDecisions.length === 0) {
    return "_No invalid decisions._";
  }

  return [
    "| Index | Candidate | Reason |",
    "| --- | --- | --- |",
    ...invalidDecisions.map(
      (decision) =>
        `| ${decision.index} | ${decision.candidateId ? `\`${md(decision.candidateId)}\`` : "unknown"} | ${md(decision.reasonCode)} |`
    )
  ].join("\n");
}

function isApprovalAction(value: string): value is RagSupportKnowledgeApprovalAction {
  return APPROVAL_ACTIONS.some((action) => action === value);
}

function hashReviewerId(value: string): string {
  return `reviewer_${hashStableValue(`reviewer:${value}`).slice(0, 16)}`;
}

function safeStringList(values: readonly string[] | undefined): readonly string[] {
  return uniqueSorted((values ?? []).map(safeText).filter(Boolean));
}

function safeMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null | undefined>>
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        safeId(key),
        typeof value === "string" ? safeText(value) : (value ?? null)
      ])
  );
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
