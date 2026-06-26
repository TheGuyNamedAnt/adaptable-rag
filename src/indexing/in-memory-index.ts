import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { evaluateAccess } from "../security/access-control.js";
import type { ChunkStore } from "./chunk-store.js";
import type { DocumentStore } from "./document-store.js";
import { validateChunksForIndex, validateDocumentForIndex } from "./index-validation.js";
import { isValidIndexFilter } from "./index-filter.js";
import type {
  IndexCapabilities,
  IndexChunkOptions,
  IndexChunkDeleteResult,
  IndexDocumentDeleteResult,
  IndexDocumentOptions,
  IndexedChunk,
  IndexedDocument,
  IndexFilter,
  IndexOperationResult,
  IndexSnapshot,
  IndexStats
} from "./index-types.js";

export interface InMemoryRagIndexOptions {
  readonly now?: () => string;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly snapshot?: IndexSnapshot;
}

export class InMemoryRagIndex implements DocumentStore, ChunkStore {
  readonly capabilities: IndexCapabilities = {
    storageKind: "memory",
    durable: false,
    enforcesAccessFilters: true,
    supportsKeywordScan: true,
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly documents = new Map<string, IndexedDocument>();
  private readonly chunks = new Map<string, IndexedChunk>();
  private readonly chunkingPolicy: ChunkingPolicy;
  private readonly now: () => string;

  constructor(options: InMemoryRagIndexOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.chunkingPolicy = options.chunkingPolicy ?? DEFAULT_CHUNKING_POLICY;
    if (options.snapshot) {
      this.restoreSnapshot(options.snapshot);
    }
  }

  addDocument(document: RagDocument, options: IndexDocumentOptions = {}): IndexOperationResult {
    const validation = validateDocumentForIndex(document);
    if (!validation.valid) {
      throw new Error(
        formatValidationError("Document rejected by index validation", validation.errors)
      );
    }

    const existing = this.documents.get(document.id);
    const overwriteMode = options.overwriteMode ?? "reject";
    if (existing && overwriteMode === "reject") {
      throw new Error(`Document "${document.id}" is already indexed.`);
    }

    const indexedAt = options.indexedAt ?? this.now();
    if (existing) {
      this.removeChunksForDocument(document.id);
    }

    this.documents.set(document.id, {
      document,
      indexedAt: existing?.indexedAt ?? indexedAt,
      ...(existing ? { updatedAt: indexedAt } : {})
    });

    return {
      accepted: true,
      id: document.id,
      message: existing ? "Document replaced." : "Document indexed."
    };
  }

  deleteDocument(documentId: string, filter: IndexFilter): IndexDocumentDeleteResult {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document delete requires a valid tenant, namespace, and principal filter."
      };
    }

    const indexed = this.documents.get(documentId);
    if (!indexed || !documentMatchesFilter(indexed.document, filter)) {
      return {
        accepted: false,
        documentId,
        deletedDocumentCount: 0,
        message: "Document was not found or did not pass the delete filter."
      };
    }

    this.documents.delete(documentId);
    return {
      accepted: true,
      documentId,
      deletedDocumentCount: 1,
      message: "Document deleted."
    };
  }

  getDocument(documentId: string, filter: IndexFilter): IndexedDocument | undefined {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }

    const indexed = this.documents.get(documentId);
    if (!indexed || !documentMatchesFilter(indexed.document, filter)) {
      return undefined;
    }

    return indexed;
  }

  hasDocument(documentId: string, filter: IndexFilter): boolean {
    return this.getDocument(documentId, filter) !== undefined;
  }

  findDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    if (!isValidIndexFilter(filter)) {
      return [];
    }

    return applyLimit(
      [...this.documents.values()].filter((indexed) =>
        documentMatchesFilter(indexed.document, filter)
      ),
      filter.limit
    );
  }

  listDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    return this.findDocuments(filter);
  }

  addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    const indexedDocument = this.documents.get(documentId);
    const overwriteMode = options.overwriteMode ?? "reject";
    const existingChunkIds =
      overwriteMode === "replace"
        ? new Set(
            [...this.chunks.values()]
              .filter((indexed) => indexed.chunk.documentId !== documentId)
              .map((indexed) => indexed.chunk.id)
          )
        : new Set(this.chunks.keys());
    const validation = validateChunksForIndex(
      indexedDocument?.document,
      chunks,
      existingChunkIds,
      this.chunkingPolicy
    );

    if (!validation.valid) {
      throw new Error(
        formatValidationError("Chunks rejected by index validation", validation.errors)
      );
    }

    const indexedAt = options.indexedAt ?? this.now();
    const results: IndexOperationResult[] = [];

    if (overwriteMode === "replace") {
      this.removeChunksForDocument(documentId);
    }

    for (const chunk of chunks) {
      const existing = this.chunks.get(chunk.id);
      this.chunks.set(chunk.id, {
        chunk,
        indexedAt: existing?.indexedAt ?? indexedAt,
        ...(existing ? { updatedAt: indexedAt } : {})
      });
      results.push({
        accepted: true,
        id: chunk.id,
        message: existing ? "Chunk replaced." : "Chunk indexed."
      });
    }

    return results;
  }

  deleteChunksForDocument(documentId: string, filter: IndexFilter): IndexChunkDeleteResult {
    if (!isValidIndexFilter(filter)) {
      return {
        accepted: false,
        documentId,
        deletedChunkCount: 0,
        message: "Chunk delete requires a valid tenant, namespace, and principal filter."
      };
    }

    let deletedChunkCount = 0;
    for (const [chunkId, indexed] of this.chunks.entries()) {
      if (indexed.chunk.documentId === documentId && chunkMatchesFilter(indexed.chunk, filter)) {
        this.chunks.delete(chunkId);
        deletedChunkCount += 1;
      }
    }

    return {
      accepted: deletedChunkCount > 0,
      documentId,
      deletedChunkCount,
      message:
        deletedChunkCount > 0
          ? "Chunks deleted for document."
          : "No chunks were found or allowed for document."
    };
  }

  getChunk(chunkId: string, filter: IndexFilter): IndexedChunk | undefined {
    if (!isValidIndexFilter(filter)) {
      return undefined;
    }

    const indexed = this.chunks.get(chunkId);
    if (!indexed || !chunkMatchesFilter(indexed.chunk, filter)) {
      return undefined;
    }

    return indexed;
  }

  hasChunk(chunkId: string, filter: IndexFilter): boolean {
    return this.getChunk(chunkId, filter) !== undefined;
  }

  findChunks(filter: IndexFilter): readonly IndexedChunk[] {
    if (!isValidIndexFilter(filter)) {
      return [];
    }

    return applyLimit(
      [...this.chunks.values()].filter((indexed) => chunkMatchesFilter(indexed.chunk, filter)),
      filter.limit
    );
  }

  listChunks(filter: IndexFilter): readonly IndexedChunk[] {
    return this.findChunks(filter);
  }

  stats(): IndexStats {
    const documents = [...this.documents.values()].map((indexed) => indexed.document);
    const chunks = [...this.chunks.values()].map((indexed) => indexed.chunk);
    const trustTierCounts = chunks.reduce<Record<string, number>>((counts, chunk) => {
      counts[chunk.provenance.trustTier] = (counts[chunk.provenance.trustTier] ?? 0) + 1;
      return counts;
    }, {});

    return {
      documentCount: documents.length,
      chunkCount: chunks.length,
      namespaceIds: unique(documents.map((document) => document.namespaceId)),
      sourceIds: unique(documents.map((document) => document.provenance.sourceId)),
      trustTierCounts,
      flaggedChunkCount: chunks.filter((chunk) => chunk.safetyFlags.length > 0).length
    };
  }

  snapshot(): IndexSnapshot {
    return {
      version: 1,
      documents: [...this.documents.values()],
      chunks: [...this.chunks.values()]
    };
  }

  private restoreSnapshot(snapshot: IndexSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported index snapshot version "${snapshot.version}".`);
    }

    for (const indexed of snapshot.documents) {
      const validation = validateDocumentForIndex(indexed.document);
      if (!validation.valid) {
        throw new Error(
          formatValidationError("Snapshot document rejected by index validation", validation.errors)
        );
      }

      this.documents.set(indexed.document.id, indexed);
    }

    const existingChunkIds = new Set<string>();
    for (const indexed of snapshot.chunks) {
      const document = this.documents.get(indexed.chunk.documentId)?.document;
      const validation = validateChunksForIndex(
        document,
        [indexed.chunk],
        existingChunkIds,
        this.chunkingPolicy
      );
      if (!validation.valid) {
        throw new Error(
          formatValidationError("Snapshot chunk rejected by index validation", validation.errors)
        );
      }

      existingChunkIds.add(indexed.chunk.id);
      this.chunks.set(indexed.chunk.id, indexed);
    }
  }

  private removeChunksForDocument(documentId: string): void {
    for (const [chunkId, indexed] of this.chunks.entries()) {
      if (indexed.chunk.documentId === documentId) {
        this.chunks.delete(chunkId);
      }
    }
  }
}

function documentMatchesFilter(document: RagDocument, filter: IndexFilter): boolean {
  if (document.namespaceId !== filter.namespaceId) {
    return false;
  }

  if (filter.tenantId !== filter.principal.tenantId) {
    return false;
  }

  if (document.accessScope.tenantId !== filter.tenantId) {
    return false;
  }

  if (!evaluateAccess(filter.principal, document.accessScope).allowed) {
    return false;
  }

  if (filter.documentIds && !filter.documentIds.includes(document.id)) {
    return false;
  }

  if (filter.sourceIds && !filter.sourceIds.includes(document.provenance.sourceId)) {
    return false;
  }

  if (filter.sourceKinds && !filter.sourceKinds.includes(document.provenance.sourceKind)) {
    return false;
  }

  if (filter.trustTiers && !filter.trustTiers.includes(document.provenance.trustTier)) {
    return false;
  }

  if (filter.accessTags && !containsAll(document.accessScope.tags ?? [], filter.accessTags)) {
    return false;
  }

  return true;
}

function chunkMatchesFilter(chunk: RagChunk, filter: IndexFilter): boolean {
  if (chunk.namespaceId !== filter.namespaceId) {
    return false;
  }

  if (filter.tenantId !== filter.principal.tenantId) {
    return false;
  }

  if (chunk.accessScope.tenantId !== filter.tenantId) {
    return false;
  }

  if (!evaluateAccess(filter.principal, chunk.accessScope).allowed) {
    return false;
  }

  if (filter.documentIds && !filter.documentIds.includes(chunk.documentId)) {
    return false;
  }

  if (filter.chunkIds && !filter.chunkIds.includes(chunk.id)) {
    return false;
  }

  if (filter.sourceIds && !filter.sourceIds.includes(chunk.provenance.sourceId)) {
    return false;
  }

  if (filter.sourceKinds && !filter.sourceKinds.includes(chunk.provenance.sourceKind)) {
    return false;
  }

  if (filter.trustTiers && !filter.trustTiers.includes(chunk.provenance.trustTier)) {
    return false;
  }

  if (filter.includeSafetyFlags && !matchesAny(chunk.safetyFlags, filter.includeSafetyFlags)) {
    return false;
  }

  if (filter.excludeSafetyFlags && matchesAny(chunk.safetyFlags, filter.excludeSafetyFlags)) {
    return false;
  }

  if (filter.accessTags && !containsAll(chunk.accessScope.tags ?? [], filter.accessTags)) {
    return false;
  }

  return true;
}

function applyLimit<T>(values: readonly T[], limit: number | undefined): readonly T[] {
  if (limit === undefined) {
    return values;
  }

  return values.slice(0, Math.max(0, limit));
}

function matchesAny<T>(values: readonly T[], candidates: readonly T[]): boolean {
  return candidates.some((candidate) => values.includes(candidate));
}

function containsAll<T>(values: readonly T[], candidates: readonly T[]): boolean {
  return candidates.every((candidate) => values.includes(candidate));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function formatValidationError(
  prefix: string,
  errors: readonly { readonly path: string; readonly message: string }[]
): string {
  const details = errors.map((error) => `${error.path}: ${error.message}`).join("\n");
  return `${prefix}:\n${details}`;
}
