import type { RagChunk } from "../documents/chunk.js";
import type { LayoutBox } from "../documents/layout.js";
import type { CitationVisualAsset } from "../documents/provenance.js";
import { isValidIndexFilter } from "./index-filter.js";
import type { ChunkStore } from "./chunk-store.js";
import type { IndexFilter, IndexOperationResult, IndexOverwriteMode } from "./index-types.js";
import { cosineSimilarity, isFiniteVector } from "../shared/vector-math.js";

export interface VisualChunkVector {
  readonly id: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly textHash: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly vectors: readonly (readonly number[])[];
  readonly embeddedAt: string;
  readonly visualAssetId?: string;
  readonly visualAsset?: CitationVisualAsset;
  readonly pageNumber?: number;
  readonly layoutRegionIds?: readonly string[];
  readonly boundingBoxes?: readonly LayoutBox[];
}

export interface IndexedVisualChunkVector {
  readonly visualVector: VisualChunkVector;
  readonly indexedAt: string;
  readonly updatedAt?: string;
}

export interface VisualVectorSnapshot {
  readonly version: 1;
  readonly vectors: readonly IndexedVisualChunkVector[];
}

export interface VisualVectorIndexOptions {
  readonly overwriteMode?: IndexOverwriteMode;
  readonly indexedAt?: string;
}

export type VisualVectorStorageKind = "memory" | "json_file" | "hosted";

export interface VisualVectorStoreCapabilities {
  readonly storageKind: VisualVectorStorageKind;
  readonly durable: boolean;
  readonly enforcesAccessFilters: boolean;
  readonly supportsLateInteraction: boolean;
  readonly dimensions?: number;
}

export type VisualVectorSearchRejectionCode =
  | "invalid_filter"
  | "access_denied_or_missing_chunk"
  | "stale_vector"
  | "vector_dimension_mismatch"
  | "no_visual_match";

export interface VisualVectorSearchRejection {
  readonly chunkId?: string;
  readonly code: VisualVectorSearchRejectionCode;
  readonly reason: string;
}

export interface VisualVectorSearchCandidate {
  readonly chunk: RagChunk;
  readonly visualVector: VisualChunkVector;
  readonly score: number;
  readonly rank: number;
  readonly reasons: readonly string[];
}

export interface VisualVectorSearchRequest {
  readonly vectors: readonly (readonly number[])[];
  readonly filter: IndexFilter;
  readonly topK: number;
  readonly candidatePoolLimit?: number;
  readonly includeRejected?: boolean;
  readonly minScore?: number;
}

export interface VisualVectorSearchResult {
  readonly candidates: readonly VisualVectorSearchCandidate[];
  readonly rejected: readonly VisualVectorSearchRejection[];
  readonly candidatePoolSize: number;
}

export type VisualVectorStoreOperationResult<T> = T | Promise<T>;

export interface VisualVectorStore {
  readonly capabilities: VisualVectorStoreCapabilities;
  addVisualChunkVectors(
    vectors: readonly VisualChunkVector[],
    options?: VisualVectorIndexOptions
  ): VisualVectorStoreOperationResult<readonly IndexOperationResult[]>;
  deleteVisualVectorsForDocument(documentId: string): VisualVectorStoreOperationResult<number>;
  findNearestVisualVectors(
    request: VisualVectorSearchRequest
  ): VisualVectorStoreOperationResult<VisualVectorSearchResult>;
  snapshot(): VisualVectorStoreOperationResult<VisualVectorSnapshot>;
  visualVectorCount(): VisualVectorStoreOperationResult<number>;
}

export interface InMemoryVisualVectorStoreOptions {
  readonly chunkStore: ChunkStore;
  readonly dimensions?: number;
  readonly now?: () => string;
  readonly snapshot?: VisualVectorSnapshot;
}

export class InMemoryVisualVectorStore implements VisualVectorStore {
  readonly capabilities: VisualVectorStoreCapabilities;

  private readonly chunkStore: ChunkStore;
  private readonly vectors = new Map<string, IndexedVisualChunkVector>();
  private readonly dimensions: number | undefined;
  private readonly now: () => string;

  constructor(options: InMemoryVisualVectorStoreOptions) {
    this.chunkStore = options.chunkStore;
    this.dimensions = options.dimensions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      storageKind: "memory",
      durable: false,
      enforcesAccessFilters: true,
      supportsLateInteraction: true,
      ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {})
    };

    if (
      this.dimensions !== undefined &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1)
    ) {
      throw new Error("Visual vector store dimensions must be a positive integer.");
    }

    if (options.snapshot) {
      loadVisualVectorsFromSnapshot(this.vectors, options.snapshot, this.dimensions);
    }
  }

  addVisualChunkVectors(
    vectors: readonly VisualChunkVector[],
    options: VisualVectorIndexOptions = {}
  ): readonly IndexOperationResult[] {
    const overwriteMode = options.overwriteMode ?? "reject";
    const indexedAt = options.indexedAt ?? this.now();
    const results: IndexOperationResult[] = [];
    const seenIds = new Set<string>();

    for (const vector of vectors) {
      validateVisualChunkVector(vector, this.dimensions, seenIds);
      seenIds.add(vector.id);

      const existing = this.vectors.get(vector.id);
      if (existing && overwriteMode === "reject") {
        throw new Error(`Visual chunk vector "${vector.id}" is already indexed.`);
      }

      this.vectors.set(vector.id, {
        visualVector: vector,
        indexedAt: existing?.indexedAt ?? indexedAt,
        ...(existing ? { updatedAt: indexedAt } : {})
      });
      results.push({
        accepted: true,
        id: vector.id,
        message: existing ? "Visual chunk vector replaced." : "Visual chunk vector indexed."
      });
    }

    return results;
  }

  deleteVisualVectorsForDocument(documentId: string): number {
    let deleted = 0;
    for (const [vectorId, indexed] of this.vectors.entries()) {
      if (indexed.visualVector.documentId === documentId) {
        this.vectors.delete(vectorId);
        deleted += 1;
      }
    }

    return deleted;
  }

  findNearestVisualVectors(request: VisualVectorSearchRequest): VisualVectorSearchResult {
    validateVisualVectorSearchRequest(request, this.dimensions);

    if (!isValidIndexFilter(request.filter)) {
      return {
        candidates: [],
        rejected: [
          {
            code: "invalid_filter",
            reason: "Visual vector search requires a valid tenant, namespace, and principal filter."
          }
        ],
        candidatePoolSize: 0
      };
    }

    const rejected: VisualVectorSearchRejection[] = [];
    const scored: VisualVectorSearchCandidate[] = [];
    const minScore = request.minScore ?? Number.NEGATIVE_INFINITY;

    for (const indexed of [...this.vectors.values()].sort(compareIndexedVisualVectors)) {
      const visualVector = indexed.visualVector;
      const indexedChunk = this.chunkStore.getChunk(visualVector.chunkId, request.filter);
      if (isPromiseLike(indexedChunk)) {
        throw new Error("InMemoryVisualVectorStore requires a synchronous chunk store.");
      }
      const chunk = indexedChunk?.chunk;
      if (!chunk) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: visualVector.chunkId,
            code: "access_denied_or_missing_chunk",
            reason: "Visual chunk vector did not pass the index access filter."
          });
        }
        continue;
      }

      if (
        chunk.documentId !== visualVector.documentId ||
        chunk.accessScope.tenantId !== visualVector.tenantId ||
        chunk.namespaceId !== visualVector.namespaceId ||
        chunk.textHash !== visualVector.textHash
      ) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: visualVector.chunkId,
            code: "stale_vector",
            reason: "Visual chunk vector metadata no longer matches the indexed chunk."
          });
        }
        continue;
      }

      if (visualVector.dimensions !== request.vectors[0]?.length) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: visualVector.chunkId,
            code: "vector_dimension_mismatch",
            reason: "Visual chunk vector dimensions do not match the query vectors."
          });
        }
        continue;
      }

      const score = roundScore(lateInteractionScore(request.vectors, visualVector.vectors));
      if (score < minScore) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: visualVector.chunkId,
            code: "no_visual_match",
            reason: "Visual chunk vector score was below the configured minimum."
          });
        }
        continue;
      }

      scored.push({
        chunk,
        visualVector,
        score,
        rank: 0,
        reasons: ["visual_late_interaction_maxsim"]
      });
    }

    const candidatePoolSize = scored.length;
    const candidatePool = scored
      .sort(compareVisualVectorCandidates)
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

  visualVectorCount(): number {
    return this.vectors.size;
  }

  snapshot(): VisualVectorSnapshot {
    return {
      version: 1,
      vectors: [...this.vectors.values()].sort(compareIndexedVisualVectors)
    };
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

export function validateVisualChunkVector(
  vector: VisualChunkVector,
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
      "Visual chunk vector id, chunkId, documentId, tenantId, namespaceId, textHash, model, and embeddedAt are required."
    );
  }

  if (seenIds.has(vector.id)) {
    throw new Error(`Visual chunk vector "${vector.id}" is duplicated in the same index request.`);
  }

  if (!Number.isInteger(vector.dimensions) || vector.dimensions < 1) {
    throw new Error(`Visual chunk vector "${vector.id}" dimensions must be a positive integer.`);
  }

  if (!Array.isArray(vector.vectors) || vector.vectors.length === 0) {
    throw new Error(`Visual chunk vector "${vector.id}" must include at least one patch vector.`);
  }

  for (const patchVector of vector.vectors) {
    if (!Array.isArray(patchVector) || !isFiniteVector(patchVector)) {
      throw new Error(`Visual chunk vector "${vector.id}" must contain finite numeric values.`);
    }

    if (patchVector.length !== vector.dimensions) {
      throw new Error(`Visual chunk vector "${vector.id}" dimensions must match vector length.`);
    }
  }

  if (expectedDimensions !== undefined && vector.dimensions !== expectedDimensions) {
    throw new Error(
      `Visual chunk vector "${vector.id}" dimensions ${vector.dimensions} do not match store dimensions ${expectedDimensions}.`
    );
  }

  if (
    vector.pageNumber !== undefined &&
    (!Number.isInteger(vector.pageNumber) || vector.pageNumber < 1)
  ) {
    throw new Error(`Visual chunk vector "${vector.id}" pageNumber must be a positive integer.`);
  }

  validateCitationVisualAsset(vector);
  validateLayoutEvidence(vector);
}

export function validateVisualVectorSearchRequest(
  request: VisualVectorSearchRequest,
  expectedDimensions: number | undefined
): void {
  if (!Array.isArray(request.vectors) || request.vectors.length === 0) {
    throw new Error("Visual vector search query must include at least one query vector.");
  }

  for (const queryVector of request.vectors) {
    if (!isFiniteVector(queryVector)) {
      throw new Error("Visual vector search query vectors must contain finite numeric values.");
    }

    if (expectedDimensions !== undefined && queryVector.length !== expectedDimensions) {
      throw new Error(
        `Visual vector search query dimensions ${queryVector.length} do not match store dimensions ${expectedDimensions}.`
      );
    }

    if (queryVector.length !== request.vectors[0]?.length) {
      throw new Error("Visual vector search query vectors must all share the same dimensions.");
    }
  }

  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 100) {
    throw new Error("Visual vector search topK must be an integer between 1 and 100.");
  }

  if (
    request.candidatePoolLimit !== undefined &&
    (!Number.isInteger(request.candidatePoolLimit) ||
      request.candidatePoolLimit < request.topK ||
      request.candidatePoolLimit > 5000)
  ) {
    throw new Error(
      "Visual vector search candidatePoolLimit must be an integer between topK and 5000."
    );
  }
}

function loadVisualVectorsFromSnapshot(
  target: Map<string, IndexedVisualChunkVector>,
  snapshot: VisualVectorSnapshot,
  expectedDimensions: number | undefined
): void {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.vectors)) {
    throw new Error("Invalid visual vector snapshot.");
  }

  const seenIds = new Set<string>();
  for (const indexed of snapshot.vectors) {
    validateIndexedVisualChunkVector(indexed, expectedDimensions, seenIds);
    seenIds.add(indexed.visualVector.id);
    target.set(indexed.visualVector.id, indexed);
  }
}

function validateIndexedVisualChunkVector(
  indexed: IndexedVisualChunkVector,
  expectedDimensions: number | undefined,
  seenIds: ReadonlySet<string>
): void {
  if (!isRecord(indexed)) {
    throw new Error("Indexed visual chunk vector must be an object.");
  }

  if (typeof indexed.indexedAt !== "string" || !indexed.indexedAt.trim()) {
    throw new Error("Indexed visual chunk vector indexedAt is required.");
  }

  if (
    indexed.updatedAt !== undefined &&
    (typeof indexed.updatedAt !== "string" || !indexed.updatedAt.trim())
  ) {
    throw new Error("Indexed visual chunk vector updatedAt cannot be blank.");
  }

  if (!isRecord(indexed.visualVector)) {
    throw new Error("Indexed visual chunk vector payload is required.");
  }

  validateVisualChunkVector(
    indexed.visualVector as unknown as VisualChunkVector,
    expectedDimensions,
    seenIds
  );
}

function lateInteractionScore(
  queryVectors: readonly (readonly number[])[],
  documentVectors: readonly (readonly number[])[]
): number {
  const score = queryVectors.reduce((sum, queryVector) => {
    const bestPatchScore = documentVectors.reduce(
      (best, documentVector) => Math.max(best, cosineSimilarity(queryVector, documentVector)),
      Number.NEGATIVE_INFINITY
    );
    return sum + bestPatchScore;
  }, 0);

  return score / queryVectors.length;
}

function validateLayoutEvidence(vector: VisualChunkVector): void {
  if (vector.layoutRegionIds !== undefined) {
    for (const regionId of vector.layoutRegionIds) {
      if (!isNonBlankString(regionId)) {
        throw new Error(`Visual chunk vector "${vector.id}" layoutRegionIds cannot be blank.`);
      }
    }
  }

  if (vector.boundingBoxes !== undefined) {
    for (const box of vector.boundingBoxes) {
      if (
        !Number.isInteger(box.pageNumber) ||
        box.pageNumber < 1 ||
        !Number.isFinite(box.x) ||
        !Number.isFinite(box.y) ||
        !Number.isFinite(box.width) ||
        !Number.isFinite(box.height) ||
        box.width < 0 ||
        box.height < 0
      ) {
        throw new Error(`Visual chunk vector "${vector.id}" boundingBoxes must be finite.`);
      }
    }
  }
}

function validateCitationVisualAsset(vector: VisualChunkVector): void {
  const asset = vector.visualAsset;
  if (asset === undefined) {
    return;
  }

  if (!isRecord(asset) || !isNonBlankString(asset.id)) {
    throw new Error(`Visual chunk vector "${vector.id}" visualAsset id is required.`);
  }

  for (const key of [
    "kind",
    "mediaType",
    "assetType",
    "title",
    "chartType",
    "sheetName",
    "anchorCell",
    "artifactKind"
  ] as const) {
    const value = asset[key];
    if (value !== undefined && !isNonBlankString(value)) {
      throw new Error(`Visual chunk vector "${vector.id}" visualAsset ${key} cannot be blank.`);
    }
  }

  if (
    asset.pageNumber !== undefined &&
    (!Number.isInteger(asset.pageNumber) || asset.pageNumber < 1)
  ) {
    throw new Error(
      `Visual chunk vector "${vector.id}" visualAsset pageNumber must be a positive integer.`
    );
  }
}

function compareIndexedVisualVectors(
  first: IndexedVisualChunkVector,
  second: IndexedVisualChunkVector
): number {
  return first.visualVector.id.localeCompare(second.visualVector.id);
}

function compareVisualVectorCandidates(
  first: VisualVectorSearchCandidate,
  second: VisualVectorSearchCandidate
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

  return first.visualVector.id.localeCompare(second.visualVector.id);
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
