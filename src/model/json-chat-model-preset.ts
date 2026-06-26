import type {
  SourcedAnswerDraft,
  AnswerConfidence,
  AnswerRefusalCode
} from "../answer/answer-types.js";
import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { ProviderModelAdapter } from "./provider-model-adapter.js";
import type { ModelGenerateRequest, ModelTokenUsage } from "./model-types.js";
import type { ProviderParsedResponse } from "./provider-types.js";

export interface JsonChatModelPresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
}

export interface ParsedSourcedAnswerDraft {
  readonly draft: SourcedAnswerDraft;
  readonly warnings: readonly string[];
}

export function createJsonChatModelAdapter(
  options: JsonChatModelPresetOptions
): ProviderModelAdapter {
  return new ProviderModelAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildRequestBody: (request) =>
      buildJsonChatModelRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseJsonChatModelResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildJsonChatModelRequestBody(
  request: ModelGenerateRequest,
  options: { readonly modelName: string; readonly temperature?: number }
): Record<string, unknown> {
  const userPayload = {
    question: request.input.question,
    context: request.input.contextText,
    groundingRules: request.input.groundingRules,
    contract: request.input.contract
  };

  const body: Record<string, unknown> = {
    model: options.modelName,
    messages: [
      {
        role: "system",
        content:
          "Answer only from the supplied context. Return strict JSON with answer, citationChunkIds, evidenceSummary, confidence, actions, and optional refusal."
      },
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ],
    response_format: { type: "json_object" },
    temperature: options.temperature ?? 0
  };

  if (Number.isFinite(request.input.contract.maxOutputTokens)) {
    body["max_tokens"] = request.input.contract.maxOutputTokens;
  }

  return body;
}

export function parseJsonChatModelResponse(response: ProviderHttpResponse): ProviderParsedResponse {
  const text = extractText(response.body);
  const parsed = parseSourcedAnswerDraftText(text);
  const usage = parseProviderModelUsage(response.body);

  return {
    draft: parsed.draft,
    warnings: parsed.warnings,
    ...(usage === undefined ? {} : { usage })
  };
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

  throw new Error("Provider response did not include answer text.");
}

export function parseSourcedAnswerDraftText(text: string): ParsedSourcedAnswerDraft {
  const trimmed = text.trim();
  const record = parseJsonObject(trimmed);
  if (record === undefined) {
    return {
      draft: {
        answer: trimmed,
        citationChunkIds: []
      },
      warnings: ["provider_response_not_json"]
    };
  }

  const answer = typeof record["answer"] === "string" ? record["answer"] : "";
  const citationChunkIds = readStringArray(record["citationChunkIds"] ?? record["citations"]);
  const evidenceSummary =
    typeof record["evidenceSummary"] === "string" ? record["evidenceSummary"] : undefined;
  const confidence = readConfidence(record["confidence"]);
  const actions = readStringArray(record["actions"]);
  const refusal = readRefusal(record["refusal"]);

  if (answer.length === 0 && refusal === undefined) {
    throw new Error("Provider JSON must include answer or refusal.");
  }

  return {
    draft: {
      answer,
      citationChunkIds,
      ...(evidenceSummary === undefined ? {} : { evidenceSummary }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(actions.length === 0 ? {} : { actions }),
      ...(refusal === undefined ? {} : { refusal })
    },
    warnings:
      confidence === undefined && record["confidence"] !== undefined
        ? ["provider_confidence_ignored"]
        : []
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseProviderModelUsage(body: unknown): ModelTokenUsage | undefined {
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

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readConfidence(value: unknown): AnswerConfidence | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function readRefusal(value: unknown): SourcedAnswerDraft["refusal"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = readRefusalCode(value["code"] ?? value["reason"]);
  if (code === undefined) {
    return undefined;
  }

  const message =
    typeof value["message"] === "string" ? value["message"] : "The answer is refused by policy.";
  const detail =
    typeof value["detail"] === "string"
      ? value["detail"]
      : typeof value["safeAlternative"] === "string"
        ? value["safeAlternative"]
        : message;

  return {
    code,
    message,
    detail
  };
}

function readRefusalCode(value: unknown): AnswerRefusalCode | undefined {
  return value === "no_evidence" ||
    value === "insufficient_citations" ||
    value === "insufficient_trusted_citations" ||
    value === "generation_requires_evidence"
    ? value
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
