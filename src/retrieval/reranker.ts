import type { RetrievalCandidate } from "./retrieval-types.js";

export type RerankMode = "lightweight" | "model";

export type RerankRejectionCode = "unknown_candidate" | "invalid_score" | "model_rerank_failed";

export interface RerankRequest {
  readonly profile: RerankProfileConfig;
  readonly query: string;
  readonly candidates: readonly RetrievalCandidate[];
  readonly topK: number;
  readonly rerankId?: string;
  readonly requestedAt?: string;
}

export interface RerankRejection {
  readonly code: RerankRejectionCode;
  readonly reason: string;
  readonly chunkId?: string;
}

export interface RerankTrace {
  readonly rerankId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: RerankMode;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly inputCandidateCount: number;
  readonly returnedCount: number;
  readonly rejectedCount: number;
  readonly inputChunkIds: readonly string[];
  readonly returnedChunkIds: readonly string[];
  readonly provider?: string;
  readonly modelName?: string;
  readonly modelTier?: string;
  readonly warningCodes: readonly string[];
}

export interface RerankResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly RerankRejection[];
  readonly trace: RerankTrace;
}

export interface Reranker {
  readonly mode: RerankMode;
  rerank(request: RerankRequest): Promise<RerankResult>;
}

export interface RerankProfileConfig {
  readonly id: string;
  readonly namespaceId: string;
  readonly modelTier: string;
  readonly allowModelFallback: boolean;
}
