import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type { GroundingJudgeModelRequest } from "../answer/grounding-judge.js";
import {
  buildJsonGroundingJudgeRequestBody,
  parseJsonGroundingJudgeResponse
} from "./json-grounding-judge-preset.js";
import {
  ProviderGroundingJudgeAdapter,
  type ProviderGroundingJudgeParsedResponse
} from "./provider-grounding-judge-adapter.js";

export interface AnthropicGroundingJudgePresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
  readonly temperature?: number;
}

export const DEFAULT_ANTHROPIC_GROUNDING_JUDGE_VERSION = "2023-06-01";

export function createAnthropicGroundingJudgeAdapter(
  options: AnthropicGroundingJudgePresetOptions
): ProviderGroundingJudgeAdapter {
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_GROUNDING_JUDGE_VERSION;

  return new ProviderGroundingJudgeAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildHeaders: ({ apiKey, requestId }) =>
      buildAnthropicGroundingJudgeRequestHeaders({
        apiKey,
        requestId,
        anthropicVersion,
        ...(options.anthropicBeta === undefined ? {} : { anthropicBeta: options.anthropicBeta })
      }),
    buildRequestBody: (request) =>
      buildAnthropicGroundingJudgeRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseAnthropicGroundingJudgeResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildAnthropicGroundingJudgeRequestHeaders(input: {
  readonly apiKey: string;
  readonly requestId: string;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
}): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-api-key": input.apiKey,
    "x-request-id": input.requestId,
    "anthropic-version": input.anthropicVersion ?? DEFAULT_ANTHROPIC_GROUNDING_JUDGE_VERSION,
    ...(input.anthropicBeta === undefined ? {} : { "anthropic-beta": input.anthropicBeta })
  };
}

export function buildAnthropicGroundingJudgeRequestBody(
  request: GroundingJudgeModelRequest,
  options: {
    readonly modelName: string;
    readonly temperature?: number;
  }
): Record<string, unknown> {
  const jsonBody = buildJsonGroundingJudgeRequestBody(request, options);
  const messages = Array.isArray(jsonBody["messages"]) ? jsonBody["messages"] : [];
  const userMessage = messages.find(
    (message): message is { readonly role: string; readonly content: string } =>
      isRecord(message) && message["role"] === "user" && typeof message["content"] === "string"
  );

  return {
    model: options.modelName,
    max_tokens: 512,
    system:
      "Judge whether the answer is supported by the supplied context and citations. Return strict JSON with verdict and issues.",
    messages: [
      {
        role: "user",
        content: userMessage?.content ?? JSON.stringify(jsonBody)
      }
    ],
    ...(options.temperature === undefined ? {} : { temperature: options.temperature })
  };
}

export function parseAnthropicGroundingJudgeResponse(
  response: ProviderHttpResponse
): ProviderGroundingJudgeParsedResponse {
  return parseJsonGroundingJudgeResponse({
    ...response,
    body: {
      output_text: extractAnthropicText(response.body),
      ...(isRecord(response.body) && response.body["usage"]
        ? { usage: response.body["usage"] }
        : {})
    }
  });
}

function extractAnthropicText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Anthropic grounding judge response body must be an object.");
  }

  const content = body["content"];
  if (!Array.isArray(content)) {
    throw new Error("Anthropic grounding judge response must include content blocks.");
  }

  const text = content
    .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic grounding judge response did not include text content.");
  }

  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
