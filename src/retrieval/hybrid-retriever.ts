import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { hashText } from "../shared/hash.js";
import {
  applyFreshnessRecencyBoostToCandidates,
  freshnessTraceForCandidates
} from "./freshness-ranking.js";
import { selectPreferredGraphEvidence } from "./graph-evidence.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import { DEFAULT_RRF_K, mergeCandidatesByRrf } from "./rrf.js";
import type {
  RetrievalCandidate,
  RetrievalRejection,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTrace
} from "./retrieval-types.js";

const DEFAULT_CHILD_CANDIDATE_MULTIPLIER = 8;
const DEFAULT_CHILD_CANDIDATE_FLOOR = 20;
const MAX_TOP_K = 100;
const MAX_CANDIDATE_POOL_LIMIT = 5000;

export type HybridFusionStrategy = "reciprocal_rank_fusion" | "score_normalization";

export interface HybridRetrieverOptions {
  readonly keywordRetriever: Retriever;
  readonly vectorRetriever: Retriever;
  readonly keywordWeight?: number;
  readonly vectorWeight?: number;
  readonly fusionStrategy?: HybridFusionStrategy;
  readonly rrfK?: number;
  readonly now?: () => string;
}

interface WeightedCandidate {
  readonly candidate: RetrievalCandidate;
  readonly normalizedScore: number;
  readonly component: "keyword" | "vector";
}

interface MergedCandidateRecord {
  chunk: RetrievalCandidate["chunk"];
  score: number;
  rank: number;
  bestComponentRank: number;
  matchedTerms: string[];
  citation: RetrievalCandidate["citation"];
  reasons: string[];
  graphEvidence: RetrievalCandidate["graphEvidence"];
}

export class HybridRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["hybrid"],
    supportsVectorSearch: true,
    supportsHybridSearch: true
  };

  private readonly keywordRetriever: Retriever;
  private readonly vectorRetriever: Retriever;
  private readonly keywordWeight: number;
  private readonly vectorWeight: number;
  private readonly fusionStrategy: HybridFusionStrategy;
  private readonly rrfK: number;
  private readonly now: () => string;

  constructor(options: HybridRetrieverOptions) {
    assertChildCapabilities(options.keywordRetriever, "keyword");
    assertChildCapabilities(options.vectorRetriever, "vector");

    const keywordWeight = options.keywordWeight ?? 0.5;
    const vectorWeight = options.vectorWeight ?? 0.5;
    assertValidWeights(keywordWeight, vectorWeight);

    this.keywordRetriever = options.keywordRetriever;
    this.vectorRetriever = options.vectorRetriever;
    this.keywordWeight = keywordWeight;
    this.vectorWeight = vectorWeight;
    this.fusionStrategy = options.fusionStrategy ?? "reciprocal_rank_fusion";
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    assertValidRrfK(this.rrfK);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const retrievalId = request.retrievalId ?? `retrieval_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const normalizedQuery = normalizeQuery(request.query);

    validateRequest(request, normalizedQuery);

    const childCandidatePoolLimit =
      request.candidatePoolLimit ??
      Math.min(
        Math.max(request.topK * DEFAULT_CHILD_CANDIDATE_MULTIPLIER, DEFAULT_CHILD_CANDIDATE_FLOOR),
        MAX_CANDIDATE_POOL_LIMIT
      );
    const childTopK = Math.min(childCandidatePoolLimit, MAX_TOP_K);

    const [keywordResult, vectorResult] = await Promise.all([
      this.keywordRetriever.retrieve({
        ...request,
        mode: "keyword",
        topK: childTopK,
        candidatePoolLimit: childCandidatePoolLimit,
        retrievalId: `${retrievalId}_keyword`,
        requestedAt: startedAt
      }),
      this.vectorRetriever.retrieve({
        ...request,
        mode: "vector",
        topK: childTopK,
        candidatePoolLimit: childCandidatePoolLimit,
        retrievalId: `${retrievalId}_vector`,
        requestedAt: startedAt
      })
    ]);

    const mergedPool = mergeCandidates({
      keywordCandidates: keywordResult.candidates,
      vectorCandidates: vectorResult.candidates,
      keywordWeight: this.keywordWeight,
      vectorWeight: this.vectorWeight,
      fusionStrategy: this.fusionStrategy,
      rrfK: this.rrfK
    });
    const rejected = dedupeRejections([...keywordResult.rejected, ...vectorResult.rejected]);
    const ranked = applyFreshnessRecencyBoostToCandidates(
      mergedPool
        .filter((candidate) => {
          if (candidate.score > 0) {
            return true;
          }

          if (request.includeRejected) {
            rejected.push({
              chunkId: candidate.chunk.id,
              code: "no_hybrid_match",
              reason: "Merged keyword and vector scores did not produce a positive hybrid score."
            });
          }
          return false;
        })
        .sort(compareMergedCandidates)
        .map<RetrievalCandidate>((candidate, index) => ({
          chunk: candidate.chunk,
          score: candidate.score,
          rank: index + 1,
          matchedTerms: candidate.matchedTerms,
          citation: candidate.citation,
          reasons: candidate.reasons,
          ...(candidate.graphEvidence === undefined
            ? {}
            : { graphEvidence: candidate.graphEvidence })
        })),
      request
    )
      .slice(0, request.topK)
      .map<RetrievalCandidate>((candidate, index) => ({
        ...candidate,
        rank: index + 1
      }));

    return {
      query: request.query,
      candidates: ranked,
      rejected,
      trace: buildTrace({
        request,
        retrievalId,
        startedAt,
        finishedAt: this.now(),
        normalizedQuery,
        keywordTrace: keywordResult.trace,
        vectorTrace: vectorResult.trace,
        candidatePoolSize: mergedPool.length,
        candidates: ranked,
        rejected,
        fusionStrategy: this.fusionStrategy
      })
    };
  }
}

function assertChildCapabilities(retriever: Retriever, mode: "keyword" | "vector"): void {
  if (!retriever.capabilities.modes.includes(mode)) {
    throw new Error(`HybridRetriever requires a child retriever that can serve ${mode} mode.`);
  }

  if (mode === "vector" && !retriever.capabilities.supportsVectorSearch) {
    throw new Error("HybridRetriever requires a vector retriever with vector-search capability.");
  }
}

function assertValidWeights(keywordWeight: number, vectorWeight: number): void {
  if (
    !Number.isFinite(keywordWeight) ||
    !Number.isFinite(vectorWeight) ||
    keywordWeight < 0 ||
    vectorWeight < 0 ||
    keywordWeight + vectorWeight <= 0
  ) {
    throw new Error("HybridRetriever weights must be finite, non-negative, and not both zero.");
  }
}

function assertValidRrfK(rrfK: number): void {
  if (!Number.isFinite(rrfK) || rrfK < 1) {
    throw new Error("HybridRetriever rrfK must be a positive finite number.");
  }
}

function validateRequest(request: RetrievalRequest, normalizedQuery: string): void {
  if (!normalizedQuery) {
    throw new Error("Retrieval query is required.");
  }

  if (request.mode !== undefined && request.mode !== "hybrid") {
    throw new Error(`HybridRetriever cannot serve retrieval mode "${request.mode}".`);
  }

  if (!request.filter.namespaceId.trim()) {
    throw new Error("Retrieval filter namespaceId is required.");
  }

  if (!request.filter.tenantId.trim()) {
    throw new Error("Retrieval filter tenantId is required.");
  }

  if (request.filter.tenantId !== request.filter.principal.tenantId) {
    throw new Error("Retrieval filter tenantId must match the requesting principal.");
  }

  if (!request.filter.principal.namespaceIds.includes(request.filter.namespaceId)) {
    throw new Error("Retrieval principal is not allowed for the requested namespaceId.");
  }

  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > MAX_TOP_K) {
    throw new Error(`Retrieval topK must be an integer between 1 and ${MAX_TOP_K}.`);
  }

  if (
    request.candidatePoolLimit !== undefined &&
    (!Number.isInteger(request.candidatePoolLimit) ||
      request.candidatePoolLimit < request.topK ||
      request.candidatePoolLimit > MAX_CANDIDATE_POOL_LIMIT)
  ) {
    throw new Error(
      `candidatePoolLimit must be an integer between topK and ${MAX_CANDIDATE_POOL_LIMIT}.`
    );
  }
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function mergeCandidates(input: {
  readonly keywordCandidates: readonly RetrievalCandidate[];
  readonly vectorCandidates: readonly RetrievalCandidate[];
  readonly keywordWeight: number;
  readonly vectorWeight: number;
  readonly fusionStrategy: HybridFusionStrategy;
  readonly rrfK: number;
}): readonly MergedCandidateRecord[] {
  if (input.fusionStrategy === "reciprocal_rank_fusion") {
    return mergeCandidatesByRrf(
      [
        {
          candidates: input.keywordCandidates,
          weight: input.keywordWeight,
          componentReason: "hybrid_keyword_component"
        },
        {
          candidates: input.vectorCandidates,
          weight: input.vectorWeight,
          componentReason: "hybrid_vector_component"
        }
      ],
      {
        k: input.rrfK,
        scoreReason: "hybrid_rrf_score"
      }
    ).map((candidate) => ({
      ...candidate,
      rank: 0
    }));
  }

  const totalWeight = input.keywordWeight + input.vectorWeight;
  const weightedCandidates: WeightedCandidate[] = [
    ...weightCandidates(input.keywordCandidates, "keyword", input.keywordWeight / totalWeight),
    ...weightCandidates(input.vectorCandidates, "vector", input.vectorWeight / totalWeight)
  ];
  const records = new Map<string, MergedCandidateRecord>();

  for (const weighted of weightedCandidates) {
    const candidate = weighted.candidate;
    const existing = records.get(candidate.chunk.id);
    const componentReason =
      weighted.component === "keyword" ? "hybrid_keyword_component" : "hybrid_vector_component";
    const score = roundScore(weighted.normalizedScore);

    if (!existing) {
      records.set(candidate.chunk.id, {
        chunk: candidate.chunk,
        score,
        rank: 0,
        bestComponentRank: candidate.rank,
        matchedTerms: [...candidate.matchedTerms],
        citation: candidate.citation,
        reasons: [...candidate.reasons, componentReason, "hybrid_score_normalized"],
        graphEvidence: candidate.graphEvidence
      });
      continue;
    }

    existing.score = roundScore(existing.score + score);
    existing.bestComponentRank = Math.min(existing.bestComponentRank, candidate.rank);
    existing.matchedTerms = uniqueSorted([...existing.matchedTerms, ...candidate.matchedTerms]);
    existing.graphEvidence = selectPreferredGraphEvidence(
      existing.graphEvidence,
      candidate.graphEvidence
    );
    existing.reasons = uniqueSorted([
      ...existing.reasons,
      ...candidate.reasons,
      componentReason,
      "hybrid_score_normalized"
    ]);
  }

  return [...records.values()];
}

function weightCandidates(
  candidates: readonly RetrievalCandidate[],
  component: "keyword" | "vector",
  weight: number
): readonly WeightedCandidate[] {
  const maxPositiveScore = Math.max(0, ...candidates.map((candidate) => candidate.score));

  return candidates.map((candidate) => ({
    candidate,
    component,
    normalizedScore:
      candidate.score > 0 && maxPositiveScore > 0
        ? (candidate.score / maxPositiveScore) * weight
        : 0
  }));
}

function compareMergedCandidates(
  first: MergedCandidateRecord,
  second: MergedCandidateRecord
): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.bestComponentRank !== second.bestComponentRank) {
    return first.bestComponentRank - second.bestComponentRank;
  }

  if (first.chunk.documentId !== second.chunk.documentId) {
    return first.chunk.documentId.localeCompare(second.chunk.documentId);
  }

  if (first.chunk.index !== second.chunk.index) {
    return first.chunk.index - second.chunk.index;
  }

  return first.chunk.id.localeCompare(second.chunk.id);
}

function dedupeRejections(rejections: readonly RetrievalRejection[]): RetrievalRejection[] {
  const seen = new Set<string>();
  const deduped: RetrievalRejection[] = [];

  for (const rejection of rejections) {
    const key = `${rejection.chunkId ?? ""}:${rejection.code}:${rejection.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(rejection);
  }

  return deduped;
}

function buildTrace(input: {
  readonly request: RetrievalRequest;
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly normalizedQuery: string;
  readonly keywordTrace: RetrievalTrace;
  readonly vectorTrace: RetrievalTrace;
  readonly candidatePoolSize: number;
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly RetrievalRejection[];
  readonly fusionStrategy: HybridFusionStrategy;
}): RetrievalTrace {
  const freshnessTrace = freshnessTraceForCandidates(input.candidates, input.request);
  return {
    retrievalId: input.retrievalId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    mode: "hybrid",
    queryHash: hashText(input.request.query),
    normalizedQueryHash: hashText(input.normalizedQuery),
    searchTermHashes: uniqueSorted([
      ...input.keywordTrace.searchTermHashes,
      ...input.vectorTrace.searchTermHashes
    ]),
    access: redactIndexFilterForTrace(input.request.filter),
    candidatePoolSize: input.candidatePoolSize,
    returnedCount: input.candidates.length,
    rejectedCount: input.rejected.length,
    fusionStrategy: input.fusionStrategy,
    childRetrievalIds: [input.keywordTrace.retrievalId, input.vectorTrace.retrievalId],
    ...(freshnessTrace === undefined ? {} : { freshness: freshnessTrace })
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((first, second) => first.localeCompare(second));
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
