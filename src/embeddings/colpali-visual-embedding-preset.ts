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

export interface ColPaliVisualEmbeddingPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function createColPaliVisualEmbeddingAdapter(
  options: ColPaliVisualEmbeddingPresetOptions
): ProviderVisualEmbeddingAdapter {
  return new ProviderVisualEmbeddingAdapter({
    config: options.config,
    dimensions: options.dimensions,
    secrets: options.secrets,
    transport: options.transport,
    buildVisualAssetsRequestBody: (request) =>
      buildColPaliVisualEmbeddingRequestBody(request, options.config.modelName),
    buildQueryRequestBody: (request) =>
      buildColPaliVisualQueryEmbeddingRequestBody(request, options.config.modelName),
    parseVisualAssetsResponse: parseColPaliVisualEmbeddingResponse,
    parseQueryResponse: parseColPaliVisualQueryEmbeddingResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildColPaliVisualEmbeddingRequestBody(
  request: VisualEmbeddingRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    task: "index",
    input: request.inputs.map((input) => ({
      id: input.id,
      chunk_id: input.chunkId,
      document_id: input.documentId,
      media_type: input.mediaType,
      visual_asset_id: input.visualAssetId,
      image_uri: input.uri,
      text: input.text,
      metadata: input.metadata
    })),
    late_interaction: {
      scoring: "maxsim",
      vector_granularity: "patch"
    },
    encoding_format: "float"
  };
}

export function buildColPaliVisualQueryEmbeddingRequestBody(
  request: VisualQueryEmbeddingRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    task: "query",
    query: request.query,
    late_interaction: {
      scoring: "maxsim",
      vector_granularity: "token"
    },
    encoding_format: "float"
  };
}

export function parseColPaliVisualEmbeddingResponse(
  response: ProviderHttpResponse,
  request: VisualEmbeddingRequest
): ProviderVisualEmbeddingParsedResponse {
  const body = requiredRecord(response.body, "ColPali visual embedding response");
  const items = requiredArray(body["data"], "ColPali visual embedding response data");
  const embeddings = items.map((item, index) => {
    const record = requiredRecord(item, "ColPali visual embedding item");
    const input = inputForItem(record, index, request);
    const vectors = readVectors(
      record["patch_vectors"] ?? record["vectors"] ?? record["embedding"]
    );
    const visualAssetId =
      optionalString(record["visual_asset_id"]) ??
      optionalString(record["asset_id"]) ??
      input.visualAssetId;

    return {
      id: input.id,
      vectors,
      ...(visualAssetId === undefined ? {} : { visualAssetId })
    };
  });

  return {
    embeddings,
    ...readUsageAndWarnings(body)
  };
}

export function parseColPaliVisualQueryEmbeddingResponse(
  response: ProviderHttpResponse
): ProviderVisualQueryEmbeddingParsedResponse {
  const body = requiredRecord(response.body, "ColPali visual query response");
  const vectors = readVectors(body["query_vectors"] ?? body["vectors"] ?? body["embedding"]);

  return {
    vectors,
    ...readUsageAndWarnings(body)
  };
}

function inputForItem(
  item: Record<string, unknown>,
  fallbackIndex: number,
  request: VisualEmbeddingRequest
): VisualEmbeddingRequest["inputs"][number] {
  const id = optionalString(item["id"]);
  if (id !== undefined) {
    const input = request.inputs.find((candidate) => candidate.id === id);
    if (input === undefined) {
      throw new Error(`ColPali provider returned unknown input id "${id}".`);
    }
    return input;
  }

  const index = integerOrFallback(item["index"], fallbackIndex);
  const input = request.inputs[index];
  if (input === undefined) {
    throw new Error(`ColPali provider returned unknown input index ${index}.`);
  }
  return input;
}

function readVectors(value: unknown): readonly VisualEmbeddingVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ColPali provider response included no vectors.");
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
    throw new Error("ColPali provider response included an invalid vector.");
  }
  return value;
}

function readUsageAndWarnings(
  body: Record<string, unknown>
): Pick<ProviderVisualEmbeddingParsedResponse, "usage" | "warnings"> {
  const usageRecord = isRecord(body["usage"]) ? body["usage"] : undefined;
  const warnings = optionalStringArray(body["warnings"]);

  return {
    ...(usageRecord === undefined
      ? {}
      : {
          usage: {
            inputCount: numberField(usageRecord, "input_count", "inputCount"),
            totalInputCharacters: numberField(
              usageRecord,
              "total_input_characters",
              "totalInputCharacters"
            ),
            vectorCount: numberField(usageRecord, "vector_count", "vectorCount")
          }
        }),
    ...(warnings === undefined ? {} : { warnings })
  };
}

function numberField(
  record: Record<string, unknown>,
  snakeName: string,
  camelName: string
): number {
  const value = record[snakeName] ?? record[camelName];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`ColPali usage field ${snakeName} must be a non-negative number.`);
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error("ColPali provider warnings must be strings.");
  }
  return value;
}

function integerOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
