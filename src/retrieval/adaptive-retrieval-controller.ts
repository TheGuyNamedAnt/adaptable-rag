import type { TrustTier } from "../documents/trust-tier.js";
import type {
  AdaptiveRetrievalStrategy,
  RetrievalDiagnosis,
  RetrievalDiagnosisCode,
  RetrievalRequest,
  RetrievalResult,
  RetrievalStrategyTrace
} from "./retrieval-types.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";

export interface AdaptiveRetrievalControllerOptions {
  readonly retriever: Retriever;
  readonly minCandidates?: number;
  readonly trustedTrustTiers?: readonly TrustTier[];
  readonly maxExpandedCandidatePoolLimit?: number;
  readonly now?: () => string;
}

const DEFAULT_TRUSTED_TIERS: readonly TrustTier[] = ["trusted_internal", "verified_partner"];

export class AdaptiveRetrievalController implements Retriever {
  readonly capabilities: RetrieverCapabilities;

  private readonly retriever: Retriever;
  private readonly minCandidates: number;
  private readonly trustedTrustTiers: readonly TrustTier[];
  private readonly maxExpandedCandidatePoolLimit: number;

  constructor(options: AdaptiveRetrievalControllerOptions) {
    this.retriever = options.retriever;
    this.capabilities = options.retriever.capabilities;
    this.minCandidates = options.minCandidates ?? 1;
    this.trustedTrustTiers = options.trustedTrustTiers ?? DEFAULT_TRUSTED_TIERS;
    this.maxExpandedCandidatePoolLimit = options.maxExpandedCandidatePoolLimit ?? 5000;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const initialStrategy = initialStrategyForRequest(request, this.capabilities);
    const initial = await this.retriever.retrieve(request);
    const initialDiagnosis = this.diagnose(initial, request);

    if (!shouldRetry(initialDiagnosis, request, this.capabilities)) {
      return withStrategyTrace(initial, {
        initialStrategy,
        reason: reasonForInitialStrategy(request, this.capabilities),
        diagnosis: initialDiagnosis,
        finalDecision: finalDecisionForDiagnosis(initialDiagnosis),
        attemptedStrategies: [initialStrategy]
      });
    }

    const retry = targetedRetryForDiagnosis(
      initialDiagnosis,
      request,
      this.capabilities,
      this.maxExpandedCandidatePoolLimit
    );
    if (retry === undefined) {
      return withStrategyTrace(initial, {
        initialStrategy,
        reason: reasonForInitialStrategy(request, this.capabilities),
        diagnosis: initialDiagnosis,
        finalDecision: finalDecisionForDiagnosis(initialDiagnosis),
        attemptedStrategies: [initialStrategy]
      });
    }

    const retryResult = await this.retriever.retrieve(retry.request);
    const retryDiagnosis = this.diagnose(retryResult, retry.request);
    const selected = betterResult(initial, initialDiagnosis, retryResult, retryDiagnosis);
    const selectedDiagnosis = selected === retryResult ? retryDiagnosis : initialDiagnosis;

    return withStrategyTrace(selected, {
      initialStrategy,
      reason: reasonForInitialStrategy(request, this.capabilities),
      diagnosis: selectedDiagnosis,
      retryStrategy: retry.strategy,
      retryReason: initialDiagnosis.reason,
      finalDecision:
        selected === retryResult && retryDiagnosis.code === "sufficient_candidates"
          ? "retried_answerable"
          : finalDecisionForDiagnosis(selectedDiagnosis),
      attemptedStrategies: [initialStrategy, retry.strategy]
    });
  }

  private diagnose(result: RetrievalResult, request: RetrievalRequest): RetrievalDiagnosis {
    const trustedCandidateCount = result.candidates.filter((candidate) =>
      this.trustedTrustTiers.includes(candidate.chunk.provenance.trustTier)
    ).length;
    const code = diagnosisCode(result, request, this.minCandidates, trustedCandidateCount);
    return {
      code,
      reason: diagnosisReason(code, request, this.minCandidates),
      candidateCount: result.candidates.length,
      rejectedCount: result.rejected.length,
      trustedCandidateCount
    };
  }
}

function initialStrategyForRequest(
  request: RetrievalRequest,
  capabilities: RetrieverCapabilities
): AdaptiveRetrievalStrategy {
  if (request.graph?.enabled === true && capabilities.supportsGraphSearch === true) {
    return "graph_augmented";
  }
  switch (request.mode) {
    case "keyword":
      return "keyword_only";
    case "vector":
      return "vector_only";
    case "visual":
      return "visual_retrieval";
    case "hybrid":
    case undefined:
      return capabilities.supportsHybridSearch ? "hybrid" : "keyword_only";
    default:
      return "keyword_only";
  }
}

function reasonForInitialStrategy(
  request: RetrievalRequest,
  capabilities: RetrieverCapabilities
): string {
  if (request.graph?.enabled === true && capabilities.supportsGraphSearch === true) {
    return "question_or_plan_requested_graph_evidence";
  }
  if (request.mode === "visual") {
    return "retrieval_mode_is_visual";
  }
  if (request.mode === "hybrid") {
    return "retrieval_mode_is_hybrid";
  }
  if (request.mode === "vector") {
    return "retrieval_mode_is_vector";
  }
  if (request.mode === "keyword") {
    return "retrieval_mode_is_keyword";
  }
  return "retrieval_mode_inferred_from_retriever_capabilities";
}

function diagnosisCode(
  result: RetrievalResult,
  request: RetrievalRequest,
  minCandidates: number,
  trustedCandidateCount: number
): RetrievalDiagnosisCode {
  if (result.rejected.some((rejection) => rejection.code === "empty_query")) {
    return "empty_query";
  }
  if (result.rejected.some((rejection) => rejection.code === "invalid_filter")) {
    return "invalid_filter";
  }
  if (result.rejected.some((rejection) => rejection.code === "access_denied_or_missing_chunk")) {
    return "access_denied_or_missing_source";
  }
  if (result.rejected.some((rejection) => rejection.code === "stale_vector")) {
    return "stale_or_missing_source";
  }
  if (
    freshnessEvidenceRequested(request) &&
    result.candidates.length < Math.min(request.topK, minCandidates)
  ) {
    return "freshness_requested";
  }
  if (visualEvidenceRequested(request) && result.candidates.length === 0) {
    return "visual_requested";
  }
  if (
    graphEvidenceRequested(request) &&
    !result.candidates.some((candidate) => candidate.graphEvidence)
  ) {
    return "graph_requested";
  }
  if (result.candidates.length < Math.min(request.topK, minCandidates)) {
    return "insufficient_candidates";
  }
  if (trustedCandidateCount === 0) {
    return "trusted_citation_risk";
  }
  return "sufficient_candidates";
}

function diagnosisReason(
  code: RetrievalDiagnosisCode,
  request: RetrievalRequest,
  minCandidates: number
): string {
  switch (code) {
    case "empty_query":
      return "query_has_no_searchable_terms";
    case "invalid_filter":
      return "retrieval_filter_is_invalid";
    case "access_denied_or_missing_source":
      return "candidate_source_missing_or_access_denied";
    case "stale_or_missing_source":
      return "candidate_source_is_stale_or_missing";
    case "insufficient_candidates":
      return `returned_fewer_than_${Math.min(request.topK, minCandidates)}_candidates`;
    case "trusted_citation_risk":
      return "no_candidates_from_trusted_tiers";
    case "graph_requested":
      return "graph_evidence_requested";
    case "visual_requested":
      return "visual_evidence_requested";
    case "freshness_requested":
      return "fresh_or_recent_evidence_requested";
    case "retriever_error":
      return "retriever_failed";
    case "sufficient_candidates":
      return "retrieval_returned_sufficient_candidates";
  }
}

function shouldRetry(
  diagnosis: RetrievalDiagnosis,
  request: RetrievalRequest,
  capabilities: RetrieverCapabilities
): boolean {
  if (request.mode === "visual") {
    return false;
  }
  if (diagnosis.code === "visual_requested") {
    return capabilities.supportsVisualSearch === true;
  }
  return (
    diagnosis.code === "insufficient_candidates" ||
    diagnosis.code === "trusted_citation_risk" ||
    diagnosis.code === "graph_requested" ||
    diagnosis.code === "freshness_requested"
  );
}

function targetedRetryForDiagnosis(
  diagnosis: RetrievalDiagnosis,
  request: RetrievalRequest,
  capabilities: RetrieverCapabilities,
  maxExpandedCandidatePoolLimit: number
):
  | {
      readonly strategy: AdaptiveRetrievalStrategy;
      readonly request: RetrievalRequest;
    }
  | undefined {
  if (
    diagnosis.code === "visual_requested" &&
    capabilities.supportsVisualSearch === true &&
    request.mode !== "visual"
  ) {
    return {
      strategy: "visual_retrieval",
      request: {
        ...request,
        mode: "visual",
        retrievalId: `${request.retrievalId ?? "retrieval"}_visual_retry`
      }
    };
  }

  if (
    diagnosis.code === "graph_requested" &&
    capabilities.supportsGraphSearch === true &&
    request.graph?.enabled === true
  ) {
    const expanded = expandedCandidatePoolRequest(request, maxExpandedCandidatePoolLimit);
    return {
      strategy: "graph_deepening",
      request: {
        ...(expanded ?? request),
        graph: {
          ...request.graph,
          enabled: true,
          executionMode: "graph_first",
          maxDepth: Math.max(request.graph.maxDepth ?? 1, 2),
          neighborLimit: Math.max(request.graph.neighborLimit ?? 8, 24),
          maxVisitedEntities: Math.max(request.graph.maxVisitedEntities ?? 64, 256)
        },
        retrievalId: `${request.retrievalId ?? "retrieval"}_graph_retry`
      }
    };
  }

  if (diagnosis.code === "freshness_requested") {
    const expanded = expandedCandidatePoolRequest(request, maxExpandedCandidatePoolLimit);
    return expanded === undefined
      ? undefined
      : {
          strategy: "freshness_expansion",
          request: {
            ...expanded,
            retrievalId: `${request.retrievalId ?? "retrieval"}_freshness_retry`
          }
        };
  }

  const expanded = expandedCandidatePoolRequest(request, maxExpandedCandidatePoolLimit);
  return expanded === undefined
    ? undefined
    : {
        strategy: "expanded_candidate_pool",
        request: expanded
      };
}

function visualEvidenceRequested(request: RetrievalRequest): boolean {
  return (
    request.mode === "visual" ||
    request.intent?.primary === "visual" ||
    request.intent?.secondary?.includes("visual") === true ||
    request.intent?.sourceHints?.includes("visuals") === true
  );
}

function graphEvidenceRequested(request: RetrievalRequest): boolean {
  return request.graph?.enabled === true || request.intent?.sourceHints?.includes("graph") === true;
}

function freshnessEvidenceRequested(request: RetrievalRequest): boolean {
  return (
    request.intent?.primary === "freshness" ||
    request.intent?.secondary?.includes("freshness") === true ||
    request.intent?.sourceHints?.includes("recent") === true ||
    request.intent?.sourceHints?.includes("incidents") === true
  );
}

function expandedCandidatePoolRequest(
  request: RetrievalRequest,
  maxExpandedCandidatePoolLimit: number
): RetrievalRequest | undefined {
  const currentLimit = request.candidatePoolLimit ?? request.topK;
  const expandedLimit = Math.min(
    Math.max(currentLimit * 2, request.topK * 4, 20),
    maxExpandedCandidatePoolLimit
  );
  if (expandedLimit <= currentLimit) {
    return undefined;
  }
  return {
    ...request,
    candidatePoolLimit: expandedLimit,
    topK: Math.min(Math.max(request.topK, Math.min(expandedLimit, 100)), 100),
    retrievalId: `${request.retrievalId ?? "retrieval"}_adaptive_retry`
  };
}

function betterResult(
  first: RetrievalResult,
  firstDiagnosis: RetrievalDiagnosis,
  second: RetrievalResult,
  secondDiagnosis: RetrievalDiagnosis
): RetrievalResult {
  if (
    secondDiagnosis.code === "sufficient_candidates" &&
    firstDiagnosis.code !== "sufficient_candidates"
  ) {
    return second;
  }
  if (second.candidates.length > first.candidates.length) {
    return second;
  }
  return first;
}

function finalDecisionForDiagnosis(
  diagnosis: RetrievalDiagnosis
): RetrievalStrategyTrace["finalDecision"] {
  switch (diagnosis.code) {
    case "sufficient_candidates":
      return "answerable";
    case "empty_query":
    case "invalid_filter":
    case "access_denied_or_missing_source":
    case "stale_or_missing_source":
      return "refused";
    default:
      return "insufficient_evidence";
  }
}

function withStrategyTrace(
  result: RetrievalResult,
  strategy: RetrievalStrategyTrace
): RetrievalResult {
  return {
    ...result,
    trace: {
      ...result.trace,
      adaptiveStrategy: strategy
    }
  };
}
