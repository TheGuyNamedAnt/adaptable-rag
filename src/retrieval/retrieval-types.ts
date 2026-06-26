import type { RagChunk } from "../documents/chunk.js";
import type { CitationPointer } from "../documents/provenance.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { IndexTraceFilter } from "../indexing/index-filter.js";
import type { RetrievalGraphPathEvidence } from "./graph-evidence.js";
import type { RerankTrace } from "./reranker.js";

export type RetrievalMode = "keyword" | "vector" | "hybrid" | "visual";

export type RetrievalRejectionCode =
  | "no_keyword_match"
  | "no_vector_match"
  | "no_hybrid_match"
  | "no_visual_match"
  | "empty_query"
  | "invalid_filter"
  | "access_denied_or_missing_chunk"
  | "stale_vector"
  | "vector_dimension_mismatch"
  | "candidate_limit_exceeded"
  | "rerank_unknown_candidate"
  | "rerank_invalid_score"
  | "model_rerank_failed";

export interface RetrievalRequest {
  readonly query: string;
  readonly filter: IndexFilter;
  readonly topK: number;
  readonly mode?: RetrievalMode;
  readonly candidatePoolLimit?: number;
  readonly graph?: RetrievalGraphRequestControls;
  readonly includeRejected?: boolean;
  readonly retrievalId?: string;
  readonly requestedAt?: string;
}

export interface RetrievalGraphRequestControls {
  readonly enabled?: boolean;
  readonly entityLimit?: number;
  readonly neighborLimit?: number;
  readonly maxDepth?: number;
  readonly maxVisitedEntities?: number;
  readonly entityHints?: readonly string[];
  readonly relationKinds?: readonly string[];
  readonly direction?: RetrievalGraphDirection;
  readonly executionMode?: RetrievalGraphExecutionMode;
}

export type RetrievalGraphDirection = "any" | "outgoing" | "incoming";
export type RetrievalGraphExecutionMode = "expand" | "graph_first";

export interface RetrievalGraphBudgetTraceControls extends Omit<
  RetrievalGraphRequestControls,
  "entityHints"
> {
  readonly entityHintCount?: number;
  readonly entityHintHashes?: readonly string[];
}

export interface RetrievalCandidate {
  readonly chunk: RagChunk;
  readonly score: number;
  readonly rank: number;
  readonly matchedTerms: readonly string[];
  readonly citation: CitationPointer;
  readonly reasons: readonly string[];
  readonly graphEvidence?: RetrievalGraphPathEvidence;
}

export interface RetrievalRejection {
  readonly chunkId?: string;
  readonly code: RetrievalRejectionCode;
  readonly reason: string;
}

export interface RetrievalTrace {
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: RetrievalMode;
  readonly queryHash: string;
  readonly normalizedQueryHash: string;
  readonly searchTermHashes: readonly string[];
  readonly access: IndexTraceFilter;
  readonly candidatePoolSize: number;
  readonly returnedCount: number;
  readonly rejectedCount: number;
  readonly graphTraversalDepth?: number;
  readonly graphVisitedEntityCount?: number;
  readonly graphTraversedEdgeCount?: number;
  readonly rerankId?: string;
  readonly fusionStrategy?: string;
  readonly childRetrievalIds?: readonly string[];
  readonly plannedQueryHashes?: readonly string[];
  readonly retrievalBudget?: RetrievalBudgetTrace;
  readonly adaptiveStrategy?: RetrievalStrategyTrace;
}

export type AdaptiveRetrievalStrategy =
  | "keyword_only"
  | "vector_only"
  | "hybrid"
  | "graph_augmented"
  | "visual_retrieval"
  | "expanded_candidate_pool"
  | "refuse_missing_or_denied";

export type RetrievalDiagnosisCode =
  | "sufficient_candidates"
  | "insufficient_candidates"
  | "empty_query"
  | "invalid_filter"
  | "access_denied_or_missing_source"
  | "graph_requested"
  | "visual_requested"
  | "trusted_citation_risk"
  | "stale_or_missing_source"
  | "retriever_error";

export interface RetrievalDiagnosis {
  readonly code: RetrievalDiagnosisCode;
  readonly reason: string;
  readonly candidateCount: number;
  readonly rejectedCount: number;
  readonly trustedCandidateCount: number;
}

export interface RetrievalStrategyTrace {
  readonly initialStrategy: AdaptiveRetrievalStrategy;
  readonly reason: string;
  readonly diagnosis: RetrievalDiagnosis;
  readonly retryStrategy?: AdaptiveRetrievalStrategy;
  readonly retryReason?: string;
  readonly finalDecision: "answerable" | "retried_answerable" | "insufficient_evidence" | "refused";
  readonly attemptedStrategies: readonly AdaptiveRetrievalStrategy[];
}

export interface RetrievalBudgetTrace {
  readonly strategy: string;
  readonly requestedTopK: number;
  readonly maxRetrievalCalls: number;
  readonly enabledQueryCount: number;
  readonly totalCandidatePoolLimit?: number;
  readonly disabledQueryIds: readonly string[];
  readonly branches: readonly RetrievalBudgetBranchTrace[];
}

export interface RetrievalBudgetBranchTrace {
  readonly plannedQueryId: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly topK: number;
  readonly fusionWeight: number;
  readonly candidatePoolLimit?: number;
  readonly graph?: RetrievalGraphBudgetTraceControls;
  readonly reasons: readonly string[];
}

export interface RetrievalResult {
  readonly query: string;
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly RetrievalRejection[];
  readonly trace: RetrievalTrace;
  readonly rerank?: RerankTrace;
}
