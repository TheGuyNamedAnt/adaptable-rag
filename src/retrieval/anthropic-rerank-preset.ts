import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type { RerankModelRequest } from "./model-reranker.js";
import { buildJsonRerankRequestBody, parseJsonRerankResponse } from "./json-rerank-preset.js";
import {
  ProviderRerankAdapter,
  type ProviderRerankParsedResponse
} from "./provider-rerank-adapter.js";

export interface AnthropicRerankPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
  readonly temperature?: number;
}

export const DEFAULT_ANTHROPIC_RERANK_VERSION = "2023-06-01";

export function createAnthropicRerankAdapter(
  options: AnthropicRerankPresetOptions
): ProviderRerankAdapter {
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_RERANK_VERSION;

  return new ProviderRerankAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildHeaders: ({ apiKey, requestId }) =>
      buildAnthropicRerankRequestHeaders({
        apiKey,
        requestId,
        anthropicVersion,
        ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
      }),
    buildRequestBody: (request) =>
      buildAnthropicRerankRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseAnthropicRerankResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildAnthropicRerankRequestHeaders(input: {
  readonly apiKey: string;
  readonly requestId: string;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-api-key": input.apiKey,
    "x-request-id": input.requestId,
    "anthropic-version": input.anthropicVersion ?? DEFAULT_ANTHROPIC_RERANK_VERSION,
    ...(input.anthropicBeta === undefined ? {} : { "anthropic-beta": input.anthropicBeta })
  };
}

export function buildAnthropicRerankRequestBody(
  request: RerankModelRequest,
  options: {
    readonly modelName: string;
    readonly temperature?: number;
  }
): Record<string, unknown> {
  const jsonBody = buildJsonRerankRequestBody(request, options);
  const messages = Array.isArray(jsonBody["messages"]) ? jsonBody["messages"] : [];
  const userMessage = messages.find(
    (message): message is { readonly role: string; readonly content: string } =>
      isRecord(message) && message["role"] === "user" && typeof message["content"] === "string"
  );

  return {
    model: options.modelName,
    max_tokens: Math.max(256, request.candidates.length * 64),
    system:
      "Score each candidate for relevance to the query. Return strict JSON with a scores array. Use only supplied chunk ids.",
    messages: [
      {
        role: "user",
        content: userMessage?.content ?? JSON.stringify(jsonBody)
      }
    ],
    ...(options.temperature === undefined ? {} : { temperature: options.temperature })
  };
}

export function parseAnthropicRerankResponse(
  response: ProviderHttpResponse,
  request: RerankModelRequest
): ProviderRerankParsedResponse {
  return parseJsonRerankResponse(
    {
      ...response,
      body: {
        output_text: extractAnthropicText(response.body),
        ...(isRecord(response.body) && response.body["usage"]
          ? { usage: response.body["usage"] }
          : {})
      }
    },
    request
  );
}

function extractAnthropicText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Anthropic rerank response body must be an object.");
  }

  const content = body["content"];
  if (!Array.isArray(content)) {
    throw new Error("Anthropic rerank response must include content blocks.");
  }

  const text = content
    .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic rerank response did not include text content.");
  }

  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
