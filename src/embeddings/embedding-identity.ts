import { hashText } from "../shared/hash.js";

export interface EmbeddingIdentityInput {
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly adapterId?: string;
  readonly configId?: string;
  readonly preprocessingVersion?: string;
  readonly chunkingPolicyId?: string;
  readonly chunkingPolicyVersion?: string;
  readonly chunkerVersion?: string;
}

export interface EmbeddingIdentity {
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly embeddingConfigHash: string;
}

export function embeddingIdentityFor(input: EmbeddingIdentityInput): EmbeddingIdentity {
  return {
    embeddingProvider: input.provider,
    embeddingModel: input.modelName,
    embeddingDimensions: input.dimensions,
    embeddingConfigHash: embeddingConfigHashFor(input)
  };
}

export function embeddingConfigHashFor(input: EmbeddingIdentityInput): string {
  return hashText(JSON.stringify(embeddingIdentityPayload(input, "query_compatible")));
}

export function embeddingIndexConfigHashFor(input: EmbeddingIdentityInput): string {
  return hashText(JSON.stringify(embeddingIdentityPayload(input, "index_full")));
}

function embeddingIdentityPayload(
  input: EmbeddingIdentityInput,
  scope: "query_compatible" | "index_full"
): Readonly<Record<string, string | number>> {
  return {
    provider: input.provider,
    modelName: input.modelName,
    dimensions: input.dimensions,
    ...(input.adapterId === undefined ? {} : { adapterId: input.adapterId }),
    ...(input.configId === undefined ? {} : { configId: input.configId }),
    ...(scope === "query_compatible"
      ? {}
      : {
          ...(input.preprocessingVersion === undefined
            ? {}
            : { preprocessingVersion: input.preprocessingVersion }),
          ...(input.chunkingPolicyId === undefined
            ? {}
            : { chunkingPolicyId: input.chunkingPolicyId }),
          ...(input.chunkingPolicyVersion === undefined
            ? {}
            : { chunkingPolicyVersion: input.chunkingPolicyVersion }),
          ...(input.chunkerVersion === undefined ? {} : { chunkerVersion: input.chunkerVersion })
        })
  };
}
