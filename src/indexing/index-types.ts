import type { ChunkSafetyFlag, RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { SourceKind } from "../documents/provenance.js";
import type { TrustTier } from "../documents/trust-tier.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { StorageScaleCapabilities } from "./scale-capabilities.js";

export type IndexOverwriteMode = "reject" | "replace";

export interface IndexDocumentOptions {
  readonly overwriteMode?: IndexOverwriteMode;
  readonly indexedAt?: string;
}

export interface IndexChunkOptions {
  readonly overwriteMode?: IndexOverwriteMode;
  readonly indexedAt?: string;
}

export interface IndexedDocument {
  readonly document: RagDocument;
  readonly indexedAt: string;
  readonly updatedAt?: string;
}

export interface IndexedChunk {
  readonly chunk: RagChunk;
  readonly indexedAt: string;
  readonly updatedAt?: string;
}

export interface IndexFilter {
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly principal: RequestPrincipal;
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceKinds?: readonly SourceKind[];
  readonly trustTiers?: readonly TrustTier[];
  readonly includeSafetyFlags?: readonly ChunkSafetyFlag[];
  readonly excludeSafetyFlags?: readonly ChunkSafetyFlag[];
  readonly accessTags?: readonly string[];
  readonly limit?: number;
}

export interface IndexStats {
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly namespaceIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly trustTierCounts: Readonly<Record<string, number>>;
  readonly flaggedChunkCount: number;
}

export interface IndexOperationResult {
  readonly accepted: boolean;
  readonly id: string;
  readonly message: string;
}

export interface IndexDocumentDeleteResult {
  readonly accepted: boolean;
  readonly documentId: string;
  readonly deletedDocumentCount: number;
  readonly message: string;
}

export interface IndexChunkDeleteResult {
  readonly accepted: boolean;
  readonly documentId: string;
  readonly deletedChunkCount: number;
  readonly message: string;
}

export interface IndexSnapshot {
  readonly version: 1;
  readonly documents: readonly IndexedDocument[];
  readonly chunks: readonly IndexedChunk[];
}

export type IndexStorageKind = "memory" | "json_file" | "sqlite" | "postgres";

export type IndexStoreOperationResult<T> = T | Promise<T>;

export interface IndexCapabilities {
  readonly storageKind: IndexStorageKind;
  readonly durable: boolean;
  readonly enforcesAccessFilters: boolean;
  readonly supportsKeywordScan: boolean;
  readonly supportsVectorSearch: boolean;
  readonly supportsHybridSearch: boolean;
  readonly scale?: StorageScaleCapabilities;
}
