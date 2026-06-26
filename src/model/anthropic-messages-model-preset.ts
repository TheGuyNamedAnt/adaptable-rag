import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { ProviderModelAdapter } from "./provider-model-adapter.js";
import type { ModelGenerateRequest } from "./model-types.js";
import { parseProviderModelUsage, parseSourcedAnswerDraftText } from "./json-chat-model-preset.js";
import type { ProviderParsedResponse } from "./provider-types.js";

export interface AnthropicMessagesModelPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
  readonly temperature?: number;
}

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicMessagesModelAdapter(
  options: AnthropicMessagesModelPresetOptions
): ProviderModelAdapter {
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;

  return new ProviderModelAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildHeaders: ({ apiKey, requestId }) =>
      buildAnthropicMessagesRequestHeaders({
        apiKey,
        requestId,
        anthropicVersion,
        ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
      }),
    buildRequestBody: (request) =>
      buildAnthropicMessagesModelRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseAnthropicMessagesModelResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildAnthropicMessagesRequestHeaders(input: {
  readonly apiKey: string;
  readonly requestId: string;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-api-key": input.apiKey,
    "x-request-id": input.requestId,
    "anthropic-version": input.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    ...(input.anthropicBeta === undefined ? {} : { "anthropic-beta": input.anthropicBeta })
  };
}

export function buildAnthropicMessagesModelRequestBody(
  request: ModelGenerateRequest,
  options: {
    readonly modelName: string;
    readonly temperature?: number;
  }
): Record<string, unknown> {
  const userPayload = {
    question: request.input.question,
    context: request.input.contextText,
    groundingRules: request.input.groundingRules,
    contract: request.input.contract
  };

  return {
    model: options.modelName,
    max_tokens: request.input.contract.maxOutputTokens,
    system:
      "Answer only from the supplied context. Return strict JSON with answer, citationChunkIds, evidenceSummary, confidence, actions, and optional refusal.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ],
    ...(options.temperature === undefined ? {} : { temperature: options.temperature })
  };
}

export function parseAnthropicMessagesModelResponse(
  response: ProviderHttpResponse
): ProviderParsedResponse {
  const text = extractAnthropicMessagesText(response.body);
  const parsed = parseSourcedAnswerDraftText(text);
  const usage = parseProviderModelUsage(response.body);
  const stopReasonWarning = readStopReasonWarning(response.body);
  const warnings = [
    ...parsed.warnings,
    ...(stopReasonWarning === undefined ? [] : [stopReasonWarning])
  ];

  return {
    draft: parsed.draft,
    warnings,
    ...(usage === undefined ? {} : { usage })
  };
}

function extractAnthropicMessagesText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Anthropic response body must be an object.");
  }

  const content = body["content"];
  if (!Array.isArray(content)) {
    throw new Error("Anthropic response must include content blocks.");
  }

  const text = content
    .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic response did not include text content.");
  }

  return text;
}

function readStopReasonWarning(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body["stop_reason"] !== "string") {
    return undefined;
  }

  return body["stop_reason"] === "end_turn"
    ? undefined
    : `anthropic_stop_reason:${body["stop_reason"]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
