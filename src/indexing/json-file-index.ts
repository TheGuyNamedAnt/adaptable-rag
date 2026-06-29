import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
import { LOCAL_INDEX_SCALE_CAPABILITIES } from "./scale-capabilities.js";

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
    supportsHybridSearch: false,
    scale: LOCAL_INDEX_SCALE_CAPABILITIES
  };

  private readonly filePath: string;
  private readonly autosave: boolean;
  private readonly pretty: boolean;
  private readonly now: (() => string) | undefined;
  private readonly chunkingPolicy: ChunkingPolicy | undefined;
  private delegate: InMemoryRagIndex;
  private loadedMtimeMs: number | undefined;

  constructor(options: JsonFileRagIndexOptions) {
    this.filePath = options.filePath;
    this.autosave = options.autosave ?? true;
    this.pretty = options.pretty ?? false;
    this.now = options.now;
    this.chunkingPolicy = options.chunkingPolicy;
    const snapshot = loadSnapshot(options.filePath);
    this.loadedMtimeMs = fileMtimeMs(options.filePath);
    this.delegate = this.createDelegate(snapshot);
  }

  addDocument(document: RagDocument, options: IndexDocumentOptions = {}): IndexOperationResult {
    this.reloadIfChanged();
    const result = this.delegate.addDocument(document, options);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  deleteDocument(documentId: string, filter: IndexFilter): IndexDocumentDeleteResult {
    this.reloadIfChanged();
    const result = this.delegate.deleteDocument(documentId, filter);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  getDocument(documentId: string, filter: IndexFilter): IndexedDocument | undefined {
    this.reloadIfChanged();
    return this.delegate.getDocument(documentId, filter);
  }

  hasDocument(documentId: string, filter: IndexFilter): boolean {
    this.reloadIfChanged();
    return this.delegate.hasDocument(documentId, filter);
  }

  findDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    this.reloadIfChanged();
    return this.delegate.findDocuments(filter);
  }

  listDocuments(filter: IndexFilter): readonly IndexedDocument[] {
    this.reloadIfChanged();
    return this.delegate.listDocuments(filter);
  }

  addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    this.reloadIfChanged();
    const results = this.delegate.addChunks(documentId, chunks, options);
    this.flushIfNeeded(results.some((result) => result.accepted));
    return results;
  }

  deleteChunksForDocument(documentId: string, filter: IndexFilter): IndexChunkDeleteResult {
    this.reloadIfChanged();
    const result = this.delegate.deleteChunksForDocument(documentId, filter);
    this.flushIfNeeded(result.accepted);
    return result;
  }

  getChunk(chunkId: string, filter: IndexFilter): IndexedChunk | undefined {
    this.reloadIfChanged();
    return this.delegate.getChunk(chunkId, filter);
  }

  hasChunk(chunkId: string, filter: IndexFilter): boolean {
    this.reloadIfChanged();
    return this.delegate.hasChunk(chunkId, filter);
  }

  findChunks(filter: IndexFilter): readonly IndexedChunk[] {
    this.reloadIfChanged();
    return this.delegate.findChunks(filter);
  }

  listChunks(filter: IndexFilter): readonly IndexedChunk[] {
    this.reloadIfChanged();
    return this.delegate.listChunks(filter);
  }

  stats(): IndexStats {
    this.reloadIfChanged();
    return this.delegate.stats();
  }

  snapshot(): IndexSnapshot {
    this.reloadIfChanged();
    return this.delegate.snapshot();
  }

  flush(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });

    const snapshot = this.delegate.snapshot();
    const body = JSON.stringify(snapshot, null, this.pretty ? 2 : 0);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, body, "utf8");
    renameSync(temporaryPath, this.filePath);
    this.loadedMtimeMs = fileMtimeMs(this.filePath);
  }

  private flushIfNeeded(changed: boolean): void {
    if (changed && this.autosave) {
      this.flush();
    }
  }

  private createDelegate(snapshot: IndexSnapshot | undefined): InMemoryRagIndex {
    return new InMemoryRagIndex({
      ...(this.now ? { now: this.now } : {}),
      ...(this.chunkingPolicy ? { chunkingPolicy: this.chunkingPolicy } : {}),
      ...(snapshot ? { snapshot } : {})
    });
  }

  private reloadIfChanged(): void {
    const nextMtimeMs = fileMtimeMs(this.filePath);
    if (nextMtimeMs === undefined) {
      if (this.loadedMtimeMs !== undefined) {
        this.delegate = this.createDelegate(undefined);
        this.loadedMtimeMs = undefined;
      }
      return;
    }
    if (nextMtimeMs === this.loadedMtimeMs) {
      return;
    }
    this.delegate = this.createDelegate(loadSnapshot(this.filePath));
    this.loadedMtimeMs = nextMtimeMs;
  }
}

function fileMtimeMs(filePath: string): number | undefined {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return undefined;
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
