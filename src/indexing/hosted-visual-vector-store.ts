import type { RagChunk } from "../documents/chunk.js";
import type { LayoutBox } from "../documents/layout.js";
import type { CitationVisualAsset } from "../documents/provenance.js";
import { isFiniteVector } from "../shared/vector-math.js";
import type { ChunkStore } from "./chunk-store.js";
import type { HostedVectorSearchMatch, HostedVectorStoreTransport } from "./hosted-vector-store.js";
import { isValidIndexFilter } from "./index-filter.js";
import type { IndexFilter, IndexOperationResult } from "./index-types.js";
import type { ChunkVector, ChunkVectorMetadata } from "./vector-store.js";
import {
  type VisualChunkVector,
  type VisualVectorIndexOptions,
  type VisualVectorSearchCandidate,
  type VisualVectorSearchRejection,
  type VisualVectorSearchRequest,
  type VisualVectorSearchResult,
  type VisualVectorSnapshot,
  type VisualVectorStore,
  type VisualVectorStoreCapabilities,
  validateVisualChunkVector,
  validateVisualVectorSearchRequest
} from "./visual-vector-store.js";

const DEFAULT_PATCH_LIMIT_MULTIPLIER = 8;
const DEFAULT_PATCH_LIMIT_FLOOR = 32;
const MAX_PATCH_QUERY_LIMIT = 5000;
const VISUAL_PATCH_ID_SEPARATOR = "#visual_patch:";

export interface HostedVisualVectorStoreOptions {
  readonly chunkStore: ChunkStore;
  readonly transport: HostedVectorStoreTransport;
  readonly dimensions?: number;
  readonly now?: () => string;
}

interface HostedVisualPatch {
  readonly match: HostedVectorSearchMatch;
  readonly chunk: RagChunk;
  readonly visualVectorId: string;
  readonly patchIndex: number;
  readonly patchCount: number;
  readonly queryIndex: number;
  readonly visualAssetId?: string;
  readonly visualAsset?: CitationVisualAsset;
  readonly pageNumber?: number;
  readonly layoutRegionIds?: readonly string[];
  readonly boundingBoxes?: readonly LayoutBox[];
}

interface HostedVisualGroup {
  readonly visualVectorId: string;
  readonly chunk: RagChunk;
  readonly patchCount: number;
  readonly documentId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly textHash: string;
  readonly embeddingModel: string;
  readonly embeddedAt: string;
  readonly dimensions: number;
  readonly visualAssetId?: string;
  readonly visualAsset?: CitationVisualAsset;
  readonly pageNumber?: number;
  readonly layoutRegionIds?: readonly string[];
  readonly boundingBoxes?: readonly LayoutBox[];
  readonly patchesByIndex: Map<number, HostedVectorSearchMatch>;
  readonly queryScores: Map<number, number>;
  readonly reasons: Set<string>;
}

export class HostedVisualVectorStore implements VisualVectorStore {
  readonly capabilities: VisualVectorStoreCapabilities;

  private readonly chunkStore: ChunkStore;
  private readonly transport: HostedVectorStoreTransport;
  private readonly dimensions: number | undefined;
  private readonly now: () => string;

  constructor(options: HostedVisualVectorStoreOptions) {
    this.chunkStore = options.chunkStore;
    this.transport = options.transport;
    this.dimensions = options.dimensions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      storageKind: "hosted",
      durable: true,
      enforcesAccessFilters: true,
      supportsLateInteraction: true,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions })
    };

    if (
      this.dimensions !== undefined &&
      (!Number.isInteger(this.dimensions) || this.dimensions < 1)
    ) {
      throw new Error("Hosted visual vector store dimensions must be a positive integer.");
    }
  }

  async addVisualChunkVectors(
    vectors: readonly VisualChunkVector[],
    options: VisualVectorIndexOptions = {}
  ): Promise<readonly IndexOperationResult[]> {
    const seenIds = new Set<string>();
    for (const vector of vectors) {
      validateVisualChunkVector(vector, this.dimensions, seenIds);
      seenIds.add(vector.id);
    }

    const patchVectors = vectors.flatMap((vector) => visualPatchVectors(vector));
    const upserted = await this.transport.upsert({
      vectors: patchVectors,
      overwriteMode: options.overwriteMode ?? "reject",
      indexedAt: options.indexedAt ?? this.now()
    });

    return summarizeVisualUpsert(vectors, upserted.results);
  }

  async deleteVisualVectorsForDocument(documentId: string): Promise<number> {
    if (!documentId.trim()) {
      throw new Error("Hosted visual vector delete requires a documentId.");
    }

    const result = await this.transport.deleteByDocument({ documentId });
    return result.deletedCount;
  }

  async findNearestVisualVectors(
    request: VisualVectorSearchRequest
  ): Promise<VisualVectorSearchResult> {
    validateVisualVectorSearchRequest(request, this.dimensions);

    if (!isValidIndexFilter(request.filter)) {
      return {
        candidates: [],
        rejected: [
          {
            code: "invalid_filter",
            reason:
              "Hosted visual vector search requires a valid tenant, namespace, and principal filter."
          }
        ],
        candidatePoolSize: 0
      };
    }

    const queryLimit = hostedPatchQueryLimit(request);
    const hostedResults = await Promise.all(
      request.vectors.map((vector) =>
        this.transport.query({
          vector,
          tenantId: request.filter.tenantId,
          namespaceId: request.filter.namespaceId,
          topK: queryLimit,
          ...(request.candidatePoolLimit === undefined
            ? {}
            : { candidatePoolLimit: request.candidatePoolLimit }),
          ...(request.minScore === undefined ? {} : { minScore: request.minScore })
        })
      )
    );
    const rejected: VisualVectorSearchRejection[] = [];
    const groups = new Map<string, HostedVisualGroup>();

    for (const [queryIndex, hostedResult] of hostedResults.entries()) {
      for (const match of hostedResult.matches) {
        const evaluated = await evaluateHostedVisualPatch({
          match,
          queryDimensions: request.vectors[queryIndex]?.length ?? 0,
          queryIndex,
          request,
          chunkStore: this.chunkStore,
          expectedDimensions: this.dimensions
        });

        if (evaluated.patch) {
          const rejection = addPatchToGroups(groups, evaluated.patch);
          if (request.includeRejected && rejection) {
            rejected.push(rejection);
          }
        } else if (request.includeRejected && evaluated.rejection) {
          rejected.push(evaluated.rejection);
        }
      }
    }

    const scored: VisualVectorSearchCandidate[] = [];
    const minScore = request.minScore ?? Number.NEGATIVE_INFINITY;
    for (const group of [...groups.values()].sort(compareHostedVisualGroups)) {
      const candidate = buildCandidateFromGroup(group, request.vectors.length);
      if (candidate.rejection) {
        if (request.includeRejected) {
          rejected.push(candidate.rejection);
        }
        continue;
      }

      if (candidate.candidate.score < minScore) {
        if (request.includeRejected) {
          rejected.push({
            chunkId: group.chunk.id,
            code: "no_visual_match",
            reason: "Hosted visual vector score was below the configured minimum."
          });
        }
        continue;
      }

      scored.push(candidate.candidate);
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

  snapshot(): VisualVectorSnapshot {
    throw new Error("HostedVisualVectorStore does not expose local visual vector snapshots.");
  }

  async visualVectorCount(): Promise<number> {
    if (!this.transport.count) {
      throw new Error("Hosted visual vector transport does not expose vector counts.");
    }

    return this.transport.count({});
  }
}

function visualPatchVectors(vector: VisualChunkVector): readonly ChunkVector[] {
  return vector.vectors.map((patchVector, index) => ({
    id: visualPatchVectorId(vector.id, index),
    chunkId: vector.chunkId,
    documentId: vector.documentId,
    tenantId: vector.tenantId,
    namespaceId: vector.namespaceId,
    textHash: vector.textHash,
    embeddingModel: vector.embeddingModel,
    dimensions: vector.dimensions,
    vector: patchVector,
    embeddedAt: vector.embeddedAt,
    metadata: visualPatchMetadata(vector, index)
  }));
}

function visualPatchMetadata(vector: VisualChunkVector, patchIndex: number): ChunkVectorMetadata {
  return {
    visualVectorId: vector.id,
    visualPatchIndex: patchIndex,
    visualPatchCount: vector.vectors.length,
    ...(vector.visualAssetId === undefined ? {} : { visualAssetId: vector.visualAssetId }),
    ...(vector.visualAsset === undefined
      ? {}
      : { visualAssetJson: JSON.stringify(vector.visualAsset) }),
    ...(vector.pageNumber === undefined ? {} : { visualPageNumber: vector.pageNumber }),
    ...(vector.layoutRegionIds === undefined || vector.layoutRegionIds.length === 0
      ? {}
      : { visualLayoutRegionIdsJson: JSON.stringify(vector.layoutRegionIds) }),
    ...(vector.boundingBoxes === undefined || vector.boundingBoxes.length === 0
      ? {}
      : { visualBoundingBoxesJson: JSON.stringify(vector.boundingBoxes) })
  };
}

function summarizeVisualUpsert(
  visualVectors: readonly VisualChunkVector[],
  patchResults: readonly IndexOperationResult[]
): readonly IndexOperationResult[] {
  const patchResultsById = new Map(patchResults.map((result) => [result.id, result]));

  return visualVectors.map((vector) => {
    const patchIds = vector.vectors.map((_, index) => visualPatchVectorId(vector.id, index));
    const acceptedPatchCount = patchIds.filter((id) => patchResultsById.get(id)?.accepted).length;
    const accepted = acceptedPatchCount === patchIds.length;
    return {
      accepted,
      id: vector.id,
      message: accepted
        ? "Hosted visual chunk vector indexed."
        : `Hosted visual chunk vector indexed ${acceptedPatchCount} of ${patchIds.length} patch vectors.`
    };
  });
}

async function evaluateHostedVisualPatch(input: {
  readonly match: HostedVectorSearchMatch;
  readonly queryDimensions: number;
  readonly queryIndex: number;
  readonly request: VisualVectorSearchRequest;
  readonly chunkStore: ChunkStore;
  readonly expectedDimensions: number | undefined;
}): Promise<{
  readonly patch?: HostedVisualPatch;
  readonly rejection?: VisualVectorSearchRejection;
}> {
  const basicRejection = validateHostedPatchMatch(input.match, input.queryDimensions);
  if (basicRejection) {
    return { rejection: basicRejection };
  }

  const chunk = (await input.chunkStore.getChunk(input.match.chunkId, input.request.filter))?.chunk;
  if (!chunk) {
    return {
      rejection: {
        chunkId: input.match.chunkId,
        code: "access_denied_or_missing_chunk",
        reason: "Hosted visual vector match did not pass the local index access filter."
      }
    };
  }

  const metadataRejection = validateMatchAgainstChunk({
    match: input.match,
    chunk,
    filter: input.request.filter,
    expectedDimensions: input.expectedDimensions
  });
  if (metadataRejection) {
    return { rejection: metadataRejection };
  }

  const visualMetadata = visualMetadataFromMatch(input.match);
  if (visualMetadata.rejection) {
    return { rejection: visualMetadata.rejection };
  }

  return {
    patch: {
      match: input.match,
      chunk,
      visualVectorId: visualMetadata.value.visualVectorId,
      patchIndex: visualMetadata.value.patchIndex,
      patchCount: visualMetadata.value.patchCount,
      queryIndex: input.queryIndex,
      ...(visualMetadata.value.visualAssetId === undefined
        ? {}
        : { visualAssetId: visualMetadata.value.visualAssetId }),
      ...(visualMetadata.value.visualAsset === undefined
        ? {}
        : { visualAsset: visualMetadata.value.visualAsset }),
      ...(visualMetadata.value.pageNumber === undefined
        ? {}
        : { pageNumber: visualMetadata.value.pageNumber }),
      ...(visualMetadata.value.layoutRegionIds === undefined
        ? {}
        : { layoutRegionIds: visualMetadata.value.layoutRegionIds }),
      ...(visualMetadata.value.boundingBoxes === undefined
        ? {}
        : { boundingBoxes: visualMetadata.value.boundingBoxes })
    }
  };
}

function validateHostedPatchMatch(
  match: HostedVectorSearchMatch,
  queryDimensions: number
): VisualVectorSearchRejection | undefined {
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
      reason: "Hosted visual vector match was missing required identity metadata."
    };
  }

  if (!Number.isFinite(match.score)) {
    return {
      chunkId: match.chunkId,
      code: "no_visual_match",
      reason: "Hosted visual vector match score was invalid."
    };
  }

  if (!Array.isArray(match.vector) || !isFiniteVector(match.vector)) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted visual vector match did not include finite vector values."
    };
  }

  if (!Number.isInteger(match.dimensions) || match.dimensions < 1) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted visual vector match dimensions were invalid."
    };
  }

  if (match.dimensions !== match.vector.length || match.vector.length !== queryDimensions) {
    return {
      chunkId: match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted visual vector match dimensions did not match the query vector."
    };
  }

  return undefined;
}

function validateMatchAgainstChunk(input: {
  readonly match: HostedVectorSearchMatch;
  readonly chunk: RagChunk;
  readonly filter: IndexFilter;
  readonly expectedDimensions: number | undefined;
}): VisualVectorSearchRejection | undefined {
  if (
    input.match.tenantId !== input.filter.tenantId ||
    input.match.tenantId !== input.chunk.accessScope.tenantId ||
    input.match.namespaceId !== input.filter.namespaceId ||
    input.match.namespaceId !== input.chunk.namespaceId
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "access_denied_or_missing_chunk",
      reason: "Hosted visual vector match namespace did not match the local access filter."
    };
  }

  if (
    input.match.documentId !== input.chunk.documentId ||
    input.match.textHash !== input.chunk.textHash
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "stale_vector",
      reason: "Hosted visual vector match metadata no longer matches the indexed chunk."
    };
  }

  if (
    input.expectedDimensions !== undefined &&
    input.match.dimensions !== input.expectedDimensions
  ) {
    return {
      chunkId: input.match.chunkId,
      code: "vector_dimension_mismatch",
      reason: "Hosted visual vector match dimensions do not match the configured store dimensions."
    };
  }

  return undefined;
}

function visualMetadataFromMatch(match: HostedVectorSearchMatch):
  | {
      readonly value: {
        readonly visualVectorId: string;
        readonly patchIndex: number;
        readonly patchCount: number;
        readonly visualAssetId?: string;
        readonly visualAsset?: CitationVisualAsset;
        readonly pageNumber?: number;
        readonly layoutRegionIds?: readonly string[];
        readonly boundingBoxes?: readonly LayoutBox[];
      };
      readonly rejection?: undefined;
    }
  | {
      readonly value?: undefined;
      readonly rejection: VisualVectorSearchRejection;
    } {
  const metadata = match.metadata;
  const visualVectorId =
    metadataString(metadata, "visualVectorId") ?? parseVisualVectorId(match.id);
  const patchIndex = metadataInteger(metadata, "visualPatchIndex") ?? parsePatchIndex(match.id);
  const patchCount = metadataInteger(metadata, "visualPatchCount");

  if (
    !isNonBlankString(visualVectorId) ||
    patchIndex === undefined ||
    patchCount === undefined ||
    patchIndex < 0 ||
    patchCount < 1 ||
    patchIndex >= patchCount
  ) {
    return {
      rejection: {
        chunkId: match.chunkId,
        code: "stale_vector",
        reason: "Hosted visual vector match was missing visual patch metadata."
      }
    };
  }

  const visualAssetId = metadataString(metadata, "visualAssetId");
  const visualAsset = metadataJsonCitationVisualAsset(metadata, "visualAssetJson");
  if (visualAsset.status === "invalid") {
    return invalidVisualMetadata(match, "Hosted visual vector asset metadata was invalid.");
  }

  const pageNumber = metadataInteger(metadata, "visualPageNumber");
  if (pageNumber !== undefined && pageNumber < 1) {
    return invalidVisualMetadata(match, "Hosted visual vector page metadata was invalid.");
  }

  const layoutRegionIds = metadataJsonStringArray(metadata, "visualLayoutRegionIdsJson");
  if (layoutRegionIds.status === "invalid") {
    return invalidVisualMetadata(match, "Hosted visual vector layout region metadata was invalid.");
  }

  const boundingBoxes = metadataJsonLayoutBoxes(metadata, "visualBoundingBoxesJson");
  if (boundingBoxes.status === "invalid") {
    return invalidVisualMetadata(match, "Hosted visual vector bounding box metadata was invalid.");
  }

  return {
    value: {
      visualVectorId,
      patchIndex,
      patchCount,
      ...(visualAssetId === undefined ? {} : { visualAssetId }),
      ...(visualAsset.value === undefined ? {} : { visualAsset: visualAsset.value }),
      ...(pageNumber === undefined ? {} : { pageNumber }),
      ...(layoutRegionIds.value === undefined ? {} : { layoutRegionIds: layoutRegionIds.value }),
      ...(boundingBoxes.value === undefined ? {} : { boundingBoxes: boundingBoxes.value })
    }
  };
}

function invalidVisualMetadata(
  match: HostedVectorSearchMatch,
  reason: string
): { readonly rejection: VisualVectorSearchRejection } {
  return {
    rejection: {
      chunkId: match.chunkId,
      code: "stale_vector",
      reason
    }
  };
}

function addPatchToGroups(
  groups: Map<string, HostedVisualGroup>,
  patch: HostedVisualPatch
): VisualVectorSearchRejection | undefined {
  const existing = groups.get(patch.visualVectorId);
  if (existing === undefined) {
    groups.set(patch.visualVectorId, {
      visualVectorId: patch.visualVectorId,
      chunk: patch.chunk,
      patchCount: patch.patchCount,
      documentId: patch.match.documentId,
      tenantId: patch.match.tenantId,
      namespaceId: patch.match.namespaceId,
      textHash: patch.match.textHash,
      embeddingModel: patch.match.embeddingModel,
      embeddedAt: patch.match.embeddedAt,
      dimensions: patch.match.dimensions,
      ...(patch.visualAssetId === undefined ? {} : { visualAssetId: patch.visualAssetId }),
      ...(patch.visualAsset === undefined ? {} : { visualAsset: patch.visualAsset }),
      ...(patch.pageNumber === undefined ? {} : { pageNumber: patch.pageNumber }),
      ...(patch.layoutRegionIds === undefined ? {} : { layoutRegionIds: patch.layoutRegionIds }),
      ...(patch.boundingBoxes === undefined ? {} : { boundingBoxes: patch.boundingBoxes }),
      patchesByIndex: new Map([[patch.patchIndex, patch.match]]),
      queryScores: new Map([[patch.queryIndex, patch.match.score]]),
      reasons: new Set(patch.match.reasons ?? ["hosted_visual_patch_similarity"])
    });
    return undefined;
  }

  const rejection = validatePatchGroupConsistency(existing, patch);
  if (rejection) {
    return rejection;
  }

  if (!existing.patchesByIndex.has(patch.patchIndex)) {
    existing.patchesByIndex.set(patch.patchIndex, patch.match);
  }
  existing.queryScores.set(
    patch.queryIndex,
    Math.max(
      existing.queryScores.get(patch.queryIndex) ?? Number.NEGATIVE_INFINITY,
      patch.match.score
    )
  );
  for (const reason of patch.match.reasons ?? ["hosted_visual_patch_similarity"]) {
    existing.reasons.add(reason);
  }

  return undefined;
}

function validatePatchGroupConsistency(
  group: HostedVisualGroup,
  patch: HostedVisualPatch
): VisualVectorSearchRejection | undefined {
  if (
    group.chunk.id !== patch.chunk.id ||
    group.patchCount !== patch.patchCount ||
    group.documentId !== patch.match.documentId ||
    group.tenantId !== patch.match.tenantId ||
    group.namespaceId !== patch.match.namespaceId ||
    group.textHash !== patch.match.textHash ||
    group.embeddingModel !== patch.match.embeddingModel ||
    group.embeddedAt !== patch.match.embeddedAt ||
    group.dimensions !== patch.match.dimensions ||
    group.visualAssetId !== patch.visualAssetId ||
    !sameCitationVisualAsset(group.visualAsset, patch.visualAsset) ||
    group.pageNumber !== patch.pageNumber ||
    !sameStringArray(group.layoutRegionIds, patch.layoutRegionIds) ||
    !sameLayoutBoxes(group.boundingBoxes, patch.boundingBoxes)
  ) {
    return {
      chunkId: patch.chunk.id,
      code: "stale_vector",
      reason: "Hosted visual vector patch metadata was inconsistent across the same visual record."
    };
  }

  return undefined;
}

function buildCandidateFromGroup(
  group: HostedVisualGroup,
  queryVectorCount: number
):
  | {
      readonly candidate: VisualVectorSearchCandidate;
      readonly rejection?: undefined;
    }
  | {
      readonly candidate?: undefined;
      readonly rejection: VisualVectorSearchRejection;
    } {
  const vectors = [...group.patchesByIndex.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, match]) => match.vector);

  const visualVector: VisualChunkVector = {
    id: group.visualVectorId,
    chunkId: group.chunk.id,
    documentId: group.documentId,
    tenantId: group.tenantId,
    namespaceId: group.namespaceId,
    textHash: group.textHash,
    embeddingModel: group.embeddingModel,
    dimensions: group.dimensions,
    vectors,
    embeddedAt: group.embeddedAt,
    ...(group.visualAssetId === undefined ? {} : { visualAssetId: group.visualAssetId }),
    ...(group.visualAsset === undefined ? {} : { visualAsset: group.visualAsset }),
    ...(group.pageNumber === undefined ? {} : { pageNumber: group.pageNumber }),
    ...(group.layoutRegionIds === undefined ? {} : { layoutRegionIds: group.layoutRegionIds }),
    ...(group.boundingBoxes === undefined ? {} : { boundingBoxes: group.boundingBoxes })
  };

  try {
    validateVisualChunkVector(visualVector, undefined, new Set());
  } catch (error) {
    return {
      rejection: {
        chunkId: group.chunk.id,
        code: "stale_vector",
        reason:
          error instanceof Error ? error.message : "Hosted visual vector metadata was invalid."
      }
    };
  }

  return {
    candidate: {
      chunk: group.chunk,
      visualVector,
      score: roundScore(hostedLateInteractionScore(group, queryVectorCount)),
      rank: 0,
      reasons: ["hosted_visual_late_interaction_maxsim", ...group.reasons]
    }
  };
}

function hostedLateInteractionScore(group: HostedVisualGroup, queryVectorCount: number): number {
  let total = 0;
  for (let index = 0; index < queryVectorCount; index += 1) {
    total += group.queryScores.get(index) ?? -1;
  }

  return total / queryVectorCount;
}

function hostedPatchQueryLimit(request: VisualVectorSearchRequest): number {
  if (request.candidatePoolLimit !== undefined) {
    return request.candidatePoolLimit;
  }

  return Math.min(
    MAX_PATCH_QUERY_LIMIT,
    Math.max(request.topK * DEFAULT_PATCH_LIMIT_MULTIPLIER, DEFAULT_PATCH_LIMIT_FLOOR)
  );
}

function visualPatchVectorId(visualVectorId: string, patchIndex: number): string {
  return `${visualVectorId}${VISUAL_PATCH_ID_SEPARATOR}${patchIndex}`;
}

function parseVisualVectorId(id: string): string | undefined {
  const index = id.lastIndexOf(VISUAL_PATCH_ID_SEPARATOR);
  return index < 0 ? undefined : id.slice(0, index);
}

function parsePatchIndex(id: string): number | undefined {
  const index = id.lastIndexOf(VISUAL_PATCH_ID_SEPARATOR);
  if (index < 0) {
    return undefined;
  }

  const value = Number.parseInt(id.slice(index + VISUAL_PATCH_ID_SEPARATOR.length), 10);
  return Number.isInteger(value) ? value : undefined;
}

function compareHostedVisualGroups(first: HostedVisualGroup, second: HostedVisualGroup): number {
  return first.visualVectorId.localeCompare(second.visualVectorId);
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

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataInteger(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function metadataJsonCitationVisualAsset(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
):
  | { readonly status: "valid"; readonly value?: CitationVisualAsset }
  | { readonly status: "invalid" } {
  const value = metadataString(metadata, key);
  if (value === undefined) {
    return { status: "valid" };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (isCitationVisualAsset(parsed)) {
      return { status: "valid", value: normalizeCitationVisualAsset(parsed) };
    }
  } catch {
    return { status: "invalid" };
  }

  return { status: "invalid" };
}

function isCitationVisualAsset(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set([
    "id",
    "kind",
    "mediaType",
    "pageNumber",
    "assetType",
    "title",
    "chartType",
    "sheetName",
    "anchorCell",
    "artifactKind"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  if (!isNonBlankString(value["id"])) {
    return false;
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
  ]) {
    const field = value[key];
    if (field !== undefined && !isNonBlankString(field)) {
      return false;
    }
  }

  const pageNumber = value["pageNumber"];
  return (
    pageNumber === undefined ||
    (typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber >= 1)
  );
}

function normalizeCitationVisualAsset(
  value: Readonly<Record<string, unknown>>
): CitationVisualAsset {
  return {
    id: value["id"] as string,
    ...(typeof value["kind"] === "string" ? { kind: value["kind"] } : {}),
    ...(typeof value["mediaType"] === "string" ? { mediaType: value["mediaType"] } : {}),
    ...(typeof value["pageNumber"] === "number" ? { pageNumber: value["pageNumber"] } : {}),
    ...(typeof value["assetType"] === "string" ? { assetType: value["assetType"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["chartType"] === "string" ? { chartType: value["chartType"] } : {}),
    ...(typeof value["sheetName"] === "string" ? { sheetName: value["sheetName"] } : {}),
    ...(typeof value["anchorCell"] === "string" ? { anchorCell: value["anchorCell"] } : {}),
    ...(typeof value["artifactKind"] === "string" ? { artifactKind: value["artifactKind"] } : {})
  };
}

function metadataJsonStringArray(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
):
  | { readonly status: "valid"; readonly value?: readonly string[] }
  | { readonly status: "invalid" } {
  const value = metadataString(metadata, key);
  if (value === undefined) {
    return { status: "valid" };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string" && entry.trim())
    ) {
      return { status: "valid", value: parsed };
    }
  } catch {
    return { status: "invalid" };
  }

  return { status: "invalid" };
}

function metadataJsonLayoutBoxes(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string
):
  | { readonly status: "valid"; readonly value?: readonly LayoutBox[] }
  | { readonly status: "invalid" } {
  const value = metadataString(metadata, key);
  if (value === undefined) {
    return { status: "valid" };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every(isLayoutBox)) {
      return { status: "valid", value: parsed };
    }
  } catch {
    return { status: "invalid" };
  }

  return { status: "invalid" };
}

function isLayoutBox(value: unknown): value is LayoutBox {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Number.isInteger(value["pageNumber"]) &&
    (value["pageNumber"] as number) >= 1 &&
    typeof value["x"] === "number" &&
    Number.isFinite(value["x"]) &&
    typeof value["y"] === "number" &&
    Number.isFinite(value["y"]) &&
    typeof value["width"] === "number" &&
    Number.isFinite(value["width"]) &&
    (value["width"] as number) >= 0 &&
    typeof value["height"] === "number" &&
    Number.isFinite(value["height"]) &&
    (value["height"] as number) >= 0
  );
}

function sameStringArray(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }

  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameLayoutBoxes(
  first: readonly LayoutBox[] | undefined,
  second: readonly LayoutBox[] | undefined
): boolean {
  return JSON.stringify(first ?? []) === JSON.stringify(second ?? []);
}

function sameCitationVisualAsset(
  first: CitationVisualAsset | undefined,
  second: CitationVisualAsset | undefined
): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }

  return (
    JSON.stringify(
      normalizeCitationVisualAsset(first as unknown as Readonly<Record<string, unknown>>)
    ) ===
    JSON.stringify(
      normalizeCitationVisualAsset(second as unknown as Readonly<Record<string, unknown>>)
    )
  );
}

function roundScore(score: number): number {
  return Math.round(score * 1000000) / 1000000;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
