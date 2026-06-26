import { hashText } from "../shared/hash.js";
import { normalizeVector } from "../shared/vector-math.js";
import type {
  VisualEmbedding,
  VisualEmbeddingAdapter,
  VisualEmbeddingBatchResult,
  VisualEmbeddingRequest,
  VisualEmbeddingUsage,
  VisualEmbeddingVector,
  VisualQueryEmbeddingRequest,
  VisualQueryEmbeddingResult
} from "./visual-embedding-types.js";

export interface FakeVisualEmbeddingAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly dimensions?: number;
  readonly failWith?: string;
}

const DEFAULT_DIMENSIONS = 64;
const MAX_QUERY_VECTORS = 8;

export class FakeVisualEmbeddingAdapter implements VisualEmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;

  private readonly failWith: string | undefined;

  constructor(options: FakeVisualEmbeddingAdapterOptions = {}) {
    this.id = options.id ?? "fake-visual-embedding-adapter";
    this.provider = options.provider ?? "fake";
    this.modelName = options.modelName ?? "fake-visual-multivector-embedding";
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.failWith = options.failWith;

    if (!Number.isInteger(this.dimensions) || this.dimensions < 2) {
      throw new Error("FakeVisualEmbeddingAdapter dimensions must be an integer >= 2.");
    }
  }

  async embedVisualAssets(request: VisualEmbeddingRequest): Promise<VisualEmbeddingBatchResult> {
    const embeddings = request.inputs.map<VisualEmbedding>((input) => {
      const basis = [input.text ?? "", input.uri ?? "", input.visualAssetId ?? input.id]
        .filter((value) => value.trim().length > 0)
        .join(" ");
      const vectors = visualVectorsForText(basis, this.dimensions);

      return {
        id: input.id,
        vectors,
        textHash: hashText(basis),
        ...(input.visualAssetId === undefined ? {} : { visualAssetId: input.visualAssetId })
      };
    });

    return this.result(embeddings, usageFor(request.inputs.length, embeddings, request.inputs));
  }

  async embedQuery(request: VisualQueryEmbeddingRequest): Promise<VisualQueryEmbeddingResult> {
    const vectors = visualVectorsForText(request.query, this.dimensions).slice(
      0,
      MAX_QUERY_VECTORS
    );
    const usage = {
      inputCount: 1,
      totalInputCharacters: request.query.length,
      vectorCount: vectors.length
    };

    if (this.failWith) {
      return {
        status: "failed",
        provider: this.provider,
        modelName: this.modelName,
        dimensions: this.dimensions,
        vectors: [],
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
      vectors,
      usage,
      warnings: []
    };
  }

  private result(
    embeddings: readonly VisualEmbedding[],
    usage: VisualEmbeddingUsage
  ): VisualEmbeddingBatchResult {
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
      embeddings,
      usage,
      warnings: []
    };
  }
}

export function visualVectorsForText(
  text: string,
  dimensions: number = DEFAULT_DIMENSIONS
): readonly VisualEmbeddingVector[] {
  if (!Number.isInteger(dimensions) || dimensions < 2) {
    throw new Error("Visual embedding dimensions must be an integer >= 2.");
  }

  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [hashText(text).slice(0, 16)];
  return tokens.map((token) => embedVisualToken(token, dimensions));
}

function embedVisualToken(token: string, dimensions: number): VisualEmbeddingVector {
  const vector = Array.from({ length: dimensions }, () => 0);
  const digest = hashText(token);
  const primary = Number.parseInt(digest.slice(0, 8), 16) % dimensions;
  const secondary = Number.parseInt(digest.slice(8, 16), 16) % dimensions;
  const sign = Number.parseInt(digest.slice(16, 18), 16) % 2 === 0 ? 1 : -1;

  vector[primary] = sign;
  vector[secondary] = (vector[secondary] ?? 0) + sign * 0.5;
  return normalizeVector(vector);
}

function usageFor(
  inputCount: number,
  embeddings: readonly VisualEmbedding[],
  inputs: readonly { readonly text?: string; readonly uri?: string }[]
): VisualEmbeddingUsage {
  return {
    inputCount,
    totalInputCharacters: inputs.reduce(
      (count, input) => count + (input.text?.length ?? 0) + (input.uri?.length ?? 0),
      0
    ),
    vectorCount: embeddings.reduce((count, embedding) => count + embedding.vectors.length, 0)
  };
}
