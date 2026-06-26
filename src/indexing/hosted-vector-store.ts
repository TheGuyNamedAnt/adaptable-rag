import type { RagChunk } from "../documents/chunk.js";
import { isValidIndexFilter } from "./index-filter.js";
import type { ChunkStore } from "./chunk-store.js";
import type { IndexFilter, IndexOperationResult } from "./index-types.js";
import {
  type ChunkVector,
  type VectorIndexOptions,
  type VectorSearchCandidate,
  type VectorSearchRejection,
  type VectorSearchRequest,
  type VectorSearchResult,
  type VectorSnapshot,
  type VectorStore,
  type VectorStoreCapabilities,
  validateChunkVector,
  validateVectorSearchRequest
} from "./vector-store.js";
import { isFiniteVector } from "../shared/vector-math.js";

export interface HostedVectorStoreTransport {
  upsert(request: HostedVectorUpsertRequest): Promise<HostedVectorUpsertResult>;
  deleteByDocument(request: HostedVectorDeleteRequest): Promise<HostedVectorDeleteResult>;
  query(request: HostedVectorQueryRequest): Promise<HostedVectorQueryResult>;
  count?(request: HostedVectorCountRequest): Promise<number>;
}

export interface HostedVectorUpsertRequest {
  readonly vectors: readonly ChunkVector[];
  readonly overwriteMode: "reject" | "replace";
  readonly indexedAt: string;
}

export interface HostedVectorUpsertResult {
  readonly results: readonly IndexOperationResult[];
}

export interface HostedVectorDeleteRequest {
  readonly documentId: string;
}

export interface HostedVectorDeleteResult {
  readonly deletedCount: number;
}

export interface HostedVectorCountRequest {
  readonly tenantId?: string;
  readonly namespaceId?: string;
}

export interface HostedVectorQueryRequest {
  readonly vector: readonly number[];
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly topK: number;
  readonly candidatePoolLimit?: number;
  readonly minScore?: number;
}

export interface HostedVectorQueryResult {
  readonly matches: readonly HostedVectorSearchMatch[];
}

export interface HostedVectorSearchMatch {
  readonly id: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly textHash: string;
  readonly embeddingModel: string;
  readonly embeddedAt: string;
  readonly dimensions: number;
  readonly vector: readonly number[];
  readonly score: number;
  readonly reasons?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HostedVectorStoreOptions {
  readonly chunkStore: ChunkStore;
  readonly transport: HostedVectorStoreTransport;
  readonly dimensions?: number;
  readonly now?: () => string;
}

export class HostedVectorStore implements VectorStore {
  readonly capabilities: VectorStoreCapabilities;

  private readonly chunkStore: ChunkStore;
  private readonly transport: HostedVectorStoreTransport;
  private readonly dimensions: number | undefined;
  private readonly now: () => string;

  constructor(options: HostedVectorStoreOptions) {
    this.chunkStore = options.chunkStore;
    this.transport = options.transport;
    this.dimensions = options.dimensions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      storageKind: "hosted",
      durable: true,
      enforcesAccessFilters: true,
      supportsCosineSimilarity: true,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions })
    };

    if (
      this.dimensions !== undefined &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1)
    ) {
      throw new Error("Hosted vector store dimensions must be a positive integer.");
    }
  }

  async addChunkVectors(
    vectors: readonly ChunkVector[],
    options: VectorIndexOptions = {}
  ): Promise<readonly IndexOperationResult[]> {
    const seenIds = new Set<string>();
    for (const vector of vectors) {
      validateChunkVector(vector, this.dimensions, seenIds);
      seenIds.add(vector.id);
    }

    const result = await this.transport.upsert({
      vectors,
      overwriteMode: options.overwriteMode ?? "reject",
      indexedAt: options.indexedAt ?? this.now()
    });

    return result.results;
  }

  async deleteVectorsForDocument(documentId: string): Promise<number> {
    if (!documentId.trim()) {
      throw new Error("Hosted vector delete requires a documentId.");
    }

    const result = await this.transport.deleteByDocument({ documentId });
    return result.deletedCount;
  }

  async findNearestVectors(request: VectorSearchRequest): Promise<VectorSearchResult> {
    validateVectorSearchRequest(request, this.dimensions);

    if (!isValidIndexFilter(request.filter)) {
      return {
        candidates: [],
        rejected: [
          {
            code: "invalid_filter",
            reason: "Hosted vector search requires a valid tenant, namespace, and principal filter."
          }
        ],
        candidatePoolSize: 0
      };
    }

    const hostedResult = await this.transport.query({
      vector: request.vector,
      tenantId: request.filter.tenantId,
      namespaceId: request.filter.namespaceId,
      topK: request.candidatePoolLimit ?? request.topK,
      ...(request.candidatePoolLimit === undefined
        ? {}
        : { candidatePoolLimit: request.candidatePoolLimit }),
      ...(request.minScore === undefined ? {} : { minScore: request.minScore })
    });
    const rejected: VectorSearchRejection[] = [];
    const scored: VectorSearchCandidate[] = [];
    const minScore = request.minScore ?? Number.NEGATIVE_INFINITY;

    for (const match of hostedResult.matches) {
      const evaluated = await evaluateHostedMatch({
        match,
        request,
        chunkStore: this.chunkStore,
        expectedDimensions: this.dimensions,
        minScore
      });

      if (evaluated.candidate) {
        scored.push(evaluated.candidate);
      } else if (request.includeRejected && evaluated.rejection) {
        rejected.push(evaluated.rejection);
      }
    }

    const candidatePoolSize = scored.length;
    const candidatePool = scored
      .sort(compareVectorCandidates)
      .slice(0, request.candidatePoolLimit ?? scored.length);

    return {
      candidates: candidatePool.slice(0, request.topK).map((candidate, index) => ({
        ...candidate,
        rank: index + 1
      })),
      rejected,
      candidatePoolSize
    };
  }

  snapshot(): VectorSnapshot {
    throw new Error("HostedVectorStore does not expose local vector snapshots.");
  }

  async vectorCount(): Promise<number> {
    if (!this.transport.count) {
      throw new Error("Hosted vector transport does not expose vector counts.");
    }

    return this.transport.count({});
  }
}

async function evaluateHostedMatch(input: {
  readonly match: HostedVectorSearchMatch;
  readonly request: VectorSearchRequest;
  readonly chunkStore: ChunkStore;
  readonly expectedDimensions: number | undefined;
  readonly minScore: number;
}): Promise<{
  readonly candidate?: VectorSearchCandidate;
  readonly rejection?: VectorSearchRejection;
}> {
  const matchValidation = validateHostedMatch(input.match, input.request.vector.length);
  if (matchValidation) {
    return { rejection: matchValidation };
  }

  const chunk = (await input.chunkStore.getChunk(input.match.chunkId, input.request.filter))?.chunk;
  if (!chunk) {
    return {
      rejection: {
        chunkId: input.match.chunkId,
        code: "access_denied_or_missing_chunk",
        reason: "Hosted vector match did not pass the local index access filter."
      }
    };
  }

  const metadataRejection = validateMatchAgainstChunk({
    match: input.match,
    chunk,
    filter: input.request.filter,
    expectedDimensions: input.expectedDimensions,
    minScore: input.minScore
  });
  if (metadataRejection) {
    return { rejection: metadataRejection };
  }

  return {
    candidate: {
      chunk,
      vector: {
        id: input.match.id,
        chunkId: input.match.chunkId,
        documentId: input.match.documentId,
        tenantId: input.match.tenantId,
        namespaceId: input.match.namespaceId,
        textHash: input.match.textHash,
        embeddingModel: input.match.embeddingModel,
        dimensions: input.match.dimensions,
        vector: input.match.vector,
        embeddedAt: input.match.embeddedAt
      },
      score: roundScore(input.match.score),
      rank: 0,
      reasons:
        input.match.reasons && input.match.reasons.length > 0
          ? input.match.reasons
          : ["hosted_vector_similarity"]
    }
  };
}

function validateHostedMatch(
  match: HostedVectorSearchMatch,
  queryDimensions: number
): VectorSearchRejection | undefined {
  if (
    !isNonBlankString(match.id) ||
    !isNonBlankString(match.chunkId) ||
    !isNonBlankString(match.documentId) ||
    !isNonBlankString(match.tenantId) ||
    !isNonBlankString(match.namespaceId) ||
    !isNonBlankString(match.textHash) ||
    !isNonBlankString(match.embeddingModel) ||
    !isNonBlankString(match.embeddedAt)
  ) {
    return {
      code: "access_denied_or_missing_chunk",
      reason: "Hosted vector match was missing required identity metadata."
    };
  }

  if (!Number.isFinite(match.score)) {
    return {
      chunkId: match.chunkId,
      code: "no_vector_match",
      reason: "Hosted vector match score was invalid."
    };
  }

  if (!Array.isArray(match.vector) || !isFiniteVector(match.vector)) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted vector match did not include finite vector values."
    };
  }

  if (!Number.isInteger(match.dimensions) || match.dimensions < 1) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted vector match dimensions were invalid."
    };
  }

  if (match.dimensions !== match.vector.length || match.vector.length !== queryDimensions) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted vector match dimensions did not match the query vector."
    };
  }

  return undefined;
}

function validateMatchAgainstChunk(input: {
  readonly match: HostedVectorSearchMatch;
  readonly chunk: RagChunk;
  readonly filter: IndexFilter;
  readonly expectedDimensions: number | undefined;
  readonly minScore: number;
}): VectorSearchRejection | undefined {
  if (
    input.match.tenantId !== input.filter.tenantId ||
    input.match.tenantId !== input.chunk.accessScope.tenantId ||
    input.match.namespaceId !== input.filter.namespaceId ||
    input.match.namespaceId !== input.chunk.namespaceId
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "access_denied_or_missing_chunk",
      reason: "Hosted vector match namespace did not match the local access filter."
    };
  }

  if (
    input.match.documentId !== input.chunk.documentId ||
    input.match.textHash !== input.chunk.textHash
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "stale_vector",
      reason: "Hosted vector match metadata no longer matches the indexed chunk."
    };
  }

  if (
    input.expectedDimensions !== undefined &&
    input.match.dimensions !== input.expectedDimensions
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted vector match dimensions do not match the configured store dimensions."
    };
  }

  if (input.match.score < input.minScore) {
    return {
      chunkId: input.match.chunkId,
      code: "no_vector_match",
      reason: "Hosted vector match score was below the configured minimum."
    };
  }

  return undefined;
}

function compareVectorCandidates(
  first: VectorSearchCandidate,
  second: VectorSearchCandidate
): number {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  if (first.chunk.documentId !== second.chunk.documentId) {
    return first.chunk.documentId.localeCompare(second.chunk.documentId);
  }

  if (first.chunk.index !== second.chunk.index) {
    return first.chunk.index - second.chunk.index;
  }

  return first.chunk.id.localeCompare(second.chunk.id);
}

function roundScore(score: number): number {
  return Math.round(score * 1000000) / 1000000;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
