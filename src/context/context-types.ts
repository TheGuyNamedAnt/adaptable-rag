import type { RagChunk } from "../documents/chunk.js";
import type { CitationPointer, SourceProvenance } from "../documents/provenance.js";
import type { TrustTier } from "../documents/trust-tier.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RetrievalCandidate, RetrievalResult } from "../retrieval/retrieval-types.js";

export type ContextRejectionCode =
  | "duplicate_chunk"
  | "namespace_mismatch"
  | "missing_exact_citation"
  | "disallowed_source_kind"
  | "disallowed_trust_tier"
  | "missing_freshness_metadata"
  | "stale_source"
  | "unsafe_prompt_injection"
  | "unsafe_secret"
  | "citation_duplicate"
  | "lexical_duplicate"
  | "secondary_source_duplicate"
  | "context_chunk_limit_exceeded"
  | "context_token_limit_exceeded";

export type ContextEvidenceStatus =
  | "answerable"
  | "no_evidence"
  | "insufficient_citations"
  | "insufficient_trusted_citations";

export interface ContextBuildRequest {
  readonly profile: ValidatedRagProfile;
  readonly retrieval: RetrievalResult;
  readonly maxContextTokens?: number;
  readonly includeRejected?: boolean;
  readonly contextId?: string;
  readonly requestedAt?: string;
}

export interface ContextBlock {
  readonly index: number;
  readonly boundaryLabel: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly namespaceId: string;
  readonly text: string;
  readonly textHash: string;
  readonly tokenEstimate: number;
  readonly score: number;
  readonly retrievalRank: number;
  readonly matchedTerms: readonly string[];
  readonly citation: CitationPointer;
  readonly graphEvidence?: RetrievalCandidate["graphEvidence"];
  readonly provenance: SourceProvenance;
  readonly safetyFlags: RagChunk["safetyFlags"];
  readonly requiresHumanReview: boolean;
  readonly redacted: boolean;
}

export interface ContextRejection {
  readonly code: ContextRejectionCode;
  readonly reason: string;
  readonly chunkId?: string;
  readonly documentId?: string;
}

export interface ContextEvidenceSummary {
  readonly status: ContextEvidenceStatus;
  readonly canAttemptAnswer: boolean;
  readonly blockCount: number;
  readonly citationCount: number;
  readonly trustedCitationCount: number;
  readonly requiresHumanReviewCount: number;
  readonly sourceIds: readonly string[];
  readonly trustTiers: readonly TrustTier[];
}

export interface ContextTrace {
  readonly contextId: string;
  readonly retrievalId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidateCount: number;
  readonly blockCount: number;
  readonly rejectedCount: number;
  readonly totalTokenEstimate: number;
  readonly redactionCount: number;
  readonly maxContextTokens: number;
  readonly maxContextChunks: number;
  readonly sourceIds: readonly string[];
  readonly chunkIds: readonly string[];
  readonly rejectionCodes: readonly ContextRejectionCode[];
  readonly graphEvidencePathCount?: number;
  readonly graphEvidenceMaxDepth?: number;
  readonly graphEvidenceEdgeCount?: number;
  readonly optimizer?: ContextOptimizerTrace;
}

export interface ContextOptimizerTrace {
  readonly inputCandidateCount: number;
  readonly outputCandidateCount: number;
  readonly citationDuplicateCount: number;
  readonly lexicalDuplicateCount: number;
  readonly secondarySourceDuplicateCount: number;
  readonly tableAwareCandidateCount: number;
  readonly contradictionClusterCount: number;
  readonly sourceDiversityCount: number;
}

export interface ContextBuildResult {
  readonly blocks: readonly ContextBlock[];
  readonly citations: readonly CitationPointer[];
  readonly rejected: readonly ContextRejection[];
  readonly evidence: ContextEvidenceSummary;
  readonly trace: ContextTrace;
  readonly totalTokenEstimate: number;
}

export interface ContextCandidateAssessment {
  readonly candidate: RetrievalCandidate;
  readonly text: string;
  readonly tokenEstimate: number;
  readonly redacted: boolean;
  readonly redactionCount: number;
}
