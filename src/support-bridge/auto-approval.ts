import type {
  RagSupportApprovedKnowledgeArtifactVisibility,
  RagSupportKnowledgeApprovalDecisionInput
} from "./approval-ledger.js";
import type {
  RagSupportKnowledgeCandidate,
  RagSupportKnowledgeCandidateKind,
  RagSupportKnowledgeCandidateQueue
} from "./knowledge-candidate-queue.js";
import type { RagKnownIssueStatus } from "./support-event.js";

export const RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION = 1;

const DEFAULT_ALLOWED_KINDS = [
  "known_issue_candidate",
  "known_issue_status_update"
] as const satisfies readonly RagSupportKnowledgeCandidateKind[];

const DEFAULT_ALLOWED_KNOWN_ISSUE_STATUSES = [
  "candidate",
  "confirmed",
  "in_progress",
  "fixed",
  "verified",
  "duplicate",
  "blocked"
] as const satisfies readonly RagKnownIssueStatus[];

const DEFAULT_CUSTOMER_SAFE_STATUSES = [
  "confirmed",
  "in_progress",
  "fixed",
  "verified",
  "blocked"
] as const satisfies readonly RagKnownIssueStatus[];

export type RagSupportAutoApprovalSkipReason =
  | "policy_disabled"
  | "explicit_decision_exists"
  | "candidate_not_pending"
  | "kind_not_allowed"
  | "missing_known_issue_status"
  | "known_issue_status_not_allowed"
  | "max_decisions_reached";

export interface RagSupportAutoApprovalPolicyInput {
  readonly enabled?: boolean;
  readonly reviewerIdHash?: string;
  readonly maxDecisions?: number;
  readonly allowedKinds?: readonly RagSupportKnowledgeCandidateKind[];
  readonly allowedKnownIssueStatuses?: readonly RagKnownIssueStatus[];
  readonly customerSafeStatuses?: readonly RagKnownIssueStatus[];
}

export interface RagSupportAutoApprovalSkippedCandidate {
  readonly candidateId: string;
  readonly kind: RagSupportKnowledgeCandidateKind;
  readonly targetId?: string;
  readonly knownIssueStatus?: RagKnownIssueStatus;
  readonly reasonCode: RagSupportAutoApprovalSkipReason;
  readonly reason: string;
}

export interface RagSupportAutoApprovalMetrics {
  readonly candidateCount: number;
  readonly explicitDecisionCandidateCount: number;
  readonly decisionCount: number;
  readonly skippedCandidateCount: number;
}

export interface RagSupportAutoApprovalResult {
  readonly policyVersion: typeof RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION;
  readonly enabled: boolean;
  readonly generatedAt: string;
  readonly decisions: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly skippedCandidates: readonly RagSupportAutoApprovalSkippedCandidate[];
  readonly metrics: RagSupportAutoApprovalMetrics;
  readonly evidenceBoundary: readonly string[];
}

export interface BuildRagSupportAutoApprovalDecisionsInput {
  readonly generatedAt?: string;
  readonly queue: RagSupportKnowledgeCandidateQueue;
  readonly policy?: RagSupportAutoApprovalPolicyInput;
  readonly explicitlyDecidedCandidateIds?: ReadonlySet<string> | readonly string[];
}

export function buildRagSupportAutoApprovalDecisions(
  input: BuildRagSupportAutoApprovalDecisionsInput
): RagSupportAutoApprovalResult {
  const generatedAt = input.generatedAt ?? input.queue.generatedAt;
  const policy = normalizedPolicy(input.policy);
  const explicitlyDecidedCandidateIds = new Set(input.explicitlyDecidedCandidateIds ?? []);

  if (!policy.enabled) {
    return autoApprovalResult({
      enabled: false,
      generatedAt,
      candidateCount: input.queue.candidates.length,
      explicitDecisionCandidateCount: explicitlyDecidedCandidateIds.size,
      decisions: [],
      skippedCandidates: []
    });
  }

  const decisions: RagSupportKnowledgeApprovalDecisionInput[] = [];
  const skippedCandidates: RagSupportAutoApprovalSkippedCandidate[] = [];

  for (const candidate of input.queue.candidates) {
    if (explicitlyDecidedCandidateIds.has(candidate.candidateId)) {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "explicit_decision_exists",
          "A reviewer or upstream system already supplied a decision for this candidate."
        )
      );
      continue;
    }

    if (candidate.status !== "pending_review") {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "candidate_not_pending",
          "Only pending review candidates can be auto-approved."
        )
      );
      continue;
    }

    if (!policy.allowedKinds.has(candidate.kind)) {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "kind_not_allowed",
          "This candidate kind is not safe for automatic ticket-to-RAG promotion."
        )
      );
      continue;
    }

    const knownIssueStatus = normalizedKnownIssueStatus(candidate);
    if (knownIssueStatus === undefined) {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "missing_known_issue_status",
          "Known issue auto-approval requires an explicit known issue status."
        )
      );
      continue;
    }

    if (!policy.allowedKnownIssueStatuses.has(knownIssueStatus)) {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "known_issue_status_not_allowed",
          "This known issue status is not safe for automatic ticket-to-RAG promotion."
        )
      );
      continue;
    }

    if (decisions.length >= policy.maxDecisions) {
      skippedCandidates.push(
        skippedCandidate(
          candidate,
          "max_decisions_reached",
          "The auto-approval policy decision limit was reached."
        )
      );
      continue;
    }

    decisions.push(autoApprovalDecision(candidate, knownIssueStatus, generatedAt, policy));
  }

  return autoApprovalResult({
    enabled: true,
    generatedAt,
    candidateCount: input.queue.candidates.length,
    explicitDecisionCandidateCount: explicitlyDecidedCandidateIds.size,
    decisions,
    skippedCandidates
  });
}

export function ragSupportAutoApprovalEvidenceBoundary(): readonly string[] {
  return [
    "Includes candidate ids, candidate kinds, known issue statuses, target ids, deterministic auto-approval decisions, safe canned approved bodies, and policy skip reasons.",
    "Excludes raw tickets, raw customer messages, raw diagnostics, raw reply drafts, freeform ticket notes, route/macro/eval/corpus update promotion, secrets, and raw actor identifiers.",
    "Automatic approval is limited to structured known issue candidate and status updates; every approved artifact still requires the separate production ingestion gate before it becomes answerable."
  ];
}

function normalizedPolicy(policy: RagSupportAutoApprovalPolicyInput | undefined): {
  readonly enabled: boolean;
  readonly reviewerIdHash: string;
  readonly maxDecisions: number;
  readonly allowedKinds: ReadonlySet<RagSupportKnowledgeCandidateKind>;
  readonly allowedKnownIssueStatuses: ReadonlySet<RagKnownIssueStatus>;
  readonly customerSafeStatuses: ReadonlySet<RagKnownIssueStatus>;
} {
  return {
    enabled: policy?.enabled ?? false,
    reviewerIdHash:
      safeId(policy?.reviewerIdHash ?? "auto_support_ticket_sync") || "auto_support_ticket_sync",
    maxDecisions: positiveInteger(policy?.maxDecisions ?? 1000),
    allowedKinds: new Set(policy?.allowedKinds ?? DEFAULT_ALLOWED_KINDS),
    allowedKnownIssueStatuses: new Set(
      policy?.allowedKnownIssueStatuses ?? DEFAULT_ALLOWED_KNOWN_ISSUE_STATUSES
    ),
    customerSafeStatuses: new Set(policy?.customerSafeStatuses ?? DEFAULT_CUSTOMER_SAFE_STATUSES)
  };
}

function autoApprovalDecision(
  candidate: RagSupportKnowledgeCandidate,
  knownIssueStatus: RagKnownIssueStatus,
  generatedAt: string,
  policy: {
    readonly reviewerIdHash: string;
    readonly customerSafeStatuses: ReadonlySet<RagKnownIssueStatus>;
  }
): RagSupportKnowledgeApprovalDecisionInput {
  return {
    decisionId: `auto_support_sync_${safeId(candidate.candidateId)}`,
    candidateId: candidate.candidateId,
    action: "approve",
    decidedAt: generatedAt,
    reviewerIdHash: policy.reviewerIdHash,
    summary: `Auto-approved structured support ticket update for ${candidate.kind}/${knownIssueStatus}.`,
    approvedTitle: approvedTitle(candidate, knownIssueStatus),
    approvedBody: approvedBody(knownIssueStatus),
    visibility: visibilityForStatus(knownIssueStatus, policy.customerSafeStatuses),
    reasonCodes: [
      "auto_ticket_sync",
      "structured_support_event",
      `known_issue_status_${knownIssueStatus}`
    ],
    metadata: {
      autoApproved: true,
      autoApprovalPolicyVersion: RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION,
      source: "support-ticket-cli-sync",
      candidateKind: candidate.kind,
      knownIssueStatus
    }
  };
}

function approvedTitle(
  candidate: RagSupportKnowledgeCandidate,
  knownIssueStatus: RagKnownIssueStatus
): string {
  const target =
    candidate.targetId === undefined ? "" : ` for ${safeTitleText(candidate.targetId)}`;
  return `Known issue ${statusLabel(knownIssueStatus)}${target}`;
}

function approvedBody(knownIssueStatus: RagKnownIssueStatus): string {
  switch (knownIssueStatus) {
    case "candidate":
      return "Support has detected a possible repeated issue. Treat this as an internal investigation signal until confirmed.";
    case "confirmed":
      return "We are aware of this issue and are tracking it.";
    case "in_progress":
      return "We know this problem exists and are investigating a fix.";
    case "fixed":
      return "This issue has a fix recorded in linked support evidence.";
    case "verified":
      return "This issue has been verified as resolved in linked support evidence.";
    case "duplicate":
      return "This appears related to a known repeated issue. Support is checking the linked reports.";
    case "blocked":
      return "We are still investigating this and need more review before promising a fix.";
    case "closed":
    case "rejected":
      return "This known issue status is not approved for automatic customer-facing use.";
  }
}

function visibilityForStatus(
  knownIssueStatus: RagKnownIssueStatus,
  customerSafeStatuses: ReadonlySet<RagKnownIssueStatus>
): RagSupportApprovedKnowledgeArtifactVisibility {
  return customerSafeStatuses.has(knownIssueStatus) ? "customer_safe" : "internal";
}

function normalizedKnownIssueStatus(
  candidate: RagSupportKnowledgeCandidate
): RagKnownIssueStatus | undefined {
  if (candidate.knownIssueStatus !== undefined) {
    return candidate.knownIssueStatus;
  }

  if (candidate.kind === "known_issue_candidate") {
    return "candidate";
  }

  return undefined;
}

function skippedCandidate(
  candidate: RagSupportKnowledgeCandidate,
  reasonCode: RagSupportAutoApprovalSkipReason,
  reason: string
): RagSupportAutoApprovalSkippedCandidate {
  return {
    candidateId: candidate.candidateId,
    kind: candidate.kind,
    ...(candidate.targetId === undefined ? {} : { targetId: candidate.targetId }),
    ...(candidate.knownIssueStatus === undefined
      ? {}
      : { knownIssueStatus: candidate.knownIssueStatus }),
    reasonCode,
    reason
  };
}

function autoApprovalResult(input: {
  readonly enabled: boolean;
  readonly generatedAt: string;
  readonly candidateCount: number;
  readonly explicitDecisionCandidateCount: number;
  readonly decisions: readonly RagSupportKnowledgeApprovalDecisionInput[];
  readonly skippedCandidates: readonly RagSupportAutoApprovalSkippedCandidate[];
}): RagSupportAutoApprovalResult {
  return {
    policyVersion: RAG_SUPPORT_AUTO_APPROVAL_POLICY_VERSION,
    enabled: input.enabled,
    generatedAt: input.generatedAt,
    decisions: input.decisions,
    skippedCandidates: input.skippedCandidates,
    metrics: {
      candidateCount: input.candidateCount,
      explicitDecisionCandidateCount: input.explicitDecisionCandidateCount,
      decisionCount: input.decisions.length,
      skippedCandidateCount: input.skippedCandidates.length
    },
    evidenceBoundary: ragSupportAutoApprovalEvidenceBoundary()
  };
}

function statusLabel(status: RagKnownIssueStatus): string {
  return status.replace(/_/gu, " ");
}

function safeId(value: string): string {
  return value
    .replace(/[^0-9A-Za-z_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function safeTitleText(value: string): string {
  return value
    .replace(/[^0-9A-Za-z_ -]+/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

function positiveInteger(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1000;
}
