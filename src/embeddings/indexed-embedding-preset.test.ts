import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { hashText } from "../shared/hash.js";
import {
  buildIndexedEmbeddingRequestBody,
  createIndexedEmbeddingAdapter
} from "./indexed-embedding-preset.js";

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
      throw new Error("No mock embedding response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "indexed-embedding-test",
    provider: "test-indexed-embedding",
    modelName: "indexed-embedding-model",
    endpoint: "https://provider.example.test/v1/embeddings",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    },
    ...overrides
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 20
  };
}

test("indexed embedding preset builds provider input arrays", () => {
  const body = buildIndexedEmbeddingRequestBody(
    {
      inputs: [
        { id: "chunk_1", text: "refund policy" },
        { id: "chunk_2", text: "billing support" }
      ]
    },
    "indexed-embedding-model"
  );

  assert.deepEqual(body, {
    model: "indexed-embedding-model",
    input: ["refund policy", "billing support"],
    encoding_format: "float"
  });
});

test("indexed embedding preset maps returned vector indices back to input ids", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] }
      ]
    })
  ]);
  const adapter = createIndexedEmbeddingAdapter({
    config: providerConfig(),
    dimensions: 3,
    secrets: {
      apiKeyProvider: () => "embedding-secret",
      secretId: "EMBEDDING_KEY"
    },
    transport,
    now: () => "2026-06-23T00:00:00.000Z",
    sleep: async () => {}
  });

  const result = await adapter.embed({
    inputs: [
      { id: "chunk_1", text: "refund policy" },
      { id: "chunk_2", text: "billing support" }
    ]
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 2);
  assert.deepEqual(
    result.embeddings.find((embedding) => embedding.id === "chunk_1")?.vector,
    [1, 0, 0]
  );
  assert.deepEqual(
    result.embeddings.find((embedding) => embedding.id === "chunk_2")?.vector,
    [0, 1, 0]
  );
  assert.equal(
    result.embeddings.find((embedding) => embedding.id === "chunk_1")?.textHash,
    hashText("refund policy")
  );
  assert.deepEqual(result.usage, {
    inputCount: 2,
    totalInputCharacters: "refund policy".length + "billing support".length
  });
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer embedding-secret");
});
