import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import {
  EmbeddingIndexer,
  type EmbeddingIndexResult,
  type EmbeddingIndexWarning
} from "./embedding-indexer.js";
import type { EmbeddingAdapter } from "./embedding-types.js";
import {
  LayoutRelationIndexer,
  type LayoutRelationIndexResult,
  type LayoutRelationIndexWarning
} from "./layout-relation-indexer.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { IndexOverwriteMode } from "../indexing/index-types.js";

export interface BatchEmbeddingIndexerOptions {
  readonly adapter: EmbeddingAdapter;
  readonly vectorStore: VectorStore;
  readonly now?: () => string;
}

export interface BatchEmbeddingIndexRequest {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly requestedAt?: string;
  readonly overwriteMode?: IndexOverwriteMode;
}

export interface BatchEmbeddingIndexResult {
  readonly embeddedAt: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly indexedVectorCount: number;
  readonly indexedRelationVectorCount: number;
  readonly candidateRelationCount: number;
  readonly text: EmbeddingIndexResult;
  readonly relations: LayoutRelationIndexResult;
  readonly warnings: readonly BatchEmbeddingIndexWarning[];
}

export type BatchEmbeddingIndexWarning =
  | ({
      readonly kind: "chunk";
    } & EmbeddingIndexWarning)
  | ({
      readonly kind: "layout_relation";
    } & LayoutRelationIndexWarning);

export class BatchEmbeddingIndexer {
  private readonly adapter: EmbeddingAdapter;
  private readonly vectorStore: VectorStore;
  private readonly now: () => string;

  constructor(options: BatchEmbeddingIndexerOptions) {
    this.adapter = options.adapter;
    this.vectorStore = options.vectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async index(request: BatchEmbeddingIndexRequest): Promise<BatchEmbeddingIndexResult> {
    const requestedAt = request.requestedAt ?? this.now();
    const text = await new EmbeddingIndexer({
      adapter: this.adapter,
      vectorStore: this.vectorStore,
      now: () => requestedAt
    }).indexChunks({
      chunks: request.chunks,
      requestedAt,
      overwriteMode: request.overwriteMode ?? "replace"
    });
    const relations = await new LayoutRelationIndexer({
      adapter: this.adapter,
      vectorStore: this.vectorStore,
      now: () => requestedAt
    }).indexRelations({
      documents: request.documents,
      chunks: request.chunks,
      requestedAt,
      overwriteMode: request.overwriteMode ?? "replace"
    });

    return {
      embeddedAt: requestedAt,
      provider: text.provider,
      modelName: text.modelName,
      dimensions: text.dimensions,
      indexedVectorCount: text.indexedVectorCount,
      indexedRelationVectorCount: relations.indexedRelationVectorCount,
      candidateRelationCount: relations.candidateRelationCount,
      text,
      relations,
      warnings: [
        ...text.warnings.map((warning) => ({
          kind: "chunk" as const,
          ...warning
        })),
        ...relations.warnings.map((warning) => ({
          kind: "layout_relation" as const,
          ...warning
        }))
      ]
    };
  }
}
