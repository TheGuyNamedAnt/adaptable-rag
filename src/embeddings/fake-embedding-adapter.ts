import { hashText } from "../shared/hash.js";
import { normalizeVector } from "../shared/vector-math.js";
import type {
  EmbeddingAdapter,
  EmbeddingBatchResult,
  EmbeddingRequest,
  EmbeddingVector
} from "./embedding-types.js";

export interface FakeEmbeddingAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly dimensions?: number;
  readonly failWith?: string;
}

const DEFAULT_DIMENSIONS = 64;

export class FakeEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;

  private readonly failWith: string | undefined;

  constructor(options: FakeEmbeddingAdapterOptions = {}) {
    this.id = options.id ?? "fake-embedding-adapter";
    this.provider = options.provider ?? "fake";
    this.modelName = options.modelName ?? "fake-hashed-token-embedding";
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.failWith = options.failWith;

    if (!Number.isInteger(this.dimensions) || this.dimensions < 2) {
      throw new Error("FakeEmbeddingAdapter dimensions must be an integer >= 2.");
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingBatchResult> {
    const usage = {
      inputCount: request.inputs.length,
      totalInputCharacters: request.inputs.reduce((count, input) => count + input.text.length, 0)
    };

    if (this.failWith) {
      return {
        status: "failed",
        provider: this.provider,
        modelName: this.modelName,
        dimensions: this.dimensions,
        embeddings: [],
        usage,
        warnings: [],
        errorMessage: this.failWith
      };
    }

    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings: request.inputs.map((input) => ({
        id: input.id,
        vector: embedText(input.text, this.dimensions),
        textHash: hashText(input.text)
      })),
      usage,
      warnings: []
    };
  }
}

export function embedText(text: string, dimensions: number = DEFAULT_DIMENSIONS): EmbeddingVector {
  if (!Number.isInteger(dimensions) || dimensions < 2) {
    throw new Error("Embedding dimensions must be an integer >= 2.");
  }

  const vector = Array.from({ length: dimensions }, () => 0);
  const terms = tokenizeEmbeddingText(text);
  const tokens = terms.length > 0 ? terms : [hashText(text).slice(0, 16)];

  for (const token of tokens) {
    const digest = hashText(token);
    const index = Number.parseInt(digest.slice(0, 8), 16) % dimensions;
    const sign = Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  return normalizeVector(vector);
}

export function tokenizeEmbeddingText(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
}
