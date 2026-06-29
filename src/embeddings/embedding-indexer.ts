import type { RagChunk } from "../documents/chunk.js";
import type { ChunkVector, VectorStore } from "../indexing/vector-store.js";
import { embeddingIdentityFor, embeddingIndexConfigHashFor } from "./embedding-identity.js";
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
        text: embeddingTextForChunk(chunk)
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
    const identity = embeddingIdentityFor({
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      adapterId: this.adapter.id
    });
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

      const indexConfigHash = embeddingIndexConfigHashFor({
        provider: result.provider,
        modelName: result.modelName,
        dimensions: result.dimensions,
        adapterId: this.adapter.id,
        ...optionalIdentityMetadata(chunk.metadata)
      });

      vectors.push({
        id: vectorId(identity.embeddingConfigHash, chunk.id),
        chunkId: chunk.id,
        documentId: chunk.documentId,
        tenantId: chunk.accessScope.tenantId,
        namespaceId: chunk.namespaceId,
        textHash: chunk.textHash,
        embeddingModel: result.modelName,
        embeddingProvider: result.provider,
        embeddingConfigHash: identity.embeddingConfigHash,
        dimensions: result.dimensions,
        vector: embedding.vector,
        embeddedAt,
        metadata: {
          ...(chunk.metadata ?? {}),
          embeddingProvider: result.provider,
          embeddingAdapterId: this.adapter.id,
          embeddingConfigHash: identity.embeddingConfigHash,
          embeddingIndexConfigHash: indexConfigHash
        }
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

function vectorId(embeddingConfigHash: string, chunkId: string): string {
  return `${embeddingConfigHash}_${chunkId}`;
}

function embeddingTextForChunk(chunk: RagChunk): string {
  const enriched = stringMetadata(chunk.metadata, "searchableEmbeddingText");
  return enriched ?? chunk.text;
}

function stringMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalIdentityMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined
): {
  readonly chunkingPolicyId?: string;
  readonly chunkingPolicyVersion?: string;
  readonly chunkerVersion?: string;
  readonly preprocessingVersion?: string;
} {
  const chunkingPolicyId = stringMetadata(metadata, "chunkingPolicyId");
  const chunkingPolicyVersion = stringMetadata(metadata, "chunkingPolicyVersion");
  const chunkerVersion = stringMetadata(metadata, "chunkerVersion");
  const preprocessingVersion = stringMetadata(metadata, "preprocessingVersion");

  return {
    ...(chunkingPolicyId === undefined ? {} : { chunkingPolicyId }),
    ...(chunkingPolicyVersion === undefined ? {} : { chunkingPolicyVersion }),
    ...(chunkerVersion === undefined ? {} : { chunkerVersion }),
    ...(preprocessingVersion === undefined ? {} : { preprocessingVersion })
  };
}
