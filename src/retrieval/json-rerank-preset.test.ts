import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import {
  createAnthropicRerankAdapter,
  parseAnthropicRerankResponse
} from "./anthropic-rerank-preset.js";
import { createJsonRerankAdapter, parseJsonRerankResponse } from "./json-rerank-preset.js";
import type { RerankModelRequest } from "./model-reranker.js";
import { createOpenAICompatibleRerankAdapter } from "./openai-rerank-preset.js";

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
      throw new Error("No mock rerank provider response configured.");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

const request: RerankModelRequest = {
  requestId: "rerank_provider_test",
  profileId: "profile_test",
  namespaceId: "test-namespace",
  modelTier: "strong",
  query: "refund policy",
  candidates: [
    {
      chunkId: "chunk_refund",
      documentId: "doc_refund",
      title: "Refund Policy",
      sourceId: "docs",
      sourceKind: "local_file",
      trustTier: "trusted_internal",
      retrievalScore: 0.4,
      retrievalRank: 2,
      text: "Refund requests require support review."
    },
    {
      chunkId: "chunk_login",
      documentId: "doc_login",
      title: "Login Policy",
      sourceId: "docs",
      sourceKind: "local_file",
      trustTier: "trusted_internal",
      retrievalScore: 0.7,
      retrievalRank: 1,
      text: "Login password reset steps."
    }
  ],
  requestedAt: FIXED_NOW
};

test("json rerank adapter sends provider request and parses chat JSON scores", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              scores: [{ chunkId: "chunk_refund", score: 0.91, reason: "direct policy match" }]
            })
          }
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110
      }
    })
  ]);
  const adapter = createJsonRerankAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "rerank-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.scores, [
    { chunkId: "chunk_refund", score: 0.91, reason: "direct policy match" }
  ]);
  assert.equal(result.provider, "json-rerank");
  assert.equal(result.cost.amountUsd, 0.00022);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer rerank-secret");
  assert.equal(transport.requests[0]?.body && typeof transport.requests[0].body, "object");
});

test("json rerank parser supports index-based direct provider results", () => {
  const parsed = parseJsonRerankResponse(
    okResponse({
      results: [{ index: 1, relevance_score: 0.73 }]
    }),
    request
  );

  assert.deepEqual(parsed.scores, [{ chunkId: "chunk_login", score: 0.73 }]);
});

test("json rerank parser supports output content text responses", () => {
  const parsed = parseJsonRerankResponse(
    okResponse({
      output: [
        {
          content: [
            {
              text: JSON.stringify({
                scores: [{ chunkId: "chunk_refund", score: 0.74 }]
              })
            }
          ]
        }
      ]
    }),
    request
  );

  assert.deepEqual(parsed.scores, [{ chunkId: "chunk_refund", score: 0.74 }]);
});

test("json rerank adapter returns zero estimated cost when pricing is absent", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      scores: [{ chunkId: "chunk_refund", score: 0.8 }]
    })
  ]);
  const { pricing: _pricing, ...configWithoutPricing } = providerConfig();
  const adapter = createJsonRerankAdapter({
    config: configWithoutPricing,
    secrets: {
      apiKeyProvider: () => "rerank-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "succeeded");
  assert.equal(result.cost.amountUsd, 0);
});

test("openai-compatible rerank adapter uses the generic JSON response shape", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      output_text: JSON.stringify({
        scores: [{ chunkId: "chunk_refund", score: 0.82 }]
      })
    })
  ]);
  const adapter = createOpenAICompatibleRerankAdapter({
    config: providerConfig({ provider: "openai-compatible" }),
    secrets: {
      apiKeyProvider: () => "openai-secret"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.scores, [{ chunkId: "chunk_refund", score: 0.82 }]);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer openai-secret");
});

test("provider rerank returns auth failure without sending when API key is missing", async () => {
  const transport = new MockProviderTransport([]);
  const adapter = createJsonRerankAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "   "
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "Provider API key is missing.");
  assert.equal(transport.requests.length, 0);
});

test("provider rerank retries retryable transport failures before success", async () => {
  const sleeps: number[] = [];
  const transport = new MockProviderTransport([
    new Error("request timeout"),
    okResponse({
      scores: [{ chunkId: "chunk_refund", score: 0.77 }]
    })
  ]);
  const adapter = createJsonRerankAdapter({
    config: providerConfig({
      retryPolicy: {
        maxRetries: 1,
        backoffMs: 25,
        retryStatusCodes: [408, 429, 500]
      }
    }),
    secrets: {
      apiKeyProvider: () => "rerank-secret"
    },
    transport,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.scores, [{ chunkId: "chunk_refund", score: 0.77 }]);
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(sleeps, [25]);
});

test("json rerank parser rejects malformed score payloads", () => {
  assert.throws(
    () =>
      parseJsonRerankResponse(
        okResponse({
          scores: [{ chunkId: "chunk_refund" }]
        }),
        request
      ),
    /numeric score/
  );
  assert.throws(
    () =>
      parseJsonRerankResponse(
        okResponse({
          choices: [
            {
              message: {
                content: "not json"
              }
            }
          ]
        }),
        request
      ),
    /JSON object/
  );
});

test("provider rerank failures redact API secrets", async () => {
  const transport = new MockProviderTransport([
    {
      status: 500,
      headers: {},
      body: {
        error: {
          message: "rerank-secret failed upstream"
        }
      },
      latencyMs: 9
    }
  ]);
  const adapter = createJsonRerankAdapter({
    config: providerConfig(),
    secrets: {
      apiKeyProvider: () => "rerank-secret",
      secretId: "RAG_RERANK_API_KEY"
    },
    transport,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage?.includes("rerank-secret"), false);
  assert.equal(result.errorMessage?.includes("[REDACTED]"), true);
  assert.deepEqual(result.warnings, [
    "provider_error_code:provider_error",
    "provider_attempts:1",
    "provider_endpoint_host:provider.example.test"
  ]);
});

test("anthropic rerank adapter uses Anthropic headers and parses content blocks", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scores: [{ chunkId: "chunk_refund", score: 0.88 }]
          })
        }
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 5
      }
    })
  ]);
  const adapter = createAnthropicRerankAdapter({
    config: providerConfig({
      provider: "anthropic",
      endpoint: "https://api.anthropic.test/v1/messages"
    }),
    secrets: {
      apiKeyProvider: () => "anthropic-secret"
    },
    transport,
    anthropicBeta: "rerank-beta",
    temperature: 0.2,
    now: () => FIXED_NOW
  });

  const result = await adapter.rerank(request);
  const body = transport.requests[0]?.body as Record<string, unknown> | undefined;

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.scores, [{ chunkId: "chunk_refund", score: 0.88 }]);
  assert.equal(transport.requests[0]?.headers["x-api-key"], "anthropic-secret");
  assert.equal(transport.requests[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(transport.requests[0]?.headers["anthropic-beta"], "rerank-beta");
  assert.equal(transport.requests[0]?.headers["authorization"], undefined);
  assert.equal(body?.["temperature"], 0.2);
});

test("anthropic rerank parser rejects malformed content blocks", () => {
  assert.throws(
    () => parseAnthropicRerankResponse(okResponse("bad"), request),
    /must be an object/
  );
  assert.throws(() => parseAnthropicRerankResponse(okResponse({}), request), /content blocks/);
  assert.throws(
    () =>
      parseAnthropicRerankResponse(
        okResponse({
          content: [{ type: "text", text: "   " }]
        }),
        request
      ),
    /did not include text/
  );
});

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "rerank-provider",
    provider: "json-rerank",
    modelName: "rerank-model",
    endpoint: "https://provider.example.test/v1/rerank",
    timeoutMs: 30000,
    retryPolicy: {
      maxRetries: 0,
      backoffMs: 0,
      retryStatusCodes: [429, 500]
    },
    pricing: {
      promptUsdPer1kTokens: 0.002,
      completionUsdPer1kTokens: 0.002
    },
    ...overrides
  };
}

function okResponse(body: unknown): ProviderHttpResponse {
  return {
    status: 200,
    headers: {},
    body,
    latencyMs: 12
  };
}
