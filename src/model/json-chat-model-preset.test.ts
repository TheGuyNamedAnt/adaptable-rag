import assert from "node:assert/strict";
import test from "node:test";

import type { AnswerGenerationInput } from "../answer/answer-types.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import type { ModelGenerateRequest } from "./model-types.js";
import {
  createJsonChatModelAdapter,
  parseJsonChatModelResponse
} from "./json-chat-model-preset.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly results: Array<ProviderHttpResponse | Error>;

  constructor(results: Array<ProviderHttpResponse | Error>) {
    this.results = [...results];
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const next = this.results.shift();

    if (!next) {
      throw new Error("No mock JSON chat response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "json-chat-test",
    provider: "test-json-chat",
    modelName: "json-chat-model",
    endpoint: "https://provider.example.test/v1/chat",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    },
    pricing: {
      promptUsdPer1kTokens: 0.01,
      completionUsdPer1kTokens: 0.03
    },
    ...overrides
  };
}

function generationInput(chunkId = "chunk_allowed"): AnswerGenerationInput {
  return {
    question: "What is the refund policy?",
    contextText: "[SOURCE 1]\nRefund policy requires support review.\n[/SOURCE 1]",
    groundingRules: ["Use only approved context."],
    contract: {
      schemaName: "GenericSourcedAnswer",
      outputMode: "sourced_answer",
      requireStructuredOutput: true,
      requireCitations: true,
      requireEvidenceSummary: true,
      allowedCitationChunkIds: [chunkId],
      minimumCitations: 1,
      minimumTrustedCitations: 1,
      maxOutputTokens: 900,
      actionMode: "answer_only",
      allowedActions: [],
      requireApprovalFor: []
    }
  };
}

function modelRequest(input = generationInput()): ModelGenerateRequest {
  return {
    requestId: "json_chat_model_test",
    profileId: "generic-docs",
    namespaceId: "test-namespace",
    modelTier: "strong",
    input,
    requestedAt: FIXED_NOW
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 25
  };
}

test("JSON chat preset builds grounded request bodies and parses structured answers", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "Refund requests require support review.",
              citationChunkIds: ["chunk_allowed"],
              evidenceSummary: "The supplied context says refunds need review.",
              confidence: "high"
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    })
  ]);
  const adapter = createJsonChatModelAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "json-chat-secret",
      secretId: "JSON_CHAT_KEY"
    },
    transport,
    now: () => FIXED_NOW,
    sleep: async () => {},
    temperature: 0.2
  });

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.answer, "Refund requests require support review.");
  assert.deepEqual(result.draft?.citationChunkIds, ["chunk_allowed"]);
  assert.equal(result.draft?.confidence, "high");
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15
  });

  const sent = transport.requests[0];
  assert.ok(sent);
  assert.equal(sent.headers["authorization"], "Bearer json-chat-secret");
  assert.equal(sent.timeoutMs, 5000);

  const body = asRecord(sent.body);
  assert.equal(body["model"], "json-chat-model");
  assert.deepEqual(body["response_format"], { type: "json_object" });
  assert.equal(body["temperature"], 0.2);
  assert.equal(body["max_tokens"], 900);

  const messages = body["messages"];
  assert.ok(Array.isArray(messages));
  assert.equal(asRecord(messages[0])["role"], "system");
  assert.equal(asRecord(messages[1])["role"], "user");

  const payload = JSON.parse(String(asRecord(messages[1])["content"])) as {
    readonly question: string;
    readonly contract: { readonly schemaName: string };
  };
  assert.equal(payload.question, "What is the refund policy?");
  assert.equal(payload.contract.schemaName, "GenericSourcedAnswer");
});

test("JSON chat parser accepts response-style output_text refusals", () => {
  const parsed = parseJsonChatModelResponse(
    okResponse({
      output_text: JSON.stringify({
        refusal: {
          code: "no_evidence",
          message: "Not enough evidence.",
          detail: "Ask for a supported source."
        },
        citationChunkIds: []
      })
    })
  );

  assert.equal(parsed.draft.answer, "");
  assert.equal(parsed.draft.refusal?.code, "no_evidence");
  assert.equal(parsed.draft.refusal?.message, "Not enough evidence.");
  assert.equal(parsed.draft.refusal?.detail, "Ask for a supported source.");
  assert.deepEqual(parsed.draft.citationChunkIds, []);
});

test("JSON chat parser marks non-JSON text as an unsafe provider shape", () => {
  const parsed = parseJsonChatModelResponse(
    okResponse({
      choices: [
        {
          message: {
            content: "Refunds need support review."
          }
        }
      ]
    })
  );

  assert.equal(parsed.draft.answer, "Refunds need support review.");
  assert.deepEqual(parsed.draft.citationChunkIds, []);
  assert.deepEqual(parsed.warnings, ["provider_response_not_json"]);
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
