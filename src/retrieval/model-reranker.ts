import type { RerankRequest, RerankResult, Reranker, RerankRejection } from "./reranker.js";
import type { RetrievalCandidate } from "./retrieval-types.js";
import { LightweightReranker } from "./lightweight-reranker.js";

export type RerankModelStatus = "succeeded" | "failed";

export interface RerankModelCandidateInput {
  readonly chunkId: string;
  readonly documentId: string;
  readonly title: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly trustTier: string;
  readonly retrievalScore: number;
  readonly retrievalRank: number;
  readonly text: string;
}

export interface RerankModelRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly modelTier: string;
  readonly query: string;
  readonly candidates: readonly RerankModelCandidateInput[];
  readonly requestedAt?: string;
}

export interface RerankModelScore {
  readonly chunkId: string;
  readonly score: number;
  readonly reason?: string;
}

export interface RerankModelResult {
  readonly status: RerankModelStatus;
  readonly scores: readonly RerankModelScore[];
  readonly provider: string;
  readonly modelName: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly cost: {
    readonly amountUsd: number;
    readonly currency: "USD";
  };
  readonly warnings: readonly string[];
  readonly errorMessage?: string;
}

export interface RerankModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  rerank(request: RerankModelRequest): Promise<RerankModelResult>;
}

export interface ModelBackedRerankerOptions {
  readonly adapter: RerankModelAdapter;
  readonly fallbackReranker?: Reranker;
  readonly now?: () => string;
}

interface ScoredCandidate {
  readonly candidate: RetrievalCandidate;
  readonly score: number;
  readonly reason: string | undefined;
}

export class ModelBackedReranker implements Reranker {
  readonly mode = "model" as const;

  private readonly adapter: RerankModelAdapter;
  private readonly fallbackReranker: Reranker;
  private readonly now: () => string;

  constructor(options: ModelBackedRerankerOptions) {
    this.adapter = options.adapter;
    this.fallbackReranker = options.fallbackReranker ?? new LightweightReranker(options);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    const startedAt = request.requestedAt ?? this.now();
    const rerankId = request.rerankId ?? `rerank_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const modelRequest: RerankModelRequest = {
      requestId: `model_${rerankId}`,
      profileId: request.profile.id,
      namespaceId: request.profile.namespaceId,
      modelTier: request.profile.modelTier,
      query: request.query,
      candidates: request.candidates.map(toModelCandidate),
      requestedAt: startedAt
    };
    const model = await this.adapter.rerank(modelRequest);

    if (model.status === "failed") {
      if (!request.profile.allowModelFallback) {
        throw new Error(model.errorMessage ?? "Model reranker failed.");
      }

      return this.fallbackResult({
        request,
        rerankId,
        startedAt,
        warningCodes: ["model_rerank_failed", "model_rerank_fallback"],
        rejection: {
          code: "model_rerank_failed",
          reason: model.errorMessage ?? "Model reranker failed; fallback reranker was used."
        },
        provider: model.provider,
        modelName: model.modelName,
        modelTier: modelRequest.modelTier
      });
    }

    const candidatesByChunkId = new Map(
      request.candidates.map((candidate) => [candidate.chunk.id, candidate])
    );
    const rejected: RerankRejection[] = [];
    const scored: ScoredCandidate[] = [];
    const seenChunkIds = new Set<string>();

    for (const score of model.scores) {
      const candidate = candidatesByChunkId.get(score.chunkId);
      if (!candidate) {
        rejected.push({
          code: "unknown_candidate",
          chunkId: score.chunkId,
          reason: "Model reranker returned a chunk id that was not in the candidate set."
        });
        continue;
      }

      if (!Number.isFinite(score.score)) {
        rejected.push({
          code: "invalid_score",
          chunkId: score.chunkId,
          reason: "Model reranker returned a non-finite score."
        });
        continue;
      }

      if (seenChunkIds.has(score.chunkId)) {
        continue;
      }

      seenChunkIds.add(score.chunkId);
      scored.push({
        candidate,
        score: roundScore(score.score),
        reason: score.reason
      });
    }

    if (scored.length === 0) {
      if (!request.profile.allowModelFallback) {
        throw new Error("Model reranker did not return any valid candidate scores.");
      }

      return this.fallbackResult({
        request,
        rerankId,
        startedAt,
        warningCodes: ["model_rerank_empty", "model_rerank_fallback"],
        rejection: {
          code: "model_rerank_failed",
          reason: "Model reranker did not return any valid candidate scores."
        },
        provider: model.provider,
        modelName: model.modelName,
        modelTier: modelRequest.modelTier
      });
    }

    const ranked = scored
      .sort(compareScoredCandidates)
      .slice(0, request.topK)
      .map(({ candidate, score, reason }, index) => ({
        ...candidate,
        score,
        rank: index + 1,
        reasons: uniqueSorted([
          ...candidate.reasons,
          "model_rerank",
          ...(reason ? [`model_rerank_reason:${reason}`] : [])
        ])
      }));

    return {
      candidates: ranked,
      rejected,
      trace: {
        rerankId,
        startedAt,
        finishedAt: this.now(),
        mode: this.mode,
        profileId: request.profile.id,
        namespaceId: request.profile.namespaceId,
        inputCandidateCount: request.candidates.length,
        returnedCount: ranked.length,
        rejectedCount: rejected.length,
        inputChunkIds: request.candidates.map((candidate) => candidate.chunk.id),
        returnedChunkIds: ranked.map((candidate) => candidate.chunk.id),
        provider: model.provider,
        modelName: model.modelName,
        modelTier: modelRequest.modelTier,
        warningCodes: uniqueSorted(model.warnings)
      }
    };
  }

  private async fallbackResult(input: {
    readonly request: RerankRequest;
    readonly rerankId: string;
    readonly startedAt: string;
    readonly warningCodes: readonly string[];
    readonly rejection: RerankRejection;
    readonly provider: string;
    readonly modelName: string;
    readonly modelTier: string;
  }): Promise<RerankResult> {
    const fallback = await this.fallbackReranker.rerank({
      ...input.request,
      rerankId: `${input.rerankId}_fallback`,
      requestedAt: input.startedAt
    });

    return {
      candidates: fallback.candidates,
      rejected: [input.rejection, ...fallback.rejected],
      trace: {
        rerankId: input.rerankId,
        startedAt: input.startedAt,
        finishedAt: this.now(),
        mode: this.mode,
        profileId: input.request.profile.id,
        namespaceId: input.request.profile.namespaceId,
        inputCandidateCount: input.request.candidates.length,
        returnedCount: fallback.candidates.length,
        rejectedCount: fallback.rejected.length + 1,
        inputChunkIds: input.request.candidates.map((candidate) => candidate.chunk.id),
        returnedChunkIds: fallback.candidates.map((candidate) => candidate.chunk.id),
        provider: input.provider,
        modelName: input.modelName,
        modelTier: input.modelTier,
        warningCodes: input.warningCodes
      }
    };
  }
}

function toModelCandidate(candidate: RetrievalCandidate): RerankModelCandidateInput {
  return {
    chunkId: candidate.chunk.id,
    documentId: candidate.chunk.documentId,
    title: candidate.chunk.provenance.title,
    sourceId: candidate.chunk.provenance.sourceId,
    sourceKind: candidate.chunk.provenance.sourceKind,
    trustTier: candidate.chunk.provenance.trustTier,
    retrievalScore: candidate.score,
    retrievalRank: candidate.rank,
    text: candidate.chunk.text
  };
}

function compareScoredCandidates(first: ScoredCandidate, second: ScoredCandidate): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.candidate.rank !== second.candidate.rank) {
    return first.candidate.rank - second.candidate.rank;
  }

  return first.candidate.chunk.id.localeCompare(second.candidate.chunk.id);
}

function roundScore(score: number): number {
  return Math.round(score * 1000000) / 1000000;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
