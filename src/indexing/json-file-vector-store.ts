import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ChunkStore } from "./chunk-store.js";
import {
  InMemoryVectorStore,
  type ChunkVector,
  type VectorIndexOptions,
  type VectorSearchRequest,
  type VectorSearchResult,
  type VectorSnapshot,
  type VectorStore,
  type VectorStoreCapabilities
} from "./vector-store.js";
import type { IndexOperationResult } from "./index-types.js";

export interface JsonFileVectorStoreOptions {
  readonly filePath: string;
  readonly chunkStore: ChunkStore;
  readonly dimensions?: number;
  readonly now?: () => string;
  readonly autosave?: boolean;
  readonly pretty?: boolean;
}

export class JsonFileVectorStore implements VectorStore {
  readonly capabilities: VectorStoreCapabilities;

  private readonly filePath: string;
  private readonly autosave: boolean;
  private readonly pretty: boolean;
  private readonly delegate: InMemoryVectorStore;

  constructor(options: JsonFileVectorStoreOptions) {
    this.filePath = options.filePath;
    this.autosave = options.autosave ?? true;
    this.pretty = options.pretty ?? false;
    const snapshot = loadVectorSnapshot(options.filePath);
    this.delegate = new InMemoryVectorStore({
      chunkStore: options.chunkStore,
      ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(snapshot ? { snapshot } : {})
    });
    this.capabilities = {
      ...this.delegate.capabilities,
      storageKind: "json_file",
      durable: true
    };
  }

  addChunkVectors(
    vectors: readonly ChunkVector[],
    options: VectorIndexOptions = {}
  ): readonly IndexOperationResult[] {
    const results = this.delegate.addChunkVectors(vectors, options);
    this.flushIfNeeded(results.some((result) => result.accepted));
    return results;
  }

  deleteVectorsForDocument(documentId: string): number {
    const deleted = this.delegate.deleteVectorsForDocument(documentId);
    this.flushIfNeeded(deleted > 0);
    return deleted;
  }

  findNearestVectors(request: VectorSearchRequest): VectorSearchResult {
    return this.delegate.findNearestVectors(request);
  }

  snapshot(): VectorSnapshot {
    return this.delegate.snapshot();
  }

  vectorCount(): number {
    return this.delegate.vectorCount();
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

function loadVectorSnapshot(filePath: string): VectorSnapshot | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isVectorSnapshot(parsed)) {
    throw new Error(`Invalid vector snapshot at "${filePath}".`);
  }

  return parsed;
}

function isVectorSnapshot(value: unknown): value is VectorSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { vectors?: unknown }).vectors)
  );
}
