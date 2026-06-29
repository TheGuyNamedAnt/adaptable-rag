import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentVisualAsset, LayoutBox } from "../documents/layout.js";
import type { CitationVisualAsset } from "../documents/provenance.js";
import type { VisualChunkVector, VisualVectorStore } from "../indexing/visual-vector-store.js";
import { embeddingIdentityFor, embeddingIndexConfigHashFor } from "./embedding-identity.js";
import type { VisualEmbeddingAdapter, VisualEmbeddingInput } from "./visual-embedding-types.js";

export interface VisualEmbeddingIndexerOptions {
  readonly adapter: VisualEmbeddingAdapter;
  readonly visualVectorStore: VisualVectorStore;
  readonly now?: () => string;
}

export interface VisualEmbeddingIndexChunksRequest {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly requestedAt?: string;
  readonly overwriteMode?: "reject" | "replace";
}

export type VisualEmbeddingIndexWarningCode =
  | "visual_embedding_failed"
  | "missing_document"
  | "missing_visual_asset"
  | "missing_embedding"
  | "dimension_mismatch"
  | "empty_visual_vectors";

export interface VisualEmbeddingIndexWarning {
  readonly code: VisualEmbeddingIndexWarningCode;
  readonly chunkId?: string;
  readonly documentId?: string;
  readonly message: string;
}

export interface VisualEmbeddingIndexResult {
  readonly embeddedAt: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly candidateChunkCount: number;
  readonly candidateVisualAssetCount: number;
  readonly indexedVisualVectorCount: number;
  readonly skippedChunkCount: number;
  readonly warnings: readonly VisualEmbeddingIndexWarning[];
}

interface VisualChunkInput {
  readonly chunk: RagChunk;
  readonly asset: DocumentVisualAsset;
  readonly input: VisualEmbeddingInput;
}

export class VisualEmbeddingIndexer {
  private readonly adapter: VisualEmbeddingAdapter;
  private readonly visualVectorStore: VisualVectorStore;
  private readonly now: () => string;

  constructor(options: VisualEmbeddingIndexerOptions) {
    this.adapter = options.adapter;
    this.visualVectorStore = options.visualVectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async indexChunks(
    request: VisualEmbeddingIndexChunksRequest
  ): Promise<VisualEmbeddingIndexResult> {
    const embeddedAt = request.requestedAt ?? this.now();
    const warnings: VisualEmbeddingIndexWarning[] = [];
    const documentsById = new Map(request.documents.map((document) => [document.id, document]));
    const inputs = visualInputsForChunks(request.chunks, documentsById, warnings);
    const candidateChunkCount = new Set(inputs.map((entry) => entry.chunk.id)).size;

    if (inputs.length === 0) {
      return {
        embeddedAt,
        provider: this.adapter.provider,
        modelName: this.adapter.modelName,
        dimensions: this.adapter.dimensions,
        candidateChunkCount: 0,
        candidateVisualAssetCount: 0,
        indexedVisualVectorCount: 0,
        skippedChunkCount: request.chunks.length,
        warnings
      };
    }

    const result = await this.adapter.embedVisualAssets({
      inputs: inputs.map((entry) => entry.input),
      requestedAt: embeddedAt
    });

    if (result.status === "failed") {
      return {
        embeddedAt,
        provider: result.provider,
        modelName: result.modelName,
        dimensions: result.dimensions,
        candidateChunkCount,
        candidateVisualAssetCount: inputs.length,
        indexedVisualVectorCount: 0,
        skippedChunkCount: request.chunks.length,
        warnings: [
          ...warnings,
          {
            code: "visual_embedding_failed",
            message: result.errorMessage ?? "Visual embedding adapter failed."
          }
        ]
      };
    }

    const embeddingsByInputId = new Map(
      result.embeddings.map((embedding) => [embedding.id, embedding])
    );
    const identity = embeddingIdentityFor({
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      adapterId: this.adapter.id
    });
    const visualVectors: VisualChunkVector[] = [];

    for (const entry of inputs) {
      const embedding = embeddingsByInputId.get(entry.input.id);
      if (!embedding) {
        warnings.push({
          code: "missing_embedding",
          chunkId: entry.chunk.id,
          documentId: entry.chunk.documentId,
          message: "Visual embedding adapter did not return an embedding for this chunk."
        });
        continue;
      }

      if (embedding.vectors.length === 0) {
        warnings.push({
          code: "empty_visual_vectors",
          chunkId: entry.chunk.id,
          documentId: entry.chunk.documentId,
          message: "Visual embedding adapter returned no patch vectors for this chunk."
        });
        continue;
      }

      if (embedding.vectors.some((vector) => vector.length !== result.dimensions)) {
        warnings.push({
          code: "dimension_mismatch",
          chunkId: entry.chunk.id,
          documentId: entry.chunk.documentId,
          message: "Visual embedding dimensions did not match the adapter result dimensions."
        });
        continue;
      }

      const indexConfigHash = embeddingIndexConfigHashFor({
        provider: result.provider,
        modelName: result.modelName,
        dimensions: result.dimensions,
        adapterId: this.adapter.id,
        ...optionalIdentityMetadata(entry.chunk.metadata)
      });

      visualVectors.push({
        id: visualVectorId(identity.embeddingConfigHash, entry.chunk.id, entry.asset.id),
        chunkId: entry.chunk.id,
        documentId: entry.chunk.documentId,
        tenantId: entry.chunk.accessScope.tenantId,
        namespaceId: entry.chunk.namespaceId,
        textHash: entry.chunk.textHash,
        embeddingModel: result.modelName,
        embeddingProvider: result.provider,
        embeddingConfigHash: identity.embeddingConfigHash,
        dimensions: result.dimensions,
        vectors: embedding.vectors,
        embeddedAt,
        visualAssetId: entry.asset.id,
        visualAsset: citationVisualAssetForDocumentAsset(entry.asset),
        pageNumber: pageNumberForChunk(entry.chunk, entry.asset),
        ...(layoutRegionIdsForChunk(entry.chunk).length === 0
          ? {}
          : { layoutRegionIds: layoutRegionIdsForChunk(entry.chunk) }),
        ...(boundingBoxesForChunk(entry.chunk, entry.asset).length === 0
          ? {}
          : { boundingBoxes: boundingBoxesForChunk(entry.chunk, entry.asset) }),
        metadata: {
          ...(entry.chunk.metadata ?? {}),
          embeddingProvider: result.provider,
          embeddingAdapterId: this.adapter.id,
          embeddingConfigHash: identity.embeddingConfigHash,
          embeddingIndexConfigHash: indexConfigHash
        }
      });
    }

    const indexResults = await this.visualVectorStore.addVisualChunkVectors(visualVectors, {
      overwriteMode: request.overwriteMode ?? "replace",
      indexedAt: embeddedAt
    });
    const indexedVisualVectorCount = indexResults.filter(
      (indexResult) => indexResult.accepted
    ).length;
    const indexedChunkIds = new Set(
      visualVectors
        .filter((_, index) => indexResults[index]?.accepted === true)
        .map((vector) => vector.chunkId)
    );

    return {
      embeddedAt,
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      candidateChunkCount,
      candidateVisualAssetCount: inputs.length,
      indexedVisualVectorCount,
      skippedChunkCount: Math.max(0, request.chunks.length - indexedChunkIds.size),
      warnings
    };
  }
}

export function visualInputsForChunks(
  chunks: readonly RagChunk[],
  documentsById: ReadonlyMap<string, RagDocument>,
  warnings: VisualEmbeddingIndexWarning[] = []
): readonly VisualChunkInput[] {
  const inputs: VisualChunkInput[] = [];

  for (const chunk of chunks) {
    const document = documentsById.get(chunk.documentId);
    if (!document) {
      warnings.push({
        code: "missing_document",
        chunkId: chunk.id,
        documentId: chunk.documentId,
        message: "Visual embedding requires the source document for this chunk."
      });
      continue;
    }

    if (!hasVisualAnchor(chunk)) {
      continue;
    }

    const assets = visualAssetsForChunk(document, chunk);
    if (assets.length === 0) {
      warnings.push({
        code: "missing_visual_asset",
        chunkId: chunk.id,
        documentId: chunk.documentId,
        message: "Chunk has layout evidence but no matching document visual asset."
      });
      continue;
    }

    for (const asset of assets) {
      inputs.push({
        chunk,
        asset,
        input: {
          id: visualInputId(chunk.id, asset.id),
          chunkId: chunk.id,
          documentId: chunk.documentId,
          mediaType: asset.mediaType,
          visualAssetId: asset.id,
          ...(asset.uri === undefined ? {} : { uri: asset.uri }),
          text: visualInputText(document, chunk, asset),
          metadata: visualInputMetadata(asset, chunk)
        }
      });
    }
  }

  return inputs;
}

function visualInputText(
  document: RagDocument,
  chunk: RagChunk,
  asset: DocumentVisualAsset
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const regionIds = new Set(layoutRegionIdsForChunk(chunk));

  addVisualInputTextPart(parts, seen, chunk.text);
  addVisualInputTextPart(parts, seen, visualAssetDescription(asset));

  for (const region of document.layout?.regions ?? []) {
    if (!regionIds.has(region.id) || region.text === undefined) {
      continue;
    }

    addVisualInputTextPart(parts, seen, region.text);
  }

  return parts.join("\n\n");
}

function visualAssetsForChunk(
  document: RagDocument,
  chunk: RagChunk
): readonly DocumentVisualAsset[] {
  const assets = document.layout?.visualAssets ?? [];
  if (assets.length === 0) {
    return [];
  }

  const pageNumber = chunkPageNumber(document, chunk);
  if (pageNumber === undefined) {
    return assets.length === 1 ? assets : [];
  }

  const regionIds = new Set(layoutRegionIdsForChunk(chunk));
  const chunkBoxes = chunkBoundingBoxes(chunk);
  return assets
    .filter((asset) => assetMatchesChunkVisualAnchor(asset, pageNumber, regionIds, chunkBoxes))
    .sort(compareVisualAssets);
}

function chunkPageNumber(document: RagDocument, chunk: RagChunk): number | undefined {
  const explicitPageNumber =
    chunk.citation.pageNumber ??
    chunk.boundingBoxes?.[0]?.pageNumber ??
    chunk.citation.boundingBoxes?.[0]?.pageNumber;
  if (explicitPageNumber !== undefined) {
    return explicitPageNumber;
  }

  const regionIds = new Set(layoutRegionIdsForChunk(chunk));
  return document.layout?.regions.find((region) => regionIds.has(region.id))?.pageNumber;
}

function pageNumberForChunk(chunk: RagChunk, asset: DocumentVisualAsset): number {
  return (
    chunk.citation.pageNumber ??
    chunk.boundingBoxes?.[0]?.pageNumber ??
    chunk.citation.boundingBoxes?.[0]?.pageNumber ??
    asset.pageNumber
  );
}

function boundingBoxesForChunk(chunk: RagChunk, asset: DocumentVisualAsset): readonly LayoutBox[] {
  const chunkBoxes = chunkBoundingBoxes(chunk);
  return chunkBoxes.length > 0 ? chunkBoxes : asset.box ? [asset.box] : [];
}

function chunkBoundingBoxes(chunk: RagChunk): readonly LayoutBox[] {
  return chunk.boundingBoxes ?? chunk.citation.boundingBoxes ?? [];
}

function layoutRegionIdsForChunk(chunk: RagChunk): readonly string[] {
  return chunk.layoutRegionIds ?? chunk.citation.layoutRegionIds ?? [];
}

function hasVisualAnchor(chunk: RagChunk): boolean {
  return (
    layoutRegionIdsForChunk(chunk).length > 0 ||
    (chunk.boundingBoxes?.length ?? 0) > 0 ||
    (chunk.citation.boundingBoxes?.length ?? 0) > 0 ||
    chunk.citation.pageNumber !== undefined
  );
}

function visualVectorId(
  embeddingConfigHash: string,
  chunkId: string,
  visualAssetId: string
): string {
  return `${embeddingConfigHash}_${sanitizeId(visualAssetId)}_${chunkId}`;
}

function visualInputId(chunkId: string, visualAssetId: string): string {
  return `${sanitizeId(visualAssetId)}_${chunkId}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}

function visualInputMetadata(
  asset: DocumentVisualAsset,
  chunk: RagChunk
): Record<string, string | number | boolean> {
  return {
    ...(asset.metadata ?? {}),
    assetKind: asset.kind,
    pageNumber: asset.pageNumber,
    mediaType: asset.mediaType,
    hasUri: asset.uri !== undefined,
    sourceId: chunk.provenance.sourceId
  };
}

function citationVisualAssetForDocumentAsset(asset: DocumentVisualAsset): CitationVisualAsset {
  const assetType = metadataString(asset, "assetType");
  const title = metadataString(asset, "title");
  const chartType = metadataString(asset, "chartType");
  const sheetName = metadataString(asset, "sheetName");
  const anchorCell = metadataString(asset, "anchorCell");
  const artifactKind = metadataString(asset, "artifactKind");

  return {
    id: asset.id,
    kind: asset.kind,
    mediaType: asset.mediaType,
    pageNumber: asset.pageNumber,
    ...(assetType === undefined ? {} : { assetType }),
    ...(title === undefined ? {} : { title }),
    ...(chartType === undefined ? {} : { chartType }),
    ...(sheetName === undefined ? {} : { sheetName }),
    ...(anchorCell === undefined ? {} : { anchorCell }),
    ...(artifactKind === undefined ? {} : { artifactKind })
  };
}

function visualAssetDescription(asset: DocumentVisualAsset): string {
  const parts = [
    "Visual asset",
    metadataString(asset, "assetType") ?? asset.kind,
    metadataString(asset, "title"),
    metadataString(asset, "chartType"),
    metadataString(asset, "sheetName"),
    metadataString(asset, "anchorCell"),
    asset.mediaType
  ].filter((part): part is string => part !== undefined && part.trim().length > 0);

  return parts.join(" | ");
}

function addVisualInputTextPart(parts: string[], seen: Set<string>, value: string): void {
  const text = value.trim();
  if (text.length === 0 || seen.has(text)) {
    return;
  }

  parts.push(text);
  seen.add(text);
}

function assetMatchesChunkVisualAnchor(
  asset: DocumentVisualAsset,
  pageNumber: number,
  regionIds: ReadonlySet<string>,
  chunkBoxes: readonly LayoutBox[]
): boolean {
  if (assetRegionIds(asset).some((regionId) => regionIds.has(regionId))) {
    return true;
  }

  if (asset.pageNumber !== pageNumber) {
    return false;
  }

  if (asset.kind === "page_image" || asset.kind === "patch_grid") {
    return true;
  }

  const assetBox = asset.box;
  if (!assetBox || chunkBoxes.length === 0) {
    return true;
  }

  return chunkBoxes.some((box) => boxesOverlap(box, assetBox));
}

function assetRegionIds(asset: DocumentVisualAsset): readonly string[] {
  return [
    metadataString(asset, "layoutRegionId"),
    metadataString(asset, "regionId"),
    metadataString(asset, "layoutRegionIds")
  ]
    .flatMap((value) => (value === undefined ? [] : value.split(/[,\s]+/u)))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function metadataString(asset: DocumentVisualAsset, key: string): string | undefined {
  const value = asset.metadata?.[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function chunkMetadataString(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalIdentityMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined
): {
  readonly chunkingPolicyId?: string;
  readonly chunkingPolicyVersion?: string;
  readonly chunkerVersion?: string;
  readonly preprocessingVersion?: string;
} {
  const chunkingPolicyId = chunkMetadataString(metadata, "chunkingPolicyId");
  const chunkingPolicyVersion = chunkMetadataString(metadata, "chunkingPolicyVersion");
  const chunkerVersion = chunkMetadataString(metadata, "chunkerVersion");
  const preprocessingVersion = chunkMetadataString(metadata, "preprocessingVersion");

  return {
    ...(chunkingPolicyId === undefined ? {} : { chunkingPolicyId }),
    ...(chunkingPolicyVersion === undefined ? {} : { chunkingPolicyVersion }),
    ...(chunkerVersion === undefined ? {} : { chunkerVersion }),
    ...(preprocessingVersion === undefined ? {} : { preprocessingVersion })
  };
}

function boxesOverlap(first: LayoutBox, second: LayoutBox): boolean {
  if (first.pageNumber !== second.pageNumber) {
    return false;
  }

  if (first.unit !== second.unit) {
    return true;
  }

  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function compareVisualAssets(first: DocumentVisualAsset, second: DocumentVisualAsset): number {
  const rankDelta = visualAssetRank(first) - visualAssetRank(second);
  return rankDelta === 0 ? first.id.localeCompare(second.id) : rankDelta;
}

function visualAssetRank(asset: DocumentVisualAsset): number {
  switch (asset.kind) {
    case "page_image":
      return 0;
    case "patch_grid":
      return 1;
    case "figure":
      return 2;
    case "table_crop":
      return 3;
  }
}
