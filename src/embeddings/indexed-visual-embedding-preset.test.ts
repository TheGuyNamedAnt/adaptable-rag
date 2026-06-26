import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../shared/hash.js";
import type {
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import {
  buildIndexedVisualEmbeddingRequestBody,
  buildIndexedVisualQueryEmbeddingRequestBody,
  createIndexedVisualEmbeddingAdapter,
  parseIndexedVisualEmbeddingResponse,
  parseIndexedVisualQueryEmbeddingResponse
} from "./indexed-visual-embedding-preset.js";

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
      throw new Error("No mock visual embedding response configured.");
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}

function providerConfig(overrides: Partial<ProviderBoundaryConfig> = {}): ProviderBoundaryConfig {
  return {
    id: "indexed-visual-embedding-test",
    provider: "test-indexed-visual-embedding",
    modelName: "indexed-visual-embedding-model",
    endpoint: "https://provider.example.test/v1/visual-embeddings",
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

test("indexed visual preset builds visual asset and query request bodies", () => {
  const visualBody = buildIndexedVisualEmbeddingRequestBody(
    {
      inputs: [
        {
          id: "visual_input_1",
          chunkId: "chunk_1",
          documentId: "doc_1",
          mediaType: "image/png",
          visualAssetId: "asset_1",
          uri: "s3://bucket/doc_1.png",
          text: "refund flow diagram",
          metadata: {
            page: 1,
            important: true
          }
        }
      ]
    },
    "indexed-visual-embedding-model"
  );
  const queryBody = buildIndexedVisualQueryEmbeddingRequestBody(
    {
      query: "show refund diagram"
    },
    "indexed-visual-embedding-model"
  );

  assert.deepEqual(visualBody, {
    model: "indexed-visual-embedding-model",
    input_type: "visual_asset",
    input: [
      {
        id: "visual_input_1",
        chunk_id: "chunk_1",
        document_id: "doc_1",
        media_type: "image/png",
        visual_asset_id: "asset_1",
        uri: "s3://bucket/doc_1.png",
        text: "refund flow diagram",
        metadata: {
          page: 1,
          important: true
        }
      }
    ],
    encoding_format: "float"
  });
  assert.deepEqual(queryBody, {
    model: "indexed-visual-embedding-model",
    input_type: "query",
    input: "show refund diagram",
    encoding_format: "float"
  });
});

test("indexed visual preset maps returned ids and indices back to input ids", async () => {
  const transport = new MockProviderTransport([
    okResponse({
      data: [
        {
          index: 1,
          vectors: [
            [0, 1, 0],
            [0, 0, 1]
          ]
        },
        {
          id: "visual_input_1",
          embedding: [1, 0, 0]
        }
      ],
      warnings: ["provider_used_visual_fixture"]
    })
  ]);
  const adapter = createIndexedVisualEmbeddingAdapter({
    config: providerConfig(),
    dimensions: 3,
    secrets: {
      apiKeyProvider: () => "visual-secret",
      secretId: "VISUAL_EMBEDDING_KEY"
    },
    transport,
    now: () => "2026-06-23T00:00:00.000Z",
    sleep: async () => {}
  });

  const result = await adapter.embedVisualAssets({
    inputs: [
      {
        id: "visual_input_1",
        chunkId: "chunk_1",
        documentId: "doc_1",
        mediaType: "image/png",
        visualAssetId: "asset_1",
        text: "refund flow diagram"
      },
      {
        id: "visual_input_2",
        chunkId: "chunk_2",
        documentId: "doc_1",
        mediaType: "image/png",
        text: "billing screenshot"
      }
    ]
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.embeddings.length, 2);
  assert.deepEqual(
    result.embeddings.find((embedding) => embedding.id === "visual_input_1")?.vectors,
    [[1, 0, 0]]
  );
  assert.deepEqual(
    result.embeddings.find((embedding) => embedding.id === "visual_input_2")?.vectors,
    [
      [0, 1, 0],
      [0, 0, 1]
    ]
  );
  assert.equal(
    result.embeddings.find((embedding) => embedding.id === "visual_input_1")?.textHash,
    hashText("refund flow diagram asset_1")
  );
  assert.deepEqual(result.usage, {
    inputCount: 2,
    totalInputCharacters:
      "refund flow diagram asset_1".length + "billing screenshot visual_input_2".length,
    vectorCount: 3
  });
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer visual-secret");
  assert.deepEqual(result.warnings, ["provider_used_visual_fixture"]);
});

test("indexed visual query preset parses direct and data-wrapped vector payloads", () => {
  const direct = parseIndexedVisualQueryEmbeddingResponse(
    okResponse({
      vectors: [
        [1, 0, 0],
        [0, 1, 0]
      ],
      usage: {
        input_count: 1,
        total_input_characters: 19,
        vector_count: 2
      }
    })
  );
  const wrapped = parseIndexedVisualQueryEmbeddingResponse(
    okResponse({
      data: [{ embedding: [0, 0, 1] }]
    })
  );

  assert.deepEqual(direct.vectors, [
    [1, 0, 0],
    [0, 1, 0]
  ]);
  assert.deepEqual(direct.usage, {
    inputCount: 1,
    totalInputCharacters: 19,
    vectorCount: 2
  });
  assert.deepEqual(wrapped.vectors, [[0, 0, 1]]);
});

test("indexed visual preset rejects malformed ids and vectors", () => {
  assert.throws(
    () =>
      parseIndexedVisualEmbeddingResponse(
        okResponse({
          data: [{ id: "unknown_input", vectors: [[1, 0, 0]] }]
        }),
        {
          inputs: [
            {
              id: "visual_input_1",
              chunkId: "chunk_1",
              documentId: "doc_1",
              mediaType: "image/png"
            }
          ]
        }
      ),
    /unknown input id/
  );

  assert.throws(
    () =>
      parseIndexedVisualQueryEmbeddingResponse(
        okResponse({
          vectors: [["not-a-number"]]
        })
      ),
    /invalid vector/
  );
});
