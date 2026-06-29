export interface AdminAnswerRequest {
  readonly question: string;
  readonly tenantId: string;
  readonly namespaceId?: string;
  readonly principal: {
    readonly userId: string;
    readonly tenantId: string;
    readonly namespaceIds: readonly string[];
    readonly teamIds: readonly string[];
    readonly roles: readonly string[];
    readonly tags: readonly string[];
  };
  readonly filters?: {
    readonly sourceIds?: readonly string[];
    readonly documentIds?: readonly string[];
    readonly chunkIds?: readonly string[];
    readonly sourceKinds?: readonly string[];
    readonly trustTiers?: readonly string[];
    readonly accessTags?: readonly string[];
    readonly limit?: number;
  };
  readonly topK?: number;
  readonly candidatePoolLimit?: number;
  readonly includeRejected?: boolean;
  readonly runId?: string;
  readonly traceId?: string;
}

export interface AdminAnswerResponse {
  readonly status: string;
  readonly answer?: string;
  readonly citationChunkIds?: readonly string[];
  readonly citations?: readonly CitationPointer[];
  readonly evidenceSummary?: string;
  readonly confidence?: string;
  readonly refusal?: unknown;
  readonly failure?: {
    readonly stage?: string;
    readonly errorName?: string;
    readonly message?: string;
  };
  readonly trace: RagRunTrace;
  readonly retrieval?: {
    readonly trace?: RetrievalTrace;
  };
  readonly context?: {
    readonly evidence?: ContextEvidenceSummary;
    readonly trace?: ContextTrace;
  };
  readonly generation?: {
    readonly trace?: GenerationTrace;
    readonly warnings?: unknown;
  };
}

export interface CitationPointer {
  readonly sourceId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly locator?: string;
  readonly visualAssetId?: string;
  readonly pageNumber?: number;
}

export interface RagRunTrace {
  readonly runId: string;
  readonly traceId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: string;
  readonly questionHash: string;
  readonly queryPlanId?: string;
  readonly plannedQueryHashes: readonly string[];
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly answerId?: string;
  readonly generationId?: string;
  readonly modelRequestId?: string;
  readonly retrievedChunkIds: readonly string[];
  readonly rejectedChunkIds: readonly string[];
  readonly finalCitations: readonly CitationPointer[];
  readonly safetyFlags: readonly string[];
  readonly events: readonly TraceEvent[];
}

export interface TraceEvent {
  readonly runId: string;
  readonly traceId: string;
  readonly kind: string;
  readonly at: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RetrievalTrace {
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: string;
  readonly queryHash: string;
  readonly normalizedQueryHash: string;
  readonly searchTermHashes: readonly string[];
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

export interface RetrievalStrategyTrace {
  readonly initialStrategy: string;
  readonly reason: string;
  readonly diagnosis: {
    readonly code: string;
    readonly reason: string;
    readonly candidateCount: number;
    readonly rejectedCount: number;
    readonly trustedCandidateCount: number;
  };
  readonly retryStrategy?: string;
  readonly retryReason?: string;
  readonly finalDecision: string;
  readonly attemptedStrategies: readonly string[];
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
  readonly reasons: readonly string[];
}

export interface ContextEvidenceSummary {
  readonly status: string;
  readonly canAttemptAnswer: boolean;
  readonly blockCount: number;
  readonly citationCount: number;
  readonly trustedCitationCount: number;
  readonly requiresHumanReviewCount: number;
  readonly sourceIds: readonly string[];
  readonly trustTiers: readonly string[];
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
  readonly rejectionCodes: readonly string[];
  readonly graphEvidencePathCount?: number;
  readonly graphEvidenceMaxDepth?: number;
  readonly graphEvidenceEdgeCount?: number;
  readonly optimizer?: {
    readonly inputCandidateCount: number;
    readonly outputCandidateCount: number;
    readonly citationDuplicateCount: number;
    readonly lexicalDuplicateCount: number;
    readonly secondarySourceDuplicateCount: number;
    readonly tableAwareCandidateCount: number;
    readonly contradictionClusterCount: number;
    readonly sourceDiversityCount: number;
  };
}

export interface GenerationTrace {
  readonly generationId?: string;
  readonly answerId?: string;
  readonly contextId?: string;
  readonly retrievalId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly gateStatus?: string;
  readonly validationErrorCount?: number;
  readonly warningCount?: number;
  readonly model?: {
    readonly attempted?: boolean;
    readonly provider?: string;
    readonly modelName?: string;
    readonly requestId?: string;
  };
}

export interface AdminAnswerError {
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}
