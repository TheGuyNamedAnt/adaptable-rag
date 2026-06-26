import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type { VectorStore } from "../indexing/vector-store.js";
import { hashText } from "../shared/hash.js";
import type { Retriever, RetrieverCapabilities } from "./retriever.js";
import type {
  RetrievalCandidate,
  RetrievalRejection,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTrace
} from "./retrieval-types.js";

const MAX_TOP_K = 100;
const MAX_CANDIDATE_POOL_LIMIT = 5000;

export interface VectorRetrieverOptions {
  readonly embeddingAdapter: EmbeddingAdapter;
  readonly vectorStore: VectorStore;
  readonly now?: () => string;
}

export class VectorRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["vector"],
    supportsVectorSearch: true,
    supportsHybridSearch: false
  };

  private readonly embeddingAdapter: EmbeddingAdapter;
  private readonly vectorStore: VectorStore;
  private readonly now: () => string;

  constructor(options: VectorRetrieverOptions) {
    this.embeddingAdapter = options.embeddingAdapter;
    this.vectorStore = options.vectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const retrievalId = request.retrievalId ?? `retrieval_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const normalizedQuery = normalizeQuery(request.query);

    validateRequest(request, normalizedQuery);

    const embedding = await this.embeddingAdapter.embed({
      inputs: [{ id: "query", text: normalizedQuery }],
      requestedAt: startedAt
    });

    if (embedding.status === "failed" || !embedding.embeddings[0]) {
      throw new Error(
        embedding.errorMessage ?? "Embedding adapter failed to embed the retrieval query."
      );
    }

    const vectorResult = await this.vectorStore.findNearestVectors({
      vector: embedding.embeddings[0].vector,
      filter: request.filter,
      topK: request.topK,
      ...(request.candidatePoolLimit !== undefined
        ? { candidatePoolLimit: request.candidatePoolLimit }
        : {}),
      ...(request.includeRejected !== undefined ? { includeRejected: request.includeRejected } : {})
    });

    const candidates = vectorResult.candidates.map<RetrievalCandidate>((candidate) => ({
      chunk: candidate.chunk,
      score: candidate.score,
      rank: candidate.rank,
      matchedTerms: [],
      citation: candidate.chunk.citation,
      reasons: candidate.reasons
    }));
    const rejected = vectorResult.rejected.map<RetrievalRejection>((rejection) => ({
      ...(rejection.chunkId ? { chunkId: rejection.chunkId } : {}),
      code: rejection.code,
      reason: rejection.reason
    }));

    return {
      query: request.query,
      candidates,
      rejected,
      trace: buildTrace({
        request,
        retrievalId,
        startedAt,
        finishedAt: this.now(),
        normalizedQuery,
        candidatePoolSize: vectorResult.candidatePoolSize,
        candidates,
        rejected
      })
    };
  }
}

function validateRequest(request: RetrievalRequest, normalizedQuery: string): void {
  if (!normalizedQuery) {
    throw new Error("Retrieval query is required.");
  }

  if (request.mode !== undefined && request.mode !== "vector") {
    throw new Error(`VectorRetriever cannot serve retrieval mode "${request.mode}".`);
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

function buildTrace(input: {
  readonly request: RetrievalRequest;
  readonly retrievalId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly normalizedQuery: string;
  readonly candidatePoolSize: number;
  readonly candidates: readonly RetrievalCandidate[];
  readonly rejected: readonly RetrievalRejection[];
}): RetrievalTrace {
  return {
    retrievalId: input.retrievalId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    mode: "vector",
    queryHash: hashText(input.request.query),
    normalizedQueryHash: hashText(input.normalizedQuery),
    searchTermHashes: [],
    access: redactIndexFilterForTrace(input.request.filter),
    candidatePoolSize: input.candidatePoolSize,
    returnedCount: input.candidates.length,
    rejectedCount: input.rejected.length
  };
}
