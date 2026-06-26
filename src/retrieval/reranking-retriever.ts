import type { Reranker, RerankProfileConfig, RerankRejectionCode } from "./reranker.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalRejection,
  RetrievalRejectionCode,
  RetrievalRequest,
  RetrievalResult
} from "./retrieval-types.js";

const DEFAULT_RERANK_POOL_MULTIPLIER = 4;
const DEFAULT_RERANK_POOL_FLOOR = 20;
const MAX_RERANK_POOL_LIMIT = 5000;

export interface RerankingRetrieverOptions {
  readonly profile: RerankProfileConfig;
  readonly retriever: Retriever;
  readonly reranker: Reranker;
  readonly now?: () => string;
}

export class RerankingRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities;

  private readonly profile: RerankProfileConfig;
  private readonly retriever: Retriever;
  private readonly reranker: Reranker;
  private readonly now: () => string;

  constructor(options: RerankingRetrieverOptions) {
    this.profile = options.profile;
    this.retriever = options.retriever;
    this.reranker = options.reranker;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = options.retriever.capabilities;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const requestedTopK = request.topK;
    const rerankPoolLimit =
      request.candidatePoolLimit ??
      Math.min(
        Math.max(requestedTopK * DEFAULT_RERANK_POOL_MULTIPLIER, DEFAULT_RERANK_POOL_FLOOR),
        MAX_RERANK_POOL_LIMIT
      );
    const base = await this.retriever.retrieve({
      ...request,
      topK: rerankPoolLimit,
      candidatePoolLimit: rerankPoolLimit
    });

    const reranked = await this.reranker.rerank({
      profile: this.profile,
      query: request.query,
      candidates: base.candidates,
      topK: requestedTopK,
      rerankId: `${base.trace.retrievalId}_rerank`,
      requestedAt: this.now()
    });

    const rerankRejected = reranked.rejected.map<RetrievalRejection>((rejection) => ({
      ...(rejection.chunkId ? { chunkId: rejection.chunkId } : {}),
      code: mapRerankRejectionCode(rejection.code),
      reason: rejection.reason
    }));

    return {
      ...base,
      candidates: reranked.candidates,
      rejected: [...base.rejected, ...rerankRejected],
      rerank: reranked.trace,
      trace: {
        ...base.trace,
        candidatePoolSize: base.candidates.length,
        returnedCount: reranked.candidates.length,
        rejectedCount: base.rejected.length + rerankRejected.length,
        rerankId: reranked.trace.rerankId
      }
    };
  }
}

function mapRerankRejectionCode(code: RerankRejectionCode): RetrievalRejectionCode {
  switch (code) {
    case "unknown_candidate":
      return "rerank_unknown_candidate";
    case "invalid_score":
      return "rerank_invalid_score";
    case "model_rerank_failed":
      return "model_rerank_failed";
  }
}
