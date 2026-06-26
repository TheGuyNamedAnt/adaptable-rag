import type { RagChunk } from "../documents/chunk.js";
import type {
  IndexChunkDeleteResult,
  IndexFilter,
  IndexedChunk,
  IndexOperationResult
} from "../indexing/index-types.js";

export interface FtsSearchRequest {
  readonly query: string;
  readonly terms: readonly string[];
  readonly filter: IndexFilter;
  readonly limit: number;
}

export interface FtsSearchResult {
  readonly chunk: IndexedChunk;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reasons: readonly string[];
}

export interface FtsWriteChunksRequest {
  readonly chunks: readonly RagChunk[];
  readonly indexedAt?: string;
}

export interface FtsWriteChunksResult {
  readonly indexedChunkCount: number;
  readonly rejectedChunkCount: number;
  readonly results: readonly IndexOperationResult[];
}

export interface FtsDeleteChunksForDocumentRequest {
  readonly documentId: string;
  readonly filter: IndexFilter;
}

export interface FtsIndexStore {
  searchKeywordChunks(
    request: FtsSearchRequest
  ): Promise<readonly FtsSearchResult[]> | readonly FtsSearchResult[];
}

export interface FtsIndexWriter {
  writeKeywordChunks(
    request: FtsWriteChunksRequest
  ): Promise<FtsWriteChunksResult> | FtsWriteChunksResult;
  deleteKeywordChunksForDocument(
    request: FtsDeleteChunksForDocumentRequest
  ): Promise<IndexChunkDeleteResult> | IndexChunkDeleteResult;
}
