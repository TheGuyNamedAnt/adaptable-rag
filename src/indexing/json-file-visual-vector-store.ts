import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ChunkStore } from "./chunk-store.js";
import type { IndexOperationResult } from "./index-types.js";
import {
  InMemoryVisualVectorStore,
  type VisualChunkVector,
  type VisualVectorIndexOptions,
  type VisualVectorSearchRequest,
  type VisualVectorSearchResult,
  type VisualVectorSnapshot,
  type VisualVectorStore,
  type VisualVectorStoreCapabilities
} from "./visual-vector-store.js";

export interface JsonFileVisualVectorStoreOptions {
  readonly filePath: string;
  readonly chunkStore: ChunkStore;
  readonly dimensions?: number;
  readonly now?: () => string;
  readonly autosave?: boolean;
  readonly pretty?: boolean;
}

export class JsonFileVisualVectorStore implements VisualVectorStore {
  readonly capabilities: VisualVectorStoreCapabilities;

  private readonly filePath: string;
  private readonly autosave: boolean;
  private readonly pretty: boolean;
  private readonly delegate: InMemoryVisualVectorStore;

  constructor(options: JsonFileVisualVectorStoreOptions) {
    this.filePath = options.filePath;
    this.autosave = options.autosave ?? true;
    this.pretty = options.pretty ?? false;
    const snapshot = loadVisualVectorSnapshot(options.filePath);
    this.delegate = new InMemoryVisualVectorStore({
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

  addVisualChunkVectors(
    vectors: readonly VisualChunkVector[],
    options: VisualVectorIndexOptions = {}
  ): readonly IndexOperationResult[] {
    const results = this.delegate.addVisualChunkVectors(vectors, options);
    this.flushIfNeeded(results.some((result) => result.accepted));
    return results;
  }

  deleteVisualVectorsForDocument(documentId: string): number {
    const deleted = this.delegate.deleteVisualVectorsForDocument(documentId);
    this.flushIfNeeded(deleted > 0);
    return deleted;
  }

  findNearestVisualVectors(request: VisualVectorSearchRequest): VisualVectorSearchResult {
    return this.delegate.findNearestVisualVectors(request);
  }

  snapshot(): VisualVectorSnapshot {
    return this.delegate.snapshot();
  }

  visualVectorCount(): number {
    return this.delegate.visualVectorCount();
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

function loadVisualVectorSnapshot(filePath: string): VisualVectorSnapshot | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isVisualVectorSnapshot(parsed)) {
    throw new Error(`Invalid visual vector snapshot at "${filePath}".`);
  }

  return parsed;
}

function isVisualVectorSnapshot(value: unknown): value is VisualVectorSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { vectors?: unknown }).vectors)
  );
}
