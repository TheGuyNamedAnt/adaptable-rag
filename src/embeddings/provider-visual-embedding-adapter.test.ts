import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../shared/hash.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  VisualEmbeddingRequest,
  VisualEmbeddingUsage,
  VisualQueryEmbeddingRequest
} from "./visual-embedding-types.js";
import {
  ProviderVisualEmbeddingAdapter,
  type ProviderVisualEmbeddingParsedResponse,
  type ProviderVisualQueryEmbeddingParsedResponse
} from "./provider-visual-embedding-adapter.js";

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
      throw new Error("No mock visual embedding provider response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "visual-embedding-provider-test",
    provider: "test-visual-embedding-provider",
    modelName: "test-visual-embedding-model",
    endpoint: "https://provider.example.test/v1/visual-embeddings",
    timeoutMs: 5000,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 0,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    },
    ...overrides
  };
}

function buildVisualAssetsRequestBody(request: VisualEmbeddingRequest): unknown {
  return {
    input: request.inputs.map((input) => ({
      id: input.id,
      text: input.text,
      uri: input.uri
    }))
  };
}

function buildQueryRequestBody(request: VisualQueryEmbeddingRequest): unknown {
  return {
    input: request.query
  };
}

function parseVisualAssetsResponse(
  response: ProviderHttpResponse
): ProviderVisualEmbeddingParsedResponse {
  if (!isRecord(response.body) || !Array.isArray(response.body["embeddings"])) {
    throw new Error("Provider response did not contain visual embeddings.");
  }

  const embeddings = response.body["embeddings"].map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !Array.isArray(entry["vectors"])) {
      throw new Error("Provider visual embedding entry was malformed.");
    }

    return {
      id: entry["id"],
      vectors: entry["vectors"] as readonly (readonly number[])[],
      ...(typeof entry["textHash"] === "string" ? { textHash: entry["textHash"] } : {}),
      ...(typeof entry["visualAssetId"] === "string"
        ? { visualAssetId: entry["visualAssetId"] }
        : {})
    };
  });
  const usage = isRecord(response.body["usage"])
    ? {
        inputCount: Number(response.body["usage"]["inputCount"] ?? 0),
        totalInputCharacters: Number(response.body["usage"]["totalInputCharacters"] ?? 0),
        vectorCount: Number(response.body["usage"]["vectorCount"] ?? 0)
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

function parseQueryResponse(
  response: ProviderHttpResponse
): ProviderVisualQueryEmbeddingParsedResponse {
  if (!isRecord(response.body) || !Array.isArray(response.body["vectors"])) {
    throw new Error("Provider response did not contain query vectors.");
  }

  return {
    vectors: response.body["vectors"] as readonly (readonly number[])[],
    warnings: ["query_provider_fixture"]
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
  apiKey = "visual-secret-value",
  dimensions = 3
): ProviderVisualEmbeddingAdapter {
  return new ProviderVisualEmbeddingAdapter({
    config: providerConfig(),
    dimensions,
    secrets: {
      apiKeyProvider: () => apiKey,
      secretId: "VISUAL_EMBEDDING_PROVIDER_KEY"
    },
    transport,
    buildVisualAssetsRequestBody,
    buildQueryRequestBody,
    parseVisualAssetsResponse,
    parseQueryResponse,
    now: () => "2026-06-23T00:00:00.000Z",
    sleep: async () => {}
  });
}

test("validates visual provider config before runtime", () => {
  assert.throws(
    () =>
      new ProviderVisualEmbeddingAdapter({
        config: providerConfig({ endpoint: "http://provider.example.test/v1" }),
        dimensions: 3,
        secrets: { apiKeyProvider: () => "secret" },
        transport: new MockProviderTransport([]),
        buildVisualAssetsRequestBody,
        buildQueryRequestBody,
        parseVisualAssetsResponse,
        parseQueryResponse
      }),
    /https/
  );
  assert.throws(
    () =>
      new ProviderVisualEmbeddingAdapter({
        config: providerConfig(),
        dimensions: 0,
        secrets: { apiKeyProvider: () => "secret" },
        transport: new MockProviderTransport([]),
        buildVisualAssetsRequestBody,
        buildQueryRequestBody,
        parseVisualAssetsResponse,
        parseQueryResponse
      }),
    /positive integer/
  );
});

test("sends visual asset requests through the auth and timeout boundary", async () => {
  const usage: VisualEmbeddingUsage = {
    inputCount: 1,
    totalInputCharacters: 12,
    vectorCount: 2
  };
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [
        {
          id: "visual_input_1",
          vectors: [
            [1, 0, 0],
            [0, 1, 0]
          ],
          textHash: "provider-supplied-hash"
        }
      ],
      usage,
      warnings: ["provider_used_visual_fixture"]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embedVisualAssets({
    inputs: [
      {
        id: "visual_input_1",
        chunkId: "chunk_1",
        documentId: "doc_1",
        mediaType: "image/png",
        visualAssetId: "asset_1",
        uri: "s3://bucket/doc_1.png",
        text: "refund flow diagram"
      }
    ],
    requestedAt: "2026-06-23T00:00:00.000Z"
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 1);
  assert.deepEqual(result.embeddings[0]?.vectors, [
    [1, 0, 0],
    [0, 1, 0]
  ]);
  assert.equal(
    result.embeddings[0]?.textHash,
    hashText("refund flow diagram s3://bucket/doc_1.png asset_1")
  );
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer visual-secret-value");
  assert.equal(transport.requests[0]?.timeoutMs, 5000);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.warnings, ["provider_used_visual_fixture"]);
});

test("retries retryable visual query provider responses", async () => {
  const transport = new MockProviderTransport([
    errorResponse(429, "rate limited"),
    okResponse({
      vectors: [[0, 1, 0]]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embedQuery({
    query: "show billing screenshot"
  });

  assert.equal(result.status, "succeeded");
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(result.vectors, [[0, 1, 0]]);
  assert.deepEqual(result.warnings, ["query_provider_fixture"]);
});

test("returns auth failure before transport when visual api key is missing", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "visual_input_1", vectors: [[1, 0, 0]] }]
    })
  ]);
  const adapter = providerAdapter(transport, " ");

  const result = await adapter.embedVisualAssets({
    inputs: [
      {
        id: "visual_input_1",
        chunkId: "chunk_1",
        documentId: "doc_1",
        mediaType: "image/png"
      }
    ]
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "Provider API key is missing.");
  assert.equal(transport.requests.length, 0);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("does not retry auth errors and redacts visual provider secrets", async () => {
  const transport = new MockProviderTransport([
    errorResponse(401, "bad api key visual-secret-value bearer visual-secret-value")
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embedQuery({
    query: "show refund image"
  });

  assert.equal(result.status, "failed");
  assert.equal(transport.requests.length, 1);
  assert.equal(result.errorMessage?.includes("visual-secret-value"), false);
  assert.equal(result.errorMessage?.includes("[REDACTED]"), true);
  assert.equal(result.warnings.includes("provider_error_code:auth_error"), true);
});

test("maps invalid visual provider responses into failed results", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      vectors: [[1, 0]]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embedQuery({
    query: "show refund image"
  });

  assert.equal(result.status, "failed");
  assert.match(result.errorMessage ?? "", /dimensions/);
  assert.equal(result.warnings.includes("provider_error_code:invalid_response"), true);
});

test("reports missing visual embeddings without fabricating vectors", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      embeddings: [{ id: "visual_input_1", vectors: [[1, 0, 0]] }]
    })
  ]);
  const adapter = providerAdapter(transport);

  const result = await adapter.embedVisualAssets({
    inputs: [
      {
        id: "visual_input_1",
        chunkId: "chunk_1",
        documentId: "doc_1",
        mediaType: "image/png"
      },
      {
        id: "visual_input_2",
        chunkId: "chunk_2",
        documentId: "doc_1",
        mediaType: "image/png"
      }
    ]
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 1);
  assert.equal(result.warnings.includes("provider_missing_visual_embedding_count:1"), true);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
