import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  RerankModelCandidateInput,
  RerankModelRequest,
  RerankModelScore
} from "./model-reranker.js";
import {
  ProviderRerankAdapter,
  type ProviderRerankParsedResponse
} from "./provider-rerank-adapter.js";

export interface JsonRerankPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
}

export function createJsonRerankAdapter(options: JsonRerankPresetOptions): ProviderRerankAdapter {
  return new ProviderRerankAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildRequestBody: (request) =>
      buildJsonRerankRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseJsonRerankResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildJsonRerankRequestBody(
  request: RerankModelRequest,
  options: { readonly modelName: string; readonly temperature?: number }
): Record<string, unknown> {
  const userPayload = {
    query: request.query,
    candidates: request.candidates.map(toProviderCandidate),
    contract: {
      output:
        'Return strict JSON: {"scores":[{"chunkId":"...","score":0.0-1.0,"reason":"short optional reason"}]}',
      allowedChunkIds: request.candidates.map((candidate) => candidate.chunkId)
    }
  };

  return {
    model: options.modelName,
    messages: [
      {
        role: "system",
        content:
          "Score each candidate for relevance to the query. Return only candidate chunk ids from the request. Do not add new chunk ids."
      },
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ],
    response_format: { type: "json_object" },
    temperature: options.temperature ?? 0
  };
}

export function parseJsonRerankResponse(
  response: ProviderHttpResponse,
  request: RerankModelRequest
): ProviderRerankParsedResponse {
  const record = extractJsonRecord(response.body);
  const scores = readScores(record["scores"] ?? record["results"] ?? record["rankings"], request);
  const usage = parseProviderUsage(response.body);
  const warnings = readStringArray(record["warnings"]);

  return {
    scores,
    ...(usage === undefined ? {} : { usage }),
    ...(warnings.length === 0 ? {} : { warnings })
  };
}

export function parseProviderUsage(body: unknown):
  | {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    }
  | undefined {
  if (!isRecord(body) || !isRecord(body["usage"])) {
    return undefined;
  }

  const usage = body["usage"];
  const promptTokens = readNumber(usage["input_tokens"] ?? usage["prompt_tokens"]);
  const completionTokens = readNumber(usage["output_tokens"] ?? usage["completion_tokens"]);
  const totalTokens = readNumber(usage["total_tokens"]);
  const resolvedTotal =
    totalTokens ??
    (promptTokens === undefined && completionTokens === undefined
      ? undefined
      : (promptTokens ?? 0) + (completionTokens ?? 0));

  if (promptTokens === undefined && completionTokens === undefined && resolvedTotal === undefined) {
    return undefined;
  }

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: resolvedTotal ?? 0
  };
}

export function extractJsonRecord(body: unknown): Record<string, unknown> {
  if (isRecord(body) && hasScorePayload(body)) {
    return body;
  }

  const text = extractText(body);
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Throw the normalized error below.
  }

  throw new Error("Rerank provider response must include a JSON object.");
}

function toProviderCandidate(candidate: RerankModelCandidateInput): Record<string, unknown> {
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    title: candidate.title,
    sourceId: candidate.sourceId,
    sourceKind: candidate.sourceKind,
    trustTier: candidate.trustTier,
    retrievalScore: candidate.retrievalScore,
    retrievalRank: candidate.retrievalRank,
    text: candidate.text
  };
}

function readScores(value: unknown, request: RerankModelRequest): readonly RerankModelScore[] {
  if (!Array.isArray(value)) {
    throw new Error("Rerank provider response must include scores array.");
  }

  return value.map((item) => readScore(item, request));
}

function readScore(value: unknown, request: RerankModelRequest): RerankModelScore {
  if (!isRecord(value)) {
    throw new Error("Rerank provider score item must be an object.");
  }

  const chunkId = readChunkId(value, request);
  const score = readNumber(value["score"] ?? value["relevance_score"] ?? value["relevanceScore"]);
  if (chunkId === undefined) {
    throw new Error("Rerank provider score item must include chunkId or index.");
  }
  if (score === undefined) {
    throw new Error("Rerank provider score item must include a numeric score.");
  }

  const reason = typeof value["reason"] === "string" ? value["reason"] : undefined;
  return {
    chunkId,
    score,
    ...(reason === undefined ? {} : { reason })
  };
}

function readChunkId(
  value: Record<string, unknown>,
  request: RerankModelRequest
): string | undefined {
  const direct = value["chunkId"] ?? value["chunk_id"] ?? value["id"];
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const index = value["index"];
  if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
    return request.candidates[index]?.chunkId;
  }

  return undefined;
}

function extractText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Provider response body must be an object.");
  }

  if (typeof body["output_text"] === "string") {
    return body["output_text"];
  }

  const choices = body["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first["message"];
      if (isRecord(message) && typeof message["content"] === "string") {
        return message["content"];
      }
      if (typeof first["text"] === "string") {
        return first["text"];
      }
    }
  }

  const output = body["output"];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }
      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (isRecord(part) && typeof part["text"] === "string") {
          return part["text"];
        }
      }
    }
  }

  throw new Error("Provider response did not include rerank text.");
}

function hasScorePayload(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value["scores"]) ||
    Array.isArray(value["results"]) ||
    Array.isArray(value["rankings"])
  );
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
