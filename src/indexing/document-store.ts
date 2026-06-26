import type { RagDocument } from "../documents/document.js";
import type {
  IndexDocumentOptions,
  IndexFilter,
  IndexDocumentDeleteResult,
  IndexedDocument,
  IndexOperationResult,
  IndexStoreOperationResult
} from "./index-types.js";

export interface DocumentStore {
  addDocument(
    document: RagDocument,
    options?: IndexDocumentOptions
  ): IndexStoreOperationResult<IndexOperationResult>;
  deleteDocument(
    documentId: string,
    filter: IndexFilter
  ): IndexStoreOperationResult<IndexDocumentDeleteResult>;
  getDocument(
    documentId: string,
    filter: IndexFilter
  ): IndexStoreOperationResult<IndexedDocument | undefined>;
  hasDocument(documentId: string, filter: IndexFilter): IndexStoreOperationResult<boolean>;
  findDocuments(filter: IndexFilter): IndexStoreOperationResult<readonly IndexedDocument[]>;
  listDocuments(filter: IndexFilter): IndexStoreOperationResult<readonly IndexedDocument[]>;
}
