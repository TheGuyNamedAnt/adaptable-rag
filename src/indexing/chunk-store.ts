import type { RagChunk } from "../documents/chunk.js";
import type {
  IndexChunkOptions,
  IndexFilter,
  IndexChunkDeleteResult,
  IndexedChunk,
  IndexOperationResult,
  IndexStoreOperationResult
} from "./index-types.js";

export interface ChunkStore {
  addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options?: IndexChunkOptions
  ): IndexStoreOperationResult<readonly IndexOperationResult[]>;
  deleteChunksForDocument(
    documentId: string,
    filter: IndexFilter
  ): IndexStoreOperationResult<IndexChunkDeleteResult>;
  getChunk(
    chunkId: string,
    filter: IndexFilter
  ): IndexStoreOperationResult<IndexedChunk | undefined>;
  hasChunk(chunkId: string, filter: IndexFilter): IndexStoreOperationResult<boolean>;
  findChunks(filter: IndexFilter): IndexStoreOperationResult<readonly IndexedChunk[]>;
  listChunks(filter: IndexFilter): IndexStoreOperationResult<readonly IndexedChunk[]>;
}
