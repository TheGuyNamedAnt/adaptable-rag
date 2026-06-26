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
  buildAnthropicMessagesRequestHeaders,
  createAnthropicMessagesModelAdapter,
  parseAnthropicMessagesModelResponse
} from "./anthropic-messages-model-preset.js";

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
      throw new Error("No mock Anthropic response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "anthropic-test",
    provider: "anthropic",
    modelName: "claude-test-model",
    endpoint: "https://api.anthropic.test/v1/messages",
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
    requestId: "anthropic_model_test",
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

test("Anthropic Messages preset sends x-api-key headers and parses content text", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            answer: "Refund requests require support review.",
            citationChunkIds: ["chunk_allowed"],
            evidenceSummary: "The context says refunds need review.",
            confidence: "high"
          })
        }
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5
      }
    })
  ]);
  const adapter = createAnthropicMessagesModelAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "anthropic-secret",
      secretId: "ANTHROPIC_API_KEY"
    },
    transport,
    now: () => FIXED_NOW,
    sleep: async () => {},
    anthropicVersion: "2023-06-01",
    anthropicBeta: "test-beta",
    temperature: 0.1
  });

  const result = await adapter.generate(modelRequest());

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.answer, "Refund requests require support review.");
  assert.deepEqual(result.draft?.citationChunkIds, ["chunk_allowed"]);
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15
  });

  const sent = transport.requests[0];
  assert.ok(sent);
  assert.equal(sent.headers["x-api-key"], "anthropic-secret");
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.equal(sent.headers["anthropic-beta"], "test-beta");
  assert.equal(sent.headers["authorization"], undefined);

  const body = asRecord(sent.body);
  assert.equal(body["model"], "claude-test-model");
  assert.equal(body["max_tokens"], 900);
  assert.equal(body["temperature"], 0.1);
  assert.equal(typeof body["system"], "string");

  const messages = body["messages"];
  assert.ok(Array.isArray(messages));
  assert.equal(asRecord(messages[0])["role"], "user");
});

test("Anthropic Messages parser warns when the provider stops for a non-final reason", () => {
  const parsed = parseAnthropicMessagesModelResponse(
    okResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            answer: "Refunds need review.",
            citationChunkIds: ["chunk_allowed"]
          })
        }
      ],
      stop_reason: "max_tokens"
    })
  );

  assert.equal(parsed.draft.answer, "Refunds need review.");
  assert.deepEqual(parsed.warnings, ["anthropic_stop_reason:max_tokens"]);
});

test("Anthropic Messages header builder uses the default version", () => {
  assert.deepEqual(
    buildAnthropicMessagesRequestHeaders({
      apiKey: "secret",
      requestId: "request_1"
    }),
    {
      "content-type": "application/json",
      "x-api-key": "secret",
      "x-request-id": "request_1",
      "anthropic-version": "2023-06-01"
    }
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
