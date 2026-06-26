import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { ProviderVisualEmbeddingAdapter } from "./provider-visual-embedding-adapter.js";
import type {
  ProviderVisualEmbeddingParsedResponse,
  ProviderVisualQueryEmbeddingParsedResponse
} from "./provider-visual-embedding-adapter.js";
import type {
  VisualEmbeddingRequest,
  VisualEmbeddingVector,
  VisualQueryEmbeddingRequest
} from "./visual-embedding-types.js";

export interface IndexedVisualEmbeddingPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function createIndexedVisualEmbeddingAdapter(
  options: IndexedVisualEmbeddingPresetOptions
): ProviderVisualEmbeddingAdapter {
  return new ProviderVisualEmbeddingAdapter({
    config: options.config,
    dimensions: options.dimensions,
    secrets: options.secrets,
    transport: options.transport,
    buildVisualAssetsRequestBody: (request) =>
      buildIndexedVisualEmbeddingRequestBody(request, options.config.modelName),
    buildQueryRequestBody: (request) =>
      buildIndexedVisualQueryEmbeddingRequestBody(request, options.config.modelName),
    parseVisualAssetsResponse: parseIndexedVisualEmbeddingResponse,
    parseQueryResponse: parseIndexedVisualQueryEmbeddingResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildIndexedVisualEmbeddingRequestBody(
  request: VisualEmbeddingRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    input_type: "visual_asset",
    input: request.inputs.map((input) => ({
      id: input.id,
      chunk_id: input.chunkId,
      document_id: input.documentId,
      media_type: input.mediaType,
      ...(input.visualAssetId === undefined ? {} : { visual_asset_id: input.visualAssetId }),
      ...(input.uri === undefined ? {} : { uri: input.uri }),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    })),
    encoding_format: "float"
  };
}

export function buildIndexedVisualQueryEmbeddingRequestBody(
  request: VisualQueryEmbeddingRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    input_type: "query",
    input: request.query,
    encoding_format: "float"
  };
}

export function parseIndexedVisualEmbeddingResponse(
  response: ProviderHttpResponse,
  request: VisualEmbeddingRequest
): ProviderVisualEmbeddingParsedResponse {
  if (!isRecord(response.body) || !Array.isArray(response.body["data"])) {
    throw new Error("Visual embedding provider response must include data array.");
  }

  const embeddings = response.body["data"].map((item, responseIndex) => {
    if (!isRecord(item)) {
      throw new Error("Visual embedding provider data item must be an object.");
    }

    const input = inputForDataItem(item, responseIndex, request);
    const vectors = readVisualVectors(readVectorPayload(item));
    const visualAssetId = readOptionalString(item["visual_asset_id"]) ?? input.visualAssetId;

    return {
      id: input.id,
      vectors,
      ...(visualAssetId === undefined ? {} : { visualAssetId })
    };
  });
  const usage = parseVisualUsage(response.body["usage"]);
  const warnings = parseWarnings(response.body["warnings"]);

  return {
    embeddings,
    ...(usage === undefined ? {} : { usage }),
    ...(warnings === undefined ? {} : { warnings })
  };
}

export function parseIndexedVisualQueryEmbeddingResponse(
  response: ProviderHttpResponse
): ProviderVisualQueryEmbeddingParsedResponse {
  if (!isRecord(response.body)) {
    throw new Error("Visual query embedding provider response must be an object.");
  }

  const payload = queryVectorPayload(response.body);
  const usage = parseVisualUsage(response.body["usage"]);
  const warnings = parseWarnings(response.body["warnings"]);

  return {
    vectors: readVisualVectors(payload),
    ...(usage === undefined ? {} : { usage }),
    ...(warnings === undefined ? {} : { warnings })
  };
}

function inputForDataItem(
  item: Record<string, unknown>,
  responseIndex: number,
  request: VisualEmbeddingRequest
): VisualEmbeddingRequest["inputs"][number] {
  const providerId = readOptionalString(item["id"]);
  if (providerId !== undefined) {
    const input = request.inputs.find((candidate) => candidate.id === providerId);
    if (input === undefined) {
      throw new Error("Visual embedding provider returned an unknown input id.");
    }
    return input;
  }

  const providerIndex = readProviderIndex(item["index"], responseIndex);
  const input = request.inputs[providerIndex];
  if (input === undefined) {
    throw new Error("Visual embedding provider returned an unknown input index.");
  }

  return input;
}

function queryVectorPayload(body: Record<string, unknown>): unknown {
  if (Array.isArray(body["data"])) {
    const first = body["data"][0];
    if (!isRecord(first)) {
      throw new Error("Visual query embedding provider data item must be an object.");
    }
    return readVectorPayload(first);
  }

  return readVectorPayload(body);
}

function readVectorPayload(item: Record<string, unknown>): unknown {
  if ("vectors" in item) {
    return item["vectors"];
  }

  if ("embeddings" in item) {
    return item["embeddings"];
  }

  if ("embedding" in item) {
    return item["embedding"];
  }

  throw new Error("Visual embedding provider returned no vectors.");
}

function readProviderIndex(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  return fallback;
}

function readVisualVectors(value: unknown): readonly VisualEmbeddingVector[] {
  if (!Array.isArray(value)) {
    throw new Error("Visual embedding provider returned invalid vectors.");
  }

  if (value.length === 0) {
    return [];
  }

  if (value.every((item): item is number => typeof item === "number")) {
    return [readVector(value)];
  }

  return value.map(readVector);
}

function readVector(value: unknown): VisualEmbeddingVector {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is number => typeof item === "number")
  ) {
    throw new Error("Visual embedding provider returned an invalid vector.");
  }

  return value;
}

function parseVisualUsage(value: unknown): ProviderVisualEmbeddingParsedResponse["usage"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputCount = readNumberField(value, "inputCount", "input_count");
  const totalInputCharacters = readNumberField(
    value,
    "totalInputCharacters",
    "total_input_characters"
  );
  const vectorCount = readNumberField(value, "vectorCount", "vector_count");

  if (inputCount === undefined || totalInputCharacters === undefined || vectorCount === undefined) {
    return undefined;
  }

  return {
    inputCount,
    totalInputCharacters,
    vectorCount
  };
}

function readNumberField(
  record: Record<string, unknown>,
  camelName: string,
  snakeName: string
): number | undefined {
  const value = record[camelName] ?? record[snakeName];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Visual embedding provider usage field ${camelName} must be a number.`);
  }

  return value;
}

function parseWarnings(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error("Visual embedding provider warnings must be strings.");
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
