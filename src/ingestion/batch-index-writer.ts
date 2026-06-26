import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { DocumentStore } from "../indexing/document-store.js";
import type {
  IndexFilter,
  IndexOperationResult,
  IndexOverwriteMode
} from "../indexing/index-types.js";

export interface BatchIndexWriterOptions {
  readonly documentStore: DocumentStore;
  readonly chunkStore: ChunkStore;
}

export interface BatchIndexDocumentInput {
  readonly document: RagDocument;
  readonly chunks: readonly RagChunk[];
}

export interface BatchIndexWriteRequest {
  readonly documents: readonly BatchIndexDocumentInput[];
  readonly overwriteMode?: IndexOverwriteMode;
  readonly indexedAt?: string;
}

export interface BatchIndexWriteResult {
  readonly acceptedDocuments: readonly RagDocument[];
  readonly acceptedChunks: readonly RagChunk[];
  readonly rejectedDocuments: readonly BatchIndexRejectedDocument[];
  readonly failedDocuments: readonly BatchIndexFailedDocument[];
  readonly indexResults: readonly IndexOperationResult[];
}

export interface BatchIndexRejectedDocument {
  readonly document: RagDocument;
  readonly result: IndexOperationResult;
}

export interface BatchIndexFailedDocument {
  readonly document: RagDocument;
  readonly code: "chunk_index_validation_failed";
  readonly message: string;
  readonly rolledBack: boolean;
}

export class BatchIndexWriter {
  private readonly documentStore: DocumentStore;
  private readonly chunkStore: ChunkStore;

  constructor(options: BatchIndexWriterOptions) {
    this.documentStore = options.documentStore;
    this.chunkStore = options.chunkStore;
  }

  async write(request: BatchIndexWriteRequest): Promise<BatchIndexWriteResult> {
    const acceptedDocuments: RagDocument[] = [];
    const acceptedChunks: RagChunk[] = [];
    const rejectedDocuments: BatchIndexRejectedDocument[] = [];
    const failedDocuments: BatchIndexFailedDocument[] = [];
    const indexResults: IndexOperationResult[] = [];

    for (const input of request.documents) {
      const documentResult = await this.documentStore.addDocument(input.document, {
        overwriteMode: request.overwriteMode ?? "reject",
        ...(request.indexedAt === undefined ? {} : { indexedAt: request.indexedAt })
      });
      indexResults.push(documentResult);

      if (!documentResult.accepted) {
        rejectedDocuments.push({
          document: input.document,
          result: documentResult
        });
        continue;
      }

      acceptedDocuments.push(input.document);

      let chunkResults: readonly IndexOperationResult[];
      try {
        chunkResults = await this.chunkStore.addChunks(input.document.id, input.chunks, {
          overwriteMode: request.overwriteMode ?? "reject",
          ...(request.indexedAt === undefined ? {} : { indexedAt: request.indexedAt })
        });
      } catch (error) {
        if (!isChunkIndexValidationError(error)) {
          throw error;
        }

        await this.rollbackDocument(input.document);
        acceptedDocuments.pop();
        failedDocuments.push({
          document: input.document,
          code: "chunk_index_validation_failed",
          message: error instanceof Error ? error.message : "Document chunks failed validation.",
          rolledBack: true
        });
        continue;
      }

      indexResults.push(...chunkResults);
      const acceptedChunkIds = new Set(
        chunkResults.filter((result) => result.accepted).map((result) => result.id)
      );
      acceptedChunks.push(...input.chunks.filter((chunk) => acceptedChunkIds.has(chunk.id)));
    }

    return {
      acceptedDocuments,
      acceptedChunks,
      rejectedDocuments,
      failedDocuments,
      indexResults
    };
  }

  private async rollbackDocument(document: RagDocument): Promise<void> {
    const filter = rollbackFilter(document);
    await this.chunkStore.deleteChunksForDocument(document.id, filter);
    await this.documentStore.deleteDocument(document.id, filter);
  }
}

function isChunkIndexValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Chunks rejected by index validation:");
}

function rollbackFilter(document: RagDocument): IndexFilter {
  const scope = document.accessScope;
  return {
    namespaceId: document.namespaceId,
    tenantId: scope.tenantId,
    principal: {
      userId: scope.userIds?.[0] ?? "ingest_rollback",
      tenantId: scope.tenantId,
      namespaceIds: [scope.namespaceId],
      teamIds: [...(scope.teamIds ?? [])],
      roles: [...(scope.roles ?? [])],
      tags: [...(scope.tags ?? [])]
    },
    documentIds: [document.id]
  };
}
