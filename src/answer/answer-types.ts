import type { ContextBuildResult } from "../context/context-types.js";
import type { CitationPointer } from "../documents/provenance.js";
import type { ActionMode, OutputMode } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";

export type AnswerGateStatus = "ready" | "refused" | "human_review_required";

export type AnswerRefusalCode =
  | "no_evidence"
  | "insufficient_citations"
  | "insufficient_trusted_citations"
  | "generation_requires_evidence";

export type AnswerConfidence = "low" | "medium" | "high";

export type AnswerValidationSeverity = "error" | "warning";

export type AnswerValidationCode =
  | "empty_answer"
  | "refusal_required"
  | "missing_required_citation"
  | "unknown_citation"
  | "insufficient_citations"
  | "insufficient_trusted_citations"
  | "missing_evidence_summary"
  | "action_not_allowed"
  | "action_requires_approval"
  | "raw_context_leak"
  | "invalid_relationship_path_evidence"
  | "missing_relationship_edge_evidence";

export interface AnswerBuildRequest {
  readonly profile: ValidatedRagProfile;
  readonly context: ContextBuildResult;
  readonly question: string;
  readonly answerId?: string;
  readonly requestedAt?: string;
}

export interface AnswerRefusal {
  readonly code: AnswerRefusalCode;
  readonly message: string;
  readonly detail: string;
}

export interface AnswerGenerationContract {
  readonly schemaName: string;
  readonly outputMode: OutputMode;
  readonly requireStructuredOutput: boolean;
  readonly requireCitations: boolean;
  readonly requireEvidenceSummary: boolean;
  readonly allowedCitationChunkIds: readonly string[];
  readonly minimumCitations: number;
  readonly minimumTrustedCitations: number;
  readonly maxOutputTokens: number;
  readonly actionMode: ActionMode;
  readonly allowedActions: readonly string[];
  readonly requireApprovalFor: readonly string[];
}

export interface AnswerGenerationInput {
  readonly question: string;
  readonly contextText: string;
  readonly groundingRules: readonly string[];
  readonly contract: AnswerGenerationContract;
}

export interface AnswerGateTrace {
  readonly answerId: string;
  readonly contextId: string;
  readonly retrievalId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: AnswerGateStatus;
  readonly refusalCode?: AnswerRefusalCode;
  readonly contextBlockCount: number;
  readonly allowedCitationCount: number;
  readonly trustedCitationCount: number;
  readonly requiresHumanReview: boolean;
}

export interface AnswerGateResult {
  readonly status: AnswerGateStatus;
  readonly canGenerate: boolean;
  readonly requiresHumanReview: boolean;
  readonly refusal?: AnswerRefusal;
  readonly generation?: AnswerGenerationInput;
  readonly trace: AnswerGateTrace;
}

export interface SourcedAnswerDraft {
  readonly answer: string;
  readonly citationChunkIds: readonly string[];
  readonly citations?: readonly CitationPointer[];
  readonly evidenceSummary?: string;
  readonly confidence?: AnswerConfidence;
  readonly actions?: readonly string[];
  readonly refusal?: AnswerRefusal;
}

export interface AnswerValidationRequest {
  readonly profile: ValidatedRagProfile;
  readonly context: ContextBuildResult;
  readonly draft: SourcedAnswerDraft;
  readonly requestedAt?: string;
}

export interface AnswerValidationIssue {
  readonly severity: AnswerValidationSeverity;
  readonly code: AnswerValidationCode;
  readonly path: string;
  readonly message: string;
  readonly chunkId?: string;
  readonly action?: string;
}

export interface AnswerValidationTrace {
  readonly contextId: string;
  readonly retrievalId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly citedChunkIds: readonly string[];
  readonly unknownCitationChunkIds: readonly string[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly relationshipPathCitationCount: number;
  readonly relationshipPathEdgeCount: number;
  readonly relationshipPathMaxDepth: number;
  readonly invalidRelationshipPathCount: number;
  readonly missingRelationshipEdgeEvidenceCount: number;
}

export interface AnswerValidationResult {
  readonly valid: boolean;
  readonly issues: readonly AnswerValidationIssue[];
  readonly errors: readonly AnswerValidationIssue[];
  readonly warnings: readonly AnswerValidationIssue[];
  readonly citedChunkIds: readonly string[];
  readonly unknownCitationChunkIds: readonly string[];
  readonly trace: AnswerValidationTrace;
}
