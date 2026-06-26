import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { ProviderEmbeddingAdapter } from "./provider-embedding-adapter.js";
import type { ProviderEmbeddingParsedResponse } from "./provider-embedding-adapter.js";
import type { EmbeddingRequest, EmbeddingVector } from "./embedding-types.js";

export interface IndexedEmbeddingPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function createIndexedEmbeddingAdapter(
  options: IndexedEmbeddingPresetOptions
): ProviderEmbeddingAdapter {
  return new ProviderEmbeddingAdapter({
    config: options.config,
    dimensions: options.dimensions,
    secrets: options.secrets,
    transport: options.transport,
    buildRequestBody: (request) =>
      buildIndexedEmbeddingRequestBody(request, options.config.modelName),
    parseResponse: parseIndexedEmbeddingResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildIndexedEmbeddingRequestBody(
  request: EmbeddingRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    input: request.inputs.map((input) => input.text),
    encoding_format: "float"
  };
}

export function parseIndexedEmbeddingResponse(
  response: ProviderHttpResponse,
  request: EmbeddingRequest
): ProviderEmbeddingParsedResponse {
  if (!isRecord(response.body) || !Array.isArray(response.body["data"])) {
    throw new Error("Embedding provider response must include data array.");
  }

  const embeddings = response.body["data"].map((item, responseIndex) => {
    if (!isRecord(item)) {
      throw new Error("Embedding provider data item must be an object.");
    }

    const providerIndex = readProviderIndex(item["index"], responseIndex);
    const input = request.inputs[providerIndex];
    if (input === undefined) {
      throw new Error("Embedding provider returned an unknown input index.");
    }

    return {
      id: input.id,
      vector: readVector(item["embedding"])
    };
  });

  return { embeddings };
}

function readProviderIndex(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  return fallback;
}

function readVector(value: unknown): EmbeddingVector {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is number => typeof item === "number")
  ) {
    throw new Error("Embedding provider returned an invalid vector.");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
