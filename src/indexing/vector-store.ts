import type { RagChunk } from "../documents/chunk.js";
import { isValidIndexFilter } from "./index-filter.js";
import type { ChunkStore } from "./chunk-store.js";
import type { IndexFilter, IndexOperationResult, IndexOverwriteMode } from "./index-types.js";
import {
  LOCAL_VECTOR_SCALE_CAPABILITIES,
  type StorageScaleCapabilities
} from "./scale-capabilities.js";
import { cosineSimilarity, isFiniteVector } from "../shared/vector-math.js";

export interface ChunkVector {
  readonly id: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly textHash: string;
  readonly embeddingModel: string;
  readonly embeddingProvider?: string;
  readonly embeddingConfigHash?: string;
  readonly dimensions: number;
  readonly vector: readonly number[];
  readonly embeddedAt: string;
  readonly metadata?: ChunkVectorMetadata;
}

export type ChunkVectorMetadataValue = string | number | boolean;
export type ChunkVectorMetadata = Readonly<Record<string, ChunkVectorMetadataValue>>;

export interface IndexedChunkVector {
  readonly vector: ChunkVector;
  readonly indexedAt: string;
  readonly updatedAt?: string;
}

export interface VectorSnapshot {
  readonly version: 1;
  readonly vectors: readonly IndexedChunkVector[];
}

export interface VectorIndexOptions {
  readonly overwriteMode?: IndexOverwriteMode;
  readonly indexedAt?: string;
}

export type VectorStorageKind = "memory" | "json_file" | "hosted" | "postgres";

export interface VectorStoreCapabilities {
  readonly storageKind: VectorStorageKind;
  readonly durable: boolean;
  readonly enforcesAccessFilters: boolean;
  readonly supportsCosineSimilarity: boolean;
  readonly dimensions?: number;
  readonly scale?: StorageScaleCapabilities;
}

export type VectorSearchRejectionCode =
  | "invalid_filter"
  | "access_denied_or_missing_chunk"
  | "stale_vector"
  | "embedding_identity_mismatch"
  | "vector_dimension_mismatch"
  | "no_vector_match";

export interface VectorSearchRejection {
  readonly chunkId?: string;
  readonly code: VectorSearchRejectionCode;
  readonly reason: string;
}

export interface VectorSearchCandidate {
  readonly chunk: RagChunk;
  readonly vector: ChunkVector;
  readonly score: number;
  readonly rank: number;
  readonly reasons: readonly string[];
}

export interface VectorSearchRequest {
  readonly vector: readonly number[];
  readonly filter: IndexFilter;
  readonly topK: number;
  readonly embeddingModel?: string;
  readonly embeddingProvider?: string;
  readonly embeddingConfigHash?: string;
  readonly candidatePoolLimit?: number;
  readonly includeRejected?: boolean;
  readonly minScore?: number;
}

export interface VectorSearchResult {
  readonly candidates: readonly VectorSearchCandidate[];
  readonly rejected: readonly VectorSearchRejection[];
  readonly candidatePoolSize: number;
}

export type VectorStoreOperationResult<T> = T | Promise<T>;

export interface VectorStore {
  readonly capabilities: VectorStoreCapabilities;
  addChunkVectors(
    vectors: readonly ChunkVector[],
    options?: VectorIndexOptions
  ): VectorStoreOperationResult<readonly IndexOperationResult[]>;
  deleteVectorsForDocument(documentId: string): VectorStoreOperationResult<number>;
  findNearestVectors(request: VectorSearchRequest): VectorStoreOperationResult<VectorSearchResult>;
  snapshot(): VectorStoreOperationResult<VectorSnapshot>;
  vectorCount(): VectorStoreOperationResult<number>;
}

export interface InMemoryVectorStoreOptions {
  readonly chunkStore: ChunkStore;
  readonly dimensions?: number;
  readonly now?: () => string;
  readonly snapshot?: VectorSnapshot;
}

export class InMemoryVectorStore implements VectorStore {
  readonly capabilities: VectorStoreCapabilities;

  private readonly chunkStore: ChunkStore;
  private readonly vectors = new Map<string, IndexedChunkVector>();
  private readonly dimensions: number | undefined;
  private readonly now: () => string;

  constructor(options: InMemoryVectorStoreOptions) {
    this.chunkStore = options.chunkStore;
    this.dimensions = options.dimensions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      storageKind: "memory",
      durable: false,
      enforcesAccessFilters: true,
      supportsCosineSimilarity: true,
      scale: LOCAL_VECTOR_SCALE_CAPABILITIES,
      ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {})
    };

    if (
      this.dimensions !== undefined &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1)
    ) {
      throw new Error("Vector store dimensions must be a positive integer.");
    }

    if (options.snapshot) {
      loadVectorsFromSnapshot(this.vectors, options.snapshot, this.dimensions);
    }
  }

  addChunkVectors(
    vectors: readonly ChunkVector[],
    options: VectorIndexOptions = {}
  ): readonly IndexOperationResult[] {
    const overwriteMode = options.overwriteMode ?? "reject";
    const indexedAt = options.indexedAt ?? this.now();
    const results: IndexOperationResult[] = [];
    const seenIds = new Set<string>();

    for (const vector of vectors) {
      validateChunkVector(vector, this.dimensions, seenIds);
      seenIds.add(vector.id);

      const existing = this.vectors.get(vector.id);
      if (existing && overwriteMode === "reject") {
        throw new Error(`Chunk vector "${vector.id}" is already indexed.`);
      }

      this.vectors.set(vector.id, {
        vector,
        indexedAt: existing?.indexedAt ?? indexedAt,
        ...(existing ? { updatedAt: indexedAt } : {})
      });
      results.push({
        accepted: true,
        id: vector.id,
        message: existing ? "Chunk vector replaced." : "Chunk vector indexed."
      });
    }

    return results;
  }

  deleteVectorsForDocument(documentId: string): number {
    let deleted = 0;
    for (const [vectorId, indexed] of this.vectors.entries()) {
      if (indexed.vector.documentId === documentId) {
        this.vectors.delete(vectorId);
        deleted += 1;
      }
    }

    return deleted;
  }

  findNearestVectors(request: VectorSearchRequest): VectorSearchResult {
    validateVectorSearchRequest(request, this.dimensions);

    if (!isValidIndexFilter(request.filter)) {
      return {
        candidates: [],
        rejected: [
          {
            code: "invalid_filter",
            reason: "Vector search requires a valid tenant, namespace, and principal filter."
          }
        ],
        candidatePoolSize: 0
      };
    }

    const rejected: VectorSearchRejection[] = [];
    const scored: VectorSearchCandidate[] = [];
    const minScore = request.minScore ?? Number.NEGATIVE_INFINITY;

    for (const indexed of [...this.vectors.values()].sort(compareIndexedVectors)) {
      const indexedChunk = this.chunkStore.getChunk(indexed.vector.chunkId, request.filter);
      if (isPromiseLike(indexedChunk)) {
        throw new Error("InMemoryVectorStore requires a synchronous chunk store.");
      }
      const chunk = indexedChunk?.chunk;
      if (!chunk) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "access_denied_or_missing_chunk",
            reason: "Chunk vector did not pass the index access filter."
          });
        }
        continue;
      }

      if (
        chunk.documentId !== indexed.vector.documentId ||
        chunk.accessScope.tenantId !== indexed.vector.tenantId ||
        chunk.namespaceId !== indexed.vector.namespaceId ||
        chunk.textHash !== indexed.vector.textHash
      ) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "stale_vector",
            reason: "Chunk vector metadata no longer matches the indexed chunk."
          });
        }
        continue;
      }

      if (indexed.vector.vector.length !== request.vector.length) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "vector_dimension_mismatch",
            reason: "Chunk vector dimensions do not match the query vector."
          });
        }
        continue;
      }

      const identityMismatch = embeddingIdentityMismatch(indexed.vector, request);
      if (identityMismatch) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "embedding_identity_mismatch",
            reason: identityMismatch
          });
        }
        continue;
      }

      const score = roundScore(cosineSimilarity(request.vector, indexed.vector.vector));
      if (score < minScore) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: indexed.vector.chunkId,
            code: "no_vector_match",
            reason: "Chunk vector score was below the configured minimum."
          });
        }
        continue;
      }

      scored.push({
        chunk,
        vector: indexed.vector,
        score,
        rank: 0,
        reasons: ["vector_cosine_similarity"]
      });
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

  vectorCount(): number {
    return this.vectors.size;
  }

  snapshot(): VectorSnapshot {
    return {
      version: 1,
      vectors: [...this.vectors.values()].sort(compareIndexedVectors)
    };
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

export function validateChunkVector(
  vector: ChunkVector,
  expectedDimensions: number | undefined,
  seenIds: ReadonlySet<string>
): void {
  if (
    !isNonBlankString(vector.id) ||
    !isNonBlankString(vector.chunkId) ||
    !isNonBlankString(vector.documentId) ||
    !isNonBlankString(vector.tenantId) ||
    !isNonBlankString(vector.namespaceId) ||
    !isNonBlankString(vector.textHash) ||
    !isNonBlankString(vector.embeddingModel) ||
    !isNonBlankString(vector.embeddedAt)
  ) {
    throw new Error(
      "Chunk vector id, chunkId, documentId, tenantId, namespaceId, textHash, model, and embeddedAt are required."
    );
  }

  if (seenIds.has(vector.id)) {
    throw new Error(`Chunk vector "${vector.id}" is duplicated in the same index request.`);
  }

  if (!Array.isArray(vector.vector) || !isFiniteVector(vector.vector)) {
    throw new Error(`Chunk vector "${vector.id}" must contain finite numeric values.`);
  }

  if (!Number.isInteger(vector.dimensions) || vector.dimensions < 1) {
    throw new Error(`Chunk vector "${vector.id}" dimensions must be a positive integer.`);
  }

  if (vector.dimensions !== vector.vector.length) {
    throw new Error(`Chunk vector "${vector.id}" dimensions must match vector length.`);
  }

  if (expectedDimensions !== undefined && vector.dimensions !== expectedDimensions) {
    throw new Error(
      `Chunk vector "${vector.id}" dimensions ${vector.dimensions} do not match store dimensions ${expectedDimensions}.`
    );
  }

  validateChunkVectorMetadata(vector);
}

function validateChunkVectorMetadata(vector: ChunkVector): void {
  if (vector.metadata === undefined) {
    return;
  }

  if (!isRecord(vector.metadata) || Array.isArray(vector.metadata)) {
    throw new Error(`Chunk vector "${vector.id}" metadata must be an object.`);
  }

  for (const [key, value] of Object.entries(vector.metadata)) {
    if (!key.trim()) {
      throw new Error(`Chunk vector "${vector.id}" metadata keys cannot be blank.`);
    }

    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error(
        `Chunk vector "${vector.id}" metadata values must be strings, finite numbers, or booleans.`
      );
    }
  }
}

function loadVectorsFromSnapshot(
  target: Map<string, IndexedChunkVector>,
  snapshot: VectorSnapshot,
  expectedDimensions: number | undefined
): void {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.vectors)) {
    throw new Error("Invalid vector snapshot.");
  }

  const seenIds = new Set<string>();
  for (const indexed of snapshot.vectors) {
    validateIndexedChunkVector(indexed, expectedDimensions, seenIds);
    seenIds.add(indexed.vector.id);
    target.set(indexed.vector.id, indexed);
  }
}

function validateIndexedChunkVector(
  indexed: IndexedChunkVector,
  expectedDimensions: number | undefined,
  seenIds: ReadonlySet<string>
): void {
  if (!isRecord(indexed)) {
    throw new Error("Indexed chunk vector must be an object.");
  }

  if (typeof indexed.indexedAt !== "string" || !indexed.indexedAt.trim()) {
    throw new Error("Indexed chunk vector indexedAt is required.");
  }

  if (
    indexed.updatedAt !== undefined &&
    (typeof indexed.updatedAt !== "string" || !indexed.updatedAt.trim())
  ) {
    throw new Error("Indexed chunk vector updatedAt cannot be blank.");
  }

  if (!isRecord(indexed.vector)) {
    throw new Error("Indexed chunk vector payload is required.");
  }

  validateChunkVector(indexed.vector as unknown as ChunkVector, expectedDimensions, seenIds);
}

export function validateVectorSearchRequest(
  request: VectorSearchRequest,
  expectedDimensions: number | undefined
): void {
  if (!isFiniteVector(request.vector)) {
    throw new Error("Vector search query vector must contain finite numeric values.");
  }

  if (expectedDimensions !== undefined && request.vector.length !== expectedDimensions) {
    throw new Error(
      `Vector search query dimensions ${request.vector.length} do not match store dimensions ${expectedDimensions}.`
    );
  }

  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 100) {
    throw new Error("Vector search topK must be an integer between 1 and 100.");
  }

  validateOptionalIdentityField(request.embeddingModel, "embeddingModel");
  validateOptionalIdentityField(request.embeddingProvider, "embeddingProvider");
  validateOptionalIdentityField(request.embeddingConfigHash, "embeddingConfigHash");

  if (
    request.candidatePoolLimit !== undefined &&
    (!Number.isInteger(request.candidatePoolLimit) ||
      request.candidatePoolLimit < request.topK ||
      request.candidatePoolLimit > 5000)
  ) {
    throw new Error("Vector search candidatePoolLimit must be an integer between topK and 5000.");
  }
}

function embeddingIdentityMismatch(
  vector: ChunkVector,
  request: VectorSearchRequest
): string | undefined {
  if (request.embeddingModel !== undefined && vector.embeddingModel !== request.embeddingModel) {
    return "Chunk vector embedding model does not match the query embedding model.";
  }

  if (
    request.embeddingProvider !== undefined &&
    vector.embeddingProvider !== request.embeddingProvider
  ) {
    return "Chunk vector embedding provider does not match the query embedding provider.";
  }

  if (
    request.embeddingConfigHash !== undefined &&
    vector.embeddingConfigHash !== request.embeddingConfigHash
  ) {
    return "Chunk vector embedding config hash does not match the query embedding config hash.";
  }

  return undefined;
}

function validateOptionalIdentityField(value: string | undefined, fieldName: string): void {
  if (value !== undefined && !value.trim()) {
    throw new Error(`Vector search ${fieldName} cannot be blank.`);
  }
}

function compareIndexedVectors(first: IndexedChunkVector, second: IndexedChunkVector): number {
  return first.vector.id.localeCompare(second.vector.id);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
