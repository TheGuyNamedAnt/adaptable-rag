import type { IndexFilter, IndexedChunk } from "../indexing/index-types.js";

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

export interface FtsIndexStore {
  searchKeywordChunks(
    request: FtsSearchRequest
  ): Promise<readonly FtsSearchResult[]> | readonly FtsSearchResult[];
}
