export type VisualEmbeddingVector = readonly number[];

export interface VisualEmbeddingInput {
  readonly id: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly mediaType: string;
  readonly visualAssetId?: string;
  readonly uri?: string;
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface VisualEmbedding {
  readonly id: string;
  readonly vectors: readonly VisualEmbeddingVector[];
  readonly textHash?: string;
  readonly visualAssetId?: string;
}

export interface VisualEmbeddingUsage {
  readonly inputCount: number;
  readonly totalInputCharacters: number;
  readonly vectorCount: number;
}

export interface VisualEmbeddingRequest {
  readonly inputs: readonly VisualEmbeddingInput[];
  readonly requestedAt?: string;
}

export interface VisualQueryEmbeddingRequest {
  readonly query: string;
  readonly requestedAt?: string;
}

export type VisualEmbeddingBatchStatus = "succeeded" | "failed";

export interface VisualEmbeddingBatchResult {
  readonly status: VisualEmbeddingBatchStatus;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly embeddings: readonly VisualEmbedding[];
  readonly usage: VisualEmbeddingUsage;
  readonly warnings: readonly string[];
  readonly errorMessage?: string;
}

export interface VisualQueryEmbeddingResult {
  readonly status: VisualEmbeddingBatchStatus;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly vectors: readonly VisualEmbeddingVector[];
  readonly usage: VisualEmbeddingUsage;
  readonly warnings: readonly string[];
  readonly errorMessage?: string;
}

export interface VisualEmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  embedVisualAssets(request: VisualEmbeddingRequest): Promise<VisualEmbeddingBatchResult>;
  embedQuery(request: VisualQueryEmbeddingRequest): Promise<VisualQueryEmbeddingResult>;
}
