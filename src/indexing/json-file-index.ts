import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { ChunkStore } from "./chunk-store.js";
import type { DocumentStore } from "./document-store.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
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

export interface JsonFileRagIndexOptions {
  readonly filePath: string;
  readonly now?: () => string;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly autosave?: boolean;
  readonly pretty?: boolean;
}

export class JsonFileRagIndex implements DocumentStore, ChunkStore {
  readonly capabilities: IndexCapabilities = {
    storageKind: "json_file",
    durable: true,
    enforcesAccessFilters: true,
    supportsKeywordScan: true,
    supportsVectorSearch: false,
    supportsHybridSearch: false
  };

  private readonly filePath: string;
  private readonly autosave: boolean;
  private readonly pretty: boolean;
  private readonly delegate: InMemoryRagIndex;

  constructor(options: JsonFileRagIndexOptions) {
    this.filePath = options.filePath;
    this.autosave = options.autosave ?? true;
    this.pretty = options.pretty ?? false;
    const snapshot = loadSnapshot(options.filePath);
    this.delegate = new InMemoryRagIndex({
      ...(options.now ? { now: options.now } : {}),
      ...(options.chunkingPolicy ? { chunkingPolicy: options.chunkingPolicy } : {}),
      ...(snapshot ? { snapshot } : {})
    });
  }

  addDocument(document: RagDocument, options: IndexDocumentOptions = {}): IndexOperationResult {
    const result = this.delegate.addDocument(document, options);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  deleteDocument(documentId: string, filter: IndexFilter): IndexDocumentDeleteResult {
    const result = this.delegate.deleteDocument(documentId, filter);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  getDocument(documentId: string, filter: IndexFilter): IndexedDocument | undefined {
    return this.delegate.getDocument(documentId, filter);
  }

  hasDocument(documentId: string, filter: IndexFilter): boolean {
    return this.delegate.hasDocument(documentId, filter);
  }

  findDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    return this.delegate.findDocuments(filter);
  }

  listDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    return this.delegate.listDocuments(filter);
  }

  addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    const results = this.delegate.addChunks(documentId, chunks, options);
    this.flushIfNeeded(results.some((result) => result.accepted));
    return results;
  }

  deleteChunksForDocument(documentId: string, filter: IndexFilter): IndexChunkDeleteResult {
    const result = this.delegate.deleteChunksForDocument(documentId, filter);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  getChunk(chunkId: string, filter: IndexFilter): IndexedChunk | undefined {
    return this.delegate.getChunk(chunkId, filter);
  }

  hasChunk(chunkId: string, filter: IndexFilter): boolean {
    return this.delegate.hasChunk(chunkId, filter);
  }

  findChunks(filter: IndexFilter): readonly IndexedChunk[] {
    return this.delegate.findChunks(filter);
  }

  listChunks(filter: IndexFilter): readonly IndexedChunk[] {
    return this.delegate.listChunks(filter);
  }

  stats(): IndexStats {
    return this.delegate.stats();
  }

  snapshot(): IndexSnapshot {
    return this.delegate.snapshot();
  }

  flush(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });

    const snapshot = this.snapshot();
    const body = JSON.stringify(snapshot, null, this.pretty ? 2 : 0);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, body, "utf8");
    renameSync(temporaryPath, this.filePath);
  }

  private flushIfNeeded(changed: boolean): void {
    if (changed && this.autosave) {
      this.flush();
    }
  }
}

function loadSnapshot(filePath: string): IndexSnapshot | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isSnapshot(parsed)) {
    throw new Error(`Invalid index snapshot at "${filePath}".`);
  }

  return parsed;
}

function isSnapshot(value: unknown): value is IndexSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { documents?: unknown }).documents) &&
    Array.isArray((value as { chunks?: unknown }).chunks)
  );
}
