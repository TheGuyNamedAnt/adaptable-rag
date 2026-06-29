import type { CitationPointer } from "../documents/provenance.js";
import { embeddingIdentityFor } from "../embeddings/embedding-identity.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import { redactIndexFilterForTrace } from "../indexing/index-filter.js";
import type { VisualChunkVector, VisualVectorStore } from "../indexing/visual-vector-store.js";
import { hashText } from "../shared/hash.js";
import {
  applyFreshnessRecencyBoostToCandidates,
  freshnessTraceForCandidates
} from "./freshness-ranking.js";
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
const DEFAULT_CANDIDATE_POOL_MULTIPLIER = 8;
const DEFAULT_CANDIDATE_POOL_FLOOR = 20;

export interface VisualRetrieverOptions {
  readonly embeddingAdapter: VisualEmbeddingAdapter;
  readonly vectorStore: VisualVectorStore;
  readonly now?: () => string;
}

export class VisualRetriever implements Retriever {
  readonly capabilities: RetrieverCapabilities = {
    modes: ["visual"],
    supportsVectorSearch: true,
    supportsHybridSearch: false,
    supportsVisualSearch: true
  };

  private readonly embeddingAdapter: VisualEmbeddingAdapter;
  private readonly vectorStore: VisualVectorStore;
  private readonly now: () => string;

  constructor(options: VisualRetrieverOptions) {
    this.embeddingAdapter = options.embeddingAdapter;
    this.vectorStore = options.vectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const startedAt = request.requestedAt ?? this.now();
    const retrievalId = request.retrievalId ?? `retrieval_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const normalizedQuery = normalizeQuery(request.query);

    validateRequest(request, normalizedQuery);

    const embedding = await this.embeddingAdapter.embedQuery({
      query: normalizedQuery,
      requestedAt: startedAt
    });

    if (embedding.status === "failed" || embedding.vectors.length === 0) {
      throw new Error(
        embedding.errorMessage ?? "Visual embedding adapter failed to embed the retrieval query."
      );
    }

    const embeddingIdentity = embeddingIdentityFor({
      provider: embedding.provider,
      modelName: embedding.modelName,
      dimensions: embedding.dimensions,
      adapterId: this.embeddingAdapter.id
    });
    const candidatePoolLimit =
      request.candidatePoolLimit ??
      Math.min(
        Math.max(request.topK * DEFAULT_CANDIDATE_POOL_MULTIPLIER, DEFAULT_CANDIDATE_POOL_FLOOR),
        MAX_CANDIDATE_POOL_LIMIT
      );
    const vectorTopK = Math.min(candidatePoolLimit, MAX_TOP_K);
    const vectorResult = await this.vectorStore.findNearestVisualVectors({
      vectors: embedding.vectors,
      filter: request.filter,
      topK: vectorTopK,
      embeddingModel: embedding.modelName,
      embeddingProvider: embedding.provider,
      embeddingConfigHash: embeddingIdentity.embeddingConfigHash,
      candidatePoolLimit,
      ...(request.includeRejected !== undefined ? { includeRejected: request.includeRejected } : {})
    });

    const candidates = selectDiverseVisualCandidates(
      applyFreshnessRecencyBoostToCandidates(
        vectorResult.candidates.map<RetrievalCandidate>((candidate) => ({
          chunk: candidate.chunk,
          score: candidate.score,
          rank: candidate.rank,
          matchedTerms: [],
          citation: visualCitation(candidate.chunk.citation, candidate.visualVector),
          reasons: candidate.reasons
        })),
        request
      ),
      request.topK
    );
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

function selectDiverseVisualCandidates(
  candidates: readonly RetrievalCandidate[],
  topK: number
): readonly RetrievalCandidate[] {
  let remaining = [...candidates];
  const selected: RetrievalCandidate[] = [];
  const selectedDocumentIds = new Set<string>();
  const selectedVisualAssetIds = new Set<string>();

  while (selected.length < topK && remaining.length > 0) {
    const next = remaining.sort((first, second) =>
      compareDiverseVisualCandidates(first, second, selectedDocumentIds, selectedVisualAssetIds)
    )[0];
    if (!next) {
      break;
    }

    selected.push(next);
    selectedDocumentIds.add(next.chunk.documentId);
    if (next.citation.visualAssetId) {
      selectedVisualAssetIds.add(next.citation.visualAssetId);
    }

    remaining = remaining.filter((candidate) => candidate.chunk.id !== next.chunk.id);
  }

  return selected.map((candidate, index) => ({
    ...candidate,
    rank: index + 1
  }));
}

function compareDiverseVisualCandidates(
  first: RetrievalCandidate,
  second: RetrievalCandidate,
  selectedDocumentIds: ReadonlySet<string>,
  selectedVisualAssetIds: ReadonlySet<string>
): number {
  const firstScore = visualDiversityAdjustedScore(
    first,
    selectedDocumentIds,
    selectedVisualAssetIds
  );
  const secondScore = visualDiversityAdjustedScore(
    second,
    selectedDocumentIds,
    selectedVisualAssetIds
  );
  if (secondScore !== firstScore) {
    return secondScore - firstScore;
  }

  if (first.rank !== second.rank) {
    return first.rank - second.rank;
  }

  return first.chunk.id.localeCompare(second.chunk.id);
}

function visualDiversityAdjustedScore(
  candidate: RetrievalCandidate,
  selectedDocumentIds: ReadonlySet<string>,
  selectedVisualAssetIds: ReadonlySet<string>
): number {
  let penalty = 0;
  if (selectedDocumentIds.has(candidate.chunk.documentId)) {
    penalty += 0.08;
  }
  if (
    candidate.citation.visualAssetId &&
    selectedVisualAssetIds.has(candidate.citation.visualAssetId)
  ) {
    penalty += 0.08;
  }

  return Math.round((candidate.score - penalty) * 1000) / 1000;
}

function validateRequest(request: RetrievalRequest, normalizedQuery: string): void {
  if (!normalizedQuery) {
    throw new Error("Retrieval query is required.");
  }

  if (request.mode !== undefined && request.mode !== "visual") {
    throw new Error(`VisualRetriever cannot serve retrieval mode "${request.mode}".`);
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

function visualCitation(
  citation: CitationPointer,
  visualVector: VisualChunkVector
): CitationPointer {
  return {
    ...citation,
    ...(visualVector.visualAssetId === undefined
      ? {}
      : { visualAssetId: visualVector.visualAssetId }),
    ...(visualVector.visualAsset === undefined ? {} : { visualAsset: visualVector.visualAsset }),
    ...(visualVector.pageNumber === undefined ? {} : { pageNumber: visualVector.pageNumber }),
    ...(visualVector.layoutRegionIds === undefined || visualVector.layoutRegionIds.length === 0
      ? {}
      : { layoutRegionIds: visualVector.layoutRegionIds }),
    ...(visualVector.boundingBoxes === undefined || visualVector.boundingBoxes.length === 0
      ? {}
      : { boundingBoxes: visualVector.boundingBoxes })
  };
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
  const freshnessTrace = freshnessTraceForCandidates(input.candidates, input.request);
  return {
    retrievalId: input.retrievalId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    mode: "visual",
    queryHash: hashText(input.request.query),
    normalizedQueryHash: hashText(input.normalizedQuery),
    searchTermHashes: [],
    access: redactIndexFilterForTrace(input.request.filter),
    candidatePoolSize: input.candidatePoolSize,
    returnedCount: input.candidates.length,
    rejectedCount: input.rejected.length,
    ...(freshnessTrace === undefined ? {} : { freshness: freshnessTrace })
  };
}
