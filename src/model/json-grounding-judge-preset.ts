import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  GroundingJudgeIssue,
  GroundingJudgeIssueCode,
  GroundingJudgeModelRequest,
  GroundingJudgeVerdict
} from "../answer/grounding-judge.js";
import {
  ProviderGroundingJudgeAdapter,
  type ProviderGroundingJudgeParsedResponse
} from "./provider-grounding-judge-adapter.js";

export interface JsonGroundingJudgePresetOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly temperature?: number;
}

export function createJsonGroundingJudgeAdapter(
  options: JsonGroundingJudgePresetOptions
): ProviderGroundingJudgeAdapter {
  return new ProviderGroundingJudgeAdapter({
    config: options.config,
    secrets: options.secrets,
    transport: options.transport,
    buildRequestBody: (request) =>
      buildJsonGroundingJudgeRequestBody(request, {
        modelName: options.config.modelName,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature })
      }),
    parseResponse: parseJsonGroundingJudgeResponse,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });
}

export function buildJsonGroundingJudgeRequestBody(
  request: GroundingJudgeModelRequest,
  options: { readonly modelName: string; readonly temperature?: number }
): Record<string, unknown> {
  const userPayload = {
    question: request.question,
    answer: request.answer,
    citationChunkIds: request.citationChunkIds,
    contextBlocks: request.contextBlocks,
    contract: {
      verdicts: ["grounded", "unsupported", "needs_review", "failed"],
      issueCodes: [
        "unsupported_claim",
        "missing_citation_support",
        "contradicted_by_context",
        "unsafe_context_instruction_followed"
      ],
      output:
        'Return strict JSON: {"verdict":"grounded|unsupported|needs_review|failed","issues":[{"code":"...","message":"...","chunkId":"optional"}]}'
    }
  };

  return {
    model: options.modelName,
    messages: [
      {
        role: "system",
        content:
          "Judge whether the answer is fully supported by the supplied context and citations. Do not use outside knowledge. Return only JSON."
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

export function parseJsonGroundingJudgeResponse(
  response: ProviderHttpResponse
): ProviderGroundingJudgeParsedResponse {
  const record = extractJsonRecord(response.body);
  const verdict = readVerdict(record["verdict"] ?? record["status"]);
  if (verdict === undefined) {
    throw new Error("Grounding judge provider response must include a known verdict.");
  }

  const issueWarnings: string[] = [];
  const issues = readIssues(record["issues"], issueWarnings);
  const usage = parseProviderUsage(response.body);
  const warnings = [...readStringArray(record["warnings"]), ...issueWarnings];

  return {
    verdict,
    issues,
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
  if (isRecord(body) && hasJudgePayload(body)) {
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

  throw new Error("Grounding judge provider response must include a JSON object.");
}

function readIssues(value: unknown, warnings: string[]): readonly GroundingJudgeIssue[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Grounding judge provider issues must be an array.");
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      throw new Error("Grounding judge provider issue item must be an object.");
    }

    const code = readIssueCode(item["code"]);
    if (code === undefined) {
      warnings.push("provider_issue_code_ignored");
      return [];
    }

    const message =
      typeof item["message"] === "string" && item["message"].trim()
        ? item["message"]
        : "Grounding judge reported an issue.";
    const chunkId = typeof item["chunkId"] === "string" ? item["chunkId"] : undefined;

    return [
      {
        code,
        message,
        ...(chunkId === undefined ? {} : { chunkId })
      }
    ];
  });
}

function readVerdict(value: unknown): GroundingJudgeVerdict | undefined {
  return value === "grounded" ||
    value === "unsupported" ||
    value === "needs_review" ||
    value === "failed"
    ? value
    : undefined;
}

function readIssueCode(value: unknown): GroundingJudgeIssueCode | undefined {
  return value === "unsupported_claim" ||
    value === "missing_citation_support" ||
    value === "contradicted_by_context" ||
    value === "unsafe_context_instruction_followed" ||
    value === "judge_failed"
    ? value
    : undefined;
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

  throw new Error("Provider response did not include grounding judge text.");
}

function hasJudgePayload(value: Record<string, unknown>): boolean {
  return typeof value["verdict"] === "string" || typeof value["status"] === "string";
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
