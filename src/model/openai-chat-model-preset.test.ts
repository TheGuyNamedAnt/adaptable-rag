import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import { createOpenAICompatibleChatModelAdapter } from "./openai-chat-model-preset.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: {},
      latencyMs: 20,
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "Refund requests require support review.",
                citationChunkIds: ["chunk_allowed"]
              })
            }
          }
        ]
      }
    };
  }
}

test("OpenAI-compatible chat preset uses the generic JSON chat boundary", async () => {
  const transport = new MockProviderTransport();
  const adapter = createOpenAICompatibleChatModelAdapter({
    config: {
      id: "openai-compatible-test",
      provider: "openai-compatible",
      modelName: "chat-model",
      endpoint: "https://provider.example.test/v1/chat/completions",
      timeoutMs: 5000,
      retryPolicy: {
        maxRetries: 0,
        backoffMs: 0,
        retryStatusCodes: [408, 429, 500, 502, 503, 504]
      }
    },
    secrets: {
      apiKeyProvider: () => "openai-compatible-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.generate({
    requestId: "openai_chat_test",
    profileId: "generic-docs",
    namespaceId: "test-namespace",
    modelTier: "strong",
    requestedAt: FIXED_NOW,
    input: {
      question: "What is the refund policy?",
      contextText: "[SOURCE 1]\nRefunds require review.\n[/SOURCE 1]",
      groundingRules: ["Use only approved context."],
      contract: {
        schemaName: "GenericSourcedAnswer",
        outputMode: "sourced_answer",
        requireStructuredOutput: true,
        requireCitations: true,
        requireEvidenceSummary: false,
        allowedCitationChunkIds: ["chunk_allowed"],
        minimumCitations: 1,
        minimumTrustedCitations: 1,
        maxOutputTokens: 300,
        actionMode: "answer_only",
        allowedActions: [],
        requireApprovalFor: []
      }
    }
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.draft?.answer, "Refund requests require support review.");
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer openai-compatible-secret");
  assert.equal(asRecord(transport.requests[0]?.body)["model"], "chat-model");
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
