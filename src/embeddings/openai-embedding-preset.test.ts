import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { createOpenAICompatibleEmbeddingAdapter } from "./openai-embedding-preset.js";

class MockProviderTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    return {
      status: 200,
      headers: {},
      latencyMs: 20,
      body: {
        data: [
          {
            index: 0,
            embedding: [1, 0, 0]
          }
        ]
      }
    };
  }
}

test("OpenAI-compatible embedding preset sends dimensions and parses indexed vectors", async () => {
  const transport = new MockProviderTransport();
  const adapter = createOpenAICompatibleEmbeddingAdapter({
    config: {
      id: "openai-compatible-embedding-test",
      provider: "openai-compatible",
      modelName: "embedding-model",
      endpoint: "https://provider.example.test/v1/embeddings",
      timeoutMs: 5000,
      retryPolicy: {
        maxRetries: 0,
        backoffMs: 0,
        retryStatusCodes: [408, 429, 500, 502, 503, 504]
      }
    },
    dimensions: 3,
    secrets: {
      apiKeyProvider: () => "embedding-secret"
    },
    transport,
    user: "user_1"
  });

  const result = await adapter.embed({
    inputs: [{ id: "chunk_1", text: "refund policy" }]
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.embeddings[0]?.vector, [1, 0, 0]);

  const body = asRecord(transport.requests[0]?.body);
  assert.equal(body["model"], "embedding-model");
  assert.deepEqual(body["input"], ["refund policy"]);
  assert.equal(body["encoding_format"], "float");
  assert.equal(body["dimensions"], 3);
  assert.equal(body["user"], "user_1");
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
