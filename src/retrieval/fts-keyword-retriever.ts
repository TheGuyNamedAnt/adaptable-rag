import type { FtsIndexStore } from "../storage/keyword-index.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import { hashText } from "../shared/hash.js";
import {
  buildKeywordRetrievalResult,
  normalizeKeywordQuery,
  tokenizeQuery,
  validateKeywordRetrievalRequest
} from "./keyword-retriever.js";
import type { RetrievalCandidate, RetrievalRequest, RetrievalResult } from "./retrieval-types.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";

const DEFAULT_CANDIDATE_POOL_LIMIT = 500;

export interface FtsKeywordRetrieverOptions {
  readonly index: FtsIndexStore;
  readonly fusionStrategy: string;
  readonly now?: () => string;
}

export class FtsKeywordRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["keyword"],
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly index: FtsIndexStore;
  private readonly fusionStrategy: string;
  private readonly now: () => string;

  constructor(options: FtsKeywordRetrieverOptions) {
    this.index = options.index;
    this.fusionStrategy = options.fusionStrategy;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const retrievalId = request.retrievalId ?? `retrieval_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const normalizedQuery = normalizeKeywordQuery(request.query);
    const searchTerms = tokenizeQuery(normalizedQuery);

    validateKeywordRetrievalRequest(request, normalizedQuery);

    if (searchTerms.length === 0) {
      return {
        query: request.query,
        candidates: [],
        rejected: [
          {
            code: "empty_query",
            reason: "Query did not contain searchable terms."
          }
        ],
        trace: {
          retrievalId,
          startedAt,
          finishedAt: this.now(),
          mode: "keyword",
          queryHash: hashText(request.query),
          normalizedQueryHash: hashText(normalizedQuery),
          searchTermHashes: [],
          access: redactIndexFilterForTrace(request.filter),
          candidatePoolSize: 0,
          returnedCount: 0,
          rejectedCount: 1,
          fusionStrategy: this.fusionStrategy
        }
      };
    }

    const ftsResults = await this.index.searchKeywordChunks({
      query: normalizedQuery,
      terms: searchTerms,
      filter: request.filter,
      limit: request.candidatePoolLimit ?? request.filter.limit ?? DEFAULT_CANDIDATE_POOL_LIMIT
    });
    const candidates = ftsResults
      .slice(0, request.topK)
      .map<RetrievalCandidate>((result, index) => ({
        chunk: result.chunk.chunk,
        score: result.score,
        rank: index + 1,
        matchedTerms: result.matchedTerms,
        citation: result.chunk.chunk.citation,
        reasons: result.reasons
      }));

    const result = buildKeywordRetrievalResult({
      request,
      retrievalId,
      startedAt,
      finishedAt: this.now(),
      normalizedQuery,
      searchTerms,
      candidatePool: ftsResults.map((entry) => entry.chunk),
      candidates,
      rejected: []
    });

    return {
      ...result,
      trace: {
        ...result.trace,
        fusionStrategy: this.fusionStrategy
      }
    };
  }
}
