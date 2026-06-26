import type { RagChunk } from "../documents/chunk.js";
import type { ChunkVector, VectorStore } from "../indexing/vector-store.js";
import type { EmbeddingAdapter } from "./embedding-types.js";

export interface EmbeddingIndexerOptions {
  readonly adapter: EmbeddingAdapter;
  readonly vectorStore: VectorStore;
  readonly now?: () => string;
}

export interface EmbeddingIndexChunksRequest {
  readonly chunks: readonly RagChunk[];
  readonly requestedAt?: string;
  readonly overwriteMode?: "reject" | "replace";
}

export interface EmbeddingIndexWarning {
  readonly code: "embedding_failed" | "missing_embedding" | "dimension_mismatch";
  readonly chunkId?: string;
  readonly message: string;
}

export interface EmbeddingIndexResult {
  readonly embeddedAt: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly indexedVectorCount: number;
  readonly warnings: readonly EmbeddingIndexWarning[];
}

export class EmbeddingIndexer {
  private readonly adapter: EmbeddingAdapter;
  private readonly vectorStore: VectorStore;
  private readonly now: () => string;

  constructor(options: EmbeddingIndexerOptions) {
    this.adapter = options.adapter;
    this.vectorStore = options.vectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async indexChunks(request: EmbeddingIndexChunksRequest): Promise<EmbeddingIndexResult> {
    const embeddedAt = request.requestedAt ?? this.now();
    const warnings: EmbeddingIndexWarning[] = [];
    const result = await this.adapter.embed({
      inputs: request.chunks.map((chunk) => ({
        id: chunk.id,
        text: chunk.text
      })),
      requestedAt: embeddedAt
    });

    if (result.status === "failed") {
      return {
        embeddedAt,
        provider: result.provider,
        modelName: result.modelName,
        dimensions: result.dimensions,
        indexedVectorCount: 0,
        warnings: [
          {
            code: "embedding_failed",
            message: result.errorMessage ?? "Embedding adapter failed."
          }
        ]
      };
    }

    const embeddingsByChunkId = new Map(
      result.embeddings.map((embedding) => [embedding.id, embedding])
    );
    const vectors: ChunkVector[] = [];

    for (const chunk of request.chunks) {
      const embedding = embeddingsByChunkId.get(chunk.id);
      if (!embedding) {
        warnings.push({
          code: "missing_embedding",
          chunkId: chunk.id,
          message: "Embedding adapter did not return an embedding for this chunk."
        });
        continue;
      }

      if (embedding.vector.length !== result.dimensions) {
        warnings.push({
          code: "dimension_mismatch",
          chunkId: chunk.id,
          message: "Embedding vector dimensions did not match the adapter result dimensions."
        });
        continue;
      }

      vectors.push({
        id: vectorId(result.modelName, chunk.id),
        chunkId: chunk.id,
        documentId: chunk.documentId,
        tenantId: chunk.accessScope.tenantId,
        namespaceId: chunk.namespaceId,
        textHash: chunk.textHash,
        embeddingModel: result.modelName,
        dimensions: result.dimensions,
        vector: embedding.vector,
        embeddedAt
      });
    }

    const indexResults = await this.vectorStore.addChunkVectors(vectors, {
      overwriteMode: request.overwriteMode ?? "replace",
      indexedAt: embeddedAt
    });

    return {
      embeddedAt,
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      indexedVectorCount: indexResults.filter((indexResult) => indexResult.accepted).length,
      warnings
    };
  }
}

function vectorId(modelName: string, chunkId: string): string {
  return `${modelName.replace(/[^a-z0-9_-]/gi, "_")}_${chunkId}`;
}
