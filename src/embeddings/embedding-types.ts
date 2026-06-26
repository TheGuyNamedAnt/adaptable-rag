export type EmbeddingVector = readonly number[];

export interface EmbeddingInput {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface TextEmbedding {
  readonly id: string;
  readonly vector: EmbeddingVector;
  readonly textHash: string;
}

export interface EmbeddingUsage {
  readonly inputCount: number;
  readonly totalInputCharacters: number;
}

export interface EmbeddingRequest {
  readonly inputs: readonly EmbeddingInput[];
  readonly requestedAt?: string;
}

export type EmbeddingBatchStatus = "succeeded" | "failed";

export interface EmbeddingBatchResult {
  readonly status: EmbeddingBatchStatus;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly embeddings: readonly TextEmbedding[];
  readonly usage: EmbeddingUsage;
  readonly warnings: readonly string[];
  readonly errorMessage?: string;
}

export interface EmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  embed(request: EmbeddingRequest): Promise<EmbeddingBatchResult>;
}
