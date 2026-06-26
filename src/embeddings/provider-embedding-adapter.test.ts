import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../shared/hash.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type { EmbeddingRequest, EmbeddingUsage } from "./embedding-types.js";
import {
  ProviderEmbeddingAdapter,
  type ProviderEmbeddingParsedResponse
} from "./provider-embedding-adapter.js";

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
      throw new Error("No mock embedding provider response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "embedding-provider-test",
    provider: "test-embedding-provider",
    modelName: "test-embedding-model",
    endpoint: "https://provider.example.test/v1/embeddings",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 0,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    },
    ...overrides
  };
}

function buildRequestBody(request: EmbeddingRequest): unknown {
  return {
    input: request.inputs.map((input) => ({
      id: input.id,
      text: input.text
    }))
  };
}

function parseResponse(response: ProviderHttpResponse): ProviderEmbeddingParsedResponse {
  if (!isRecord(response.body) || !Array.isArray(response.body["embeddings"])) {
    throw new Error("Provider response did not contain embeddings.");
  }

  const embeddings = response.body["embeddings"].map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !Array.isArray(entry["vector"])) {
      throw new Error("Provider embedding entry was malformed.");
    }

    return {
      id: entry["id"],
      vector: entry["vector"].map(Number)
    };
  });
  const usage = isRecord(response.body["usage"])
    ? {
        inputCount: Number(response.body["usage"]["inputCount"] ?? 0),
        totalInputCharacters: Number(response.body["usage"]["totalInputCharacters"] ?? 0)
      }
    : undefined;
  const warnings = Array.isArray(response.body["warnings"])
    ? response.body["warnings"].filter((warning): warning is string => typeof warning === "string")
    : undefined;

  return {
    embeddings,
    ...(usage ? { usage } : {}),
    ...(warnings ? { warnings } : {})
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

function errorResponse(status: number, message: string): ProviderHttpResponse {
  return {
    status,
    headers: {},
    body: {
      error: {
        message
      }
    },
    latencyMs: 10
  };
}

function providerAdapter(
  transport: ProviderTransport,
  apiKey = "embedding-secret-value",
  dimensions = 3
): ProviderEmbeddingAdapter {
  return new ProviderEmbeddingAdapter({
    config: providerConfig(),
    dimensions,
    secrets: {
      apiKeyProvider: () => apiKey,
      secretId: "EMBEDDING_PROVIDER_KEY"
    },
    transport,
    buildRequestBody,
    parseResponse,
    now: () => "2026-06-23T00:00:00.000Z",
    sleep: async () => {}
  });
}

test("validates provider embedding config before runtime", () => {
  assert.throws(
    () =>
      new ProviderEmbeddingAdapter({
        config: providerConfig({ endpoint: "http://provider.example.test/v1" }),
        dimensions: 3,
        secrets: { apiKeyProvider: () => "secret" },
        transport: new MockProviderTransport([]),
        buildRequestBody,
        parseResponse
      }),
    /https/
  );
  assert.throws(
    () =>
      new ProviderEmbeddingAdapter({
        config: providerConfig(),
        dimensions: 0,
        secrets: { apiKeyProvider: () => "secret" },
        transport: new MockProviderTransport([]),
        buildRequestBody,
        parseResponse
      }),
    /positive integer/
  );
});

test("sends embedding requests through the auth and timeout boundary", async () => {
  const usage: EmbeddingUsage = {
    inputCount: 1,
    totalInputCharacters: 12
  };
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "input_1", vector: [1, 0, 0] }],
      usage,
      warnings: ["provider_used_test_fixture"]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embed({
    inputs: [{ id: "input_1", text: "refund policy" }],
    requestedAt: "2026-06-23T00:00:00.000Z"
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.embeddings[0]?.textHash, hashText("refund policy"));
  assert.deepEqual(result.embeddings[0]?.vector, [1, 0, 0]);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer embedding-secret-value");
  assert.equal(transport.requests[0]?.timeoutMs, 5000);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.warnings, ["provider_used_test_fixture"]);
});

test("retries retryable embedding provider responses", async () => {
  const transport = new MockProviderTransport([
    errorResponse(429, "rate limited"),
    okResponse({
      embeddings: [{ id: "input_1", vector: [0, 1, 0] }]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embed({
    inputs: [{ id: "input_1", text: "billing policy" }]
  });

  assert.equal(result.status, "succeeded");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(result.embeddings[0]?.vector, [0, 1, 0]);
});

test("returns auth failure before transport when embedding api key is missing", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "input_1", vector: [1, 0, 0] }]
    })
  ]);
  const adapter = providerAdapter(transport, " ");

  const result = await adapter.embed({
    inputs: [{ id: "input_1", text: "refund policy" }]
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "Provider API key is missing.");
  assert.equal(transport.requests.length, 0);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("does not retry auth errors and redacts embedding provider secrets", async () => {
  const transport = new MockProviderTransport([
    errorResponse(401, "bad api key embedding-secret-value bearer embedding-secret-value")
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embed({
    inputs: [{ id: "input_1", text: "refund policy" }]
  });

  assert.equal(result.status, "failed");
  assert.equal(transport.requests.length, 1);
  assert.equal(result.errorMessage?.includes("embedding-secret-value"), false);
  assert.equal(result.errorMessage?.includes("[REDACTED]"), true);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("maps invalid embedding provider responses into failed results", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "input_1", vector: [1, 0] }]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embed({
    inputs: [{ id: "input_1", text: "refund policy" }]
  });

  assert.equal(result.status, "failed");
  assert.match(result.errorMessage ?? "", /dimensions/);
  assert.equal(result.warnings.includes("provider_error_code:invalid_response"), true);
});

test("reports missing embeddings without fabricating vectors", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "input_1", vector: [1, 0, 0] }]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embed({
    inputs: [
      { id: "input_1", text: "refund policy" },
      { id: "input_2", text: "login policy" }
    ]
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.warnings.includes("provider_missing_embedding_count:1"), true);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
