import assert from "node:assert/strict";
import test from "node:test";

import type {
  HostedVectorFetchLike,
  HostedVectorFetchRequestInit,
  HostedVectorFetchResponse,
  HostedVectorFetchResponseHeaders
} from "./hosted-vector-vendor-transports.js";
import {
  HostedVectorHttpClient,
  PgVectorRpcHostedVectorTransport,
  PineconeHostedVectorTransport,
  QdrantHostedVectorTransport,
  WeaviateHostedVectorTransport
} from "./hosted-vector-vendor-transports.js";
import type { ChunkVector } from "./vector-store.js";

const VECTOR: ChunkVector = {
  id: "model_doc_refund_chunk_1",
  chunkId: "chunk_refund_1",
  documentId: "doc_refund",
  tenantId: "tenant_1",
  namespaceId: "support",
  textHash: "hash_refund",
  embeddingModel: "model",
  dimensions: 3,
  vector: [0.1, 0.2, 0.3],
  embeddedAt: "2026-06-23T00:00:00.000Z"
};

class HeadersRecord implements HostedVectorFetchResponseHeaders {
  constructor(private readonly headers: Readonly<Record<string, string>> = {}) {}

  forEach(callback: (value: string, key: string) => void): void {
    for (const [key, value] of Object.entries(this.headers)) {
      callback(value, key);
    }
  }
}

interface CapturedRequest {
  readonly url: string;
  readonly init: HostedVectorFetchRequestInit;
  readonly body: unknown;
}

function fakeFetch(
  responses: readonly {
    readonly status?: number;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }[]
): {
  readonly calls: CapturedRequest[];
  readonly fetch: HostedVectorFetchLike;
} {
  const calls: CapturedRequest[] = [];
  let index = 0;

  return {
    calls,
    fetch: async (url, init): Promise<HostedVectorFetchResponse> => {
      calls.push({
        url,
        init,
        body: init.body ? (JSON.parse(init.body) as unknown) : undefined
      });
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      assert.ok(response);
      return {
        status: response.status ?? 200,
        headers: new HeadersRecord(response.headers),
        text: async () =>
          response.body === undefined || response.body === null ? "" : JSON.stringify(response.body)
      };
    }
  };
}

function metadata() {
  return {
    vectorId: VECTOR.id,
    chunkId: VECTOR.chunkId,
    documentId: VECTOR.documentId,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    textHash: VECTOR.textHash,
    embeddingModel: VECTOR.embeddingModel,
    embeddedAt: VECTOR.embeddedAt,
    dimensions: VECTOR.dimensions,
    indexedAt: "2026-06-23T00:01:00.000Z"
  };
}

function vector(overrides: Partial<ChunkVector>): ChunkVector {
  return {
    ...VECTOR,
    ...overrides
  };
}

test("Pinecone transport maps hosted vector requests and parses metadata-backed matches", async () => {
  const http = fakeFetch([
    { body: { upsertedCount: 1 } },
    { body: {} },
    {
      body: {
        matches: [
          {
            id: VECTOR.id,
            score: 0.91,
            values: VECTOR.vector,
            metadata: metadata()
          }
        ]
      }
    }
  ]);
  const transport = new PineconeHostedVectorTransport({
    indexHost: "https://pinecone.example.test",
    namespace: "support",
    deleteNamespaces: ["support"],
    secrets: { apiKeyProvider: () => "pinecone-key" },
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  const upserted = await transport.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const deleted = await transport.deleteByDocument({ documentId: VECTOR.documentId });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 5
  });

  assert.equal(upserted.results[0]?.accepted, true);
  assert.equal(deleted.deletedCount, 0);
  assert.equal(queried.matches[0]?.chunkId, VECTOR.chunkId);
  assert.equal(queried.matches[0]?.score, 0.91);
  assert.equal(http.calls[0]?.url, "https://pinecone.example.test/vectors/upsert");
  assert.equal(http.calls[0]?.init.headers["api-key"], "pinecone-key");
  assert.equal(http.calls[0]?.init.headers["x-pinecone-api-version"], "2025-10");
  assert.deepEqual((http.calls[0]?.body as { readonly vectors: readonly unknown[] }).vectors[0], {
    id: VECTOR.id,
    values: VECTOR.vector,
    metadata: metadata()
  });
  assert.deepEqual(http.calls[1]?.body, {
    namespace: "support",
    filter: { documentId: { $eq: VECTOR.documentId } }
  });
  const queryBody = http.calls[2]?.body as {
    readonly filter: Readonly<Record<string, unknown>>;
  };
  assert.deepEqual(queryBody.filter, {
    tenantId: { $eq: VECTOR.tenantId },
    namespaceId: { $eq: VECTOR.namespaceId }
  });
  assert.equal(JSON.stringify(queryBody).includes("user_1"), false);
});

test("Qdrant transport uses point payloads and named vectors", async () => {
  const http = fakeFetch([
    { body: { status: "ok" } },
    {
      body: {
        result: {
          points: [
            {
              id: "remote-id",
              score: 0.82,
              payload: metadata(),
              vector: { text: VECTOR.vector }
            }
          ]
        }
      }
    },
    { body: { status: "ok" } }
  ]);
  const transport = new QdrantHostedVectorTransport({
    endpoint: "http://localhost:6333",
    collectionName: "rag_points",
    vectorName: "text",
    secrets: { apiKeyProvider: () => "qdrant-key" },
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 3,
    minScore: 0.5
  });
  await transport.deleteByDocument({ documentId: VECTOR.documentId });

  assert.equal(http.calls[0]?.init.method, "PUT");
  assert.equal(http.calls[0]?.url, "http://localhost:6333/collections/rag_points/points?wait=true");
  const point = (
    http.calls[0]?.body as {
      readonly points: readonly {
        readonly id: string;
        readonly vector: Readonly<Record<string, readonly number[]>>;
        readonly payload: Readonly<Record<string, unknown>>;
      }[];
    }
  ).points[0];
  assert.match(point?.id ?? "", /^[0-9a-f-]{36}$/u);
  assert.deepEqual(point?.vector, { text: VECTOR.vector });
  assert.equal(point?.payload["vectorId"], VECTOR.id);
  assert.equal(queried.matches[0]?.reasons?.[0], "qdrant_vector_similarity");
  assert.deepEqual(http.calls[1]?.body, {
    query: VECTOR.vector,
    using: "text",
    filter: {
      must: [
        { key: "tenantId", match: { value: VECTOR.tenantId } },
        { key: "namespaceId", match: { value: VECTOR.namespaceId } }
      ]
    },
    limit: 3,
    with_vector: true,
    with_payload: true,
    score_threshold: 0.5
  });
  assert.equal(
    http.calls[2]?.url,
    "http://localhost:6333/collections/rag_points/points/delete?wait=true"
  );
});

test("Weaviate transport uses batch objects, GraphQL nearVector, and delete counts", async () => {
  const http = fakeFetch([
    { body: [{ result: { status: "SUCCESS" } }] },
    {
      body: {
        data: {
          Get: {
            RagVector: [
              {
                ...metadata(),
                _additional: {
                  id: "remote-id",
                  certainty: 0.77,
                  vector: VECTOR.vector
                }
              }
            ]
          }
        }
      }
    },
    { body: { results: { successful: 2 } } }
  ]);
  const transport = new WeaviateHostedVectorTransport({
    endpoint: "https://weaviate.example.test",
    collectionName: "RagVector",
    tenant: "tenant_1",
    secrets: { apiKeyProvider: () => "weaviate-key" },
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 2
  });
  const deleted = await transport.deleteByDocument({ documentId: VECTOR.documentId });

  assert.equal(http.calls[0]?.url, "https://weaviate.example.test/v1/batch/objects");
  assert.equal(http.calls[0]?.init.headers.authorization, "Bearer weaviate-key");
  const object = (
    http.calls[0]?.body as {
      readonly objects: readonly {
        readonly class: string;
        readonly tenant: string;
        readonly vector: readonly number[];
        readonly properties: Readonly<Record<string, unknown>>;
      }[];
    }
  ).objects[0];
  assert.equal(object?.class, "RagVector");
  assert.equal(object?.tenant, "tenant_1");
  assert.deepEqual(object?.vector, VECTOR.vector);
  assert.equal(object?.properties["chunkId"], VECTOR.chunkId);
  const graphQlQuery = (http.calls[1]?.body as { readonly query: string }).query;
  assert.equal(graphQlQuery.includes("nearVector"), true);
  assert.equal(graphQlQuery.includes("tenantId"), true);
  assert.equal(graphQlQuery.includes("user_1"), false);
  assert.equal(queried.matches[0]?.score, 0.77);
  assert.equal(http.calls[2]?.init.method, "DELETE");
  assert.equal(deleted.deletedCount, 2);
});

test("pgvector RPC transport uses PostgREST upsert, delete, and match RPC shapes", async () => {
  const http = fakeFetch([
    { body: null },
    { body: null, headers: { "content-range": "0-1/2" } },
    {
      body: [
        {
          id: VECTOR.id,
          chunk_id: VECTOR.chunkId,
          document_id: VECTOR.documentId,
          tenant_id: VECTOR.tenantId,
          namespace_id: VECTOR.namespaceId,
          text_hash: VECTOR.textHash,
          embedding_model: VECTOR.embeddingModel,
          embedded_at: VECTOR.embeddedAt,
          dimensions: VECTOR.dimensions,
          embedding: VECTOR.vector,
          similarity: 0.93
        }
      ]
    }
  ]);
  const transport = new PgVectorRpcHostedVectorTransport({
    endpoint: "https://supabase.example.test",
    tableName: "rag_vectors",
    matchFunctionName: "match_rag_vectors",
    secrets: { apiKeyProvider: () => "supabase-key" },
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const deleted = await transport.deleteByDocument({ documentId: VECTOR.documentId });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 4,
    minScore: 0.7
  });

  assert.equal(http.calls[0]?.url, "https://supabase.example.test/rest/v1/rag_vectors");
  assert.equal(http.calls[0]?.init.headers.apikey, "supabase-key");
  assert.equal(http.calls[0]?.init.headers.prefer, "resolution=merge-duplicates,return=minimal");
  assert.deepEqual((http.calls[0]?.body as readonly unknown[])[0], {
    id: VECTOR.id,
    chunk_id: VECTOR.chunkId,
    document_id: VECTOR.documentId,
    tenant_id: VECTOR.tenantId,
    namespace_id: VECTOR.namespaceId,
    text_hash: VECTOR.textHash,
    embedding_model: VECTOR.embeddingModel,
    embedded_at: VECTOR.embeddedAt,
    dimensions: VECTOR.dimensions,
    embedding: VECTOR.vector,
    indexed_at: "2026-06-23T00:01:00.000Z"
  });
  assert.equal(
    http.calls[1]?.url,
    "https://supabase.example.test/rest/v1/rag_vectors?document_id=eq.doc_refund"
  );
  assert.equal(deleted.deletedCount, 2);
  assert.equal(http.calls[2]?.url, "https://supabase.example.test/rest/v1/rpc/match_rag_vectors");
  assert.deepEqual(http.calls[2]?.body, {
    query_embedding: VECTOR.vector,
    match_count: 4,
    match_threshold: 0.7,
    tenant_id: VECTOR.tenantId,
    namespace_id: VECTOR.namespaceId
  });
  assert.equal(queried.matches[0]?.score, 0.93);
  assert.equal(queried.matches[0]?.chunkId, VECTOR.chunkId);
});

test("hosted vector HTTP client retries retryable statuses and redacts secrets", async () => {
  const retryingHttp = fakeFetch([
    { status: 429, body: { error: { message: "rate limit" } } },
    { body: { matches: [] } }
  ]);
  const retrying = new PineconeHostedVectorTransport({
    indexHost: "https://pinecone.example.test",
    secrets: { apiKeyProvider: () => "retry-key" },
    http: { fetch: retryingHttp.fetch, sleep: async () => undefined }
  });
  await retrying.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 1
  });
  assert.equal(retryingHttp.calls.length, 2);

  const failingHttp = fakeFetch([
    {
      status: 401,
      body: { error: { message: "bad api_key=secret-vector-key token=secret-vector-key" } }
    }
  ]);
  const failing = new PineconeHostedVectorTransport({
    indexHost: "https://pinecone.example.test",
    secrets: { apiKeyProvider: () => "secret-vector-key" },
    http: { fetch: failingHttp.fetch, sleep: async () => undefined }
  });

  await assert.rejects(
    () =>
      failing.query({
        vector: VECTOR.vector,
        tenantId: VECTOR.tenantId,
        namespaceId: VECTOR.namespaceId,
        topK: 1
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("secret-vector-key"), false);
      assert.equal(error.message.includes("[REDACTED]"), true);
      return true;
    }
  );
});

test("Pinecone transport defaults to request namespaces and drops malformed remote matches", async () => {
  const secondVector = vector({
    id: "model_doc_refund_chunk_2",
    chunkId: "chunk_refund_2"
  });
  const http = fakeFetch([
    { body: { upsertedCount: 2 } },
    { body: {} },
    {
      body: {
        matches: [
          {
            id: "malformed",
            score: 0.1,
            values: VECTOR.vector,
            metadata: { chunkId: "missing-required-fields" }
          },
          {
            id: VECTOR.id,
            score: 0.55,
            values: VECTOR.vector,
            metadata: metadata()
          }
        ]
      }
    }
  ]);
  const transport = new PineconeHostedVectorTransport({
    indexHost: "https://pinecone.example.test/base-path",
    apiVersion: "2026-01",
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [VECTOR, secondVector],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  await transport.deleteByDocument({ documentId: VECTOR.documentId });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 2
  });

  assert.equal(http.calls[0]?.url, "https://pinecone.example.test/base-path/vectors/upsert");
  assert.equal(http.calls[0]?.init.headers["api-key"], undefined);
  assert.equal(http.calls[0]?.init.headers["x-pinecone-api-version"], "2026-01");
  assert.equal((http.calls[0]?.body as { readonly vectors: readonly unknown[] }).vectors.length, 2);
  assert.equal(
    (http.calls[0]?.body as { readonly namespace: string }).namespace,
    VECTOR.namespaceId
  );
  assert.deepEqual(http.calls[1]?.body, {
    filter: { documentId: { $eq: VECTOR.documentId } }
  });
  assert.equal(
    (http.calls[2]?.body as { readonly namespace: string }).namespace,
    VECTOR.namespaceId
  );
  assert.equal(queried.matches.length, 1);
  assert.equal(queried.matches[0]?.chunkId, VECTOR.chunkId);
});

test("hosted vector metadata supports visual evidence without overriding reserved identity", async () => {
  const visualVector = vector({
    id: "visual_doc_refund_chunk_1#visual_patch:0",
    metadata: {
      visualVectorId: "visual_doc_refund_chunk_1",
      visualPatchIndex: 0,
      visualPatchCount: 3,
      visualPageNumber: 2,
      visualLayoutRegionIdsJson: JSON.stringify(["region_1"]),
      visualAssetJson: JSON.stringify({
        id: "asset_1",
        title: "Revenue by Quarter",
        sheetName: "Model",
        anchorCell: "R2C5"
      })
    }
  });
  const http = fakeFetch([{ body: { upsertedCount: 1 } }]);
  const transport = new PineconeHostedVectorTransport({
    indexHost: "https://pinecone.example.test",
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [visualVector],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });

  const metadataPayload = (
    http.calls[0]?.body as {
      readonly vectors: readonly { readonly metadata: Readonly<Record<string, unknown>> }[];
    }
  ).vectors[0]?.metadata;
  assert.equal(metadataPayload?.["visualVectorId"], "visual_doc_refund_chunk_1");
  assert.equal(metadataPayload?.["visualPatchIndex"], 0);
  assert.equal(
    metadataPayload?.["visualAssetJson"],
    JSON.stringify({
      id: "asset_1",
      title: "Revenue by Quarter",
      sheetName: "Model",
      anchorCell: "R2C5"
    })
  );
  assert.equal(metadataPayload?.["tenantId"], VECTOR.tenantId);

  await assert.rejects(
    () =>
      transport.upsert({
        vectors: [
          vector({
            metadata: {
              tenantId: "other_tenant"
            }
          })
        ],
        overwriteMode: "replace",
        indexedAt: "2026-06-23T00:01:00.000Z"
      }),
    /reserved/u
  );
});

test("Qdrant transport supports unnamed vectors, non-waiting writes, and array result bodies", async () => {
  const http = fakeFetch([
    { body: { status: "ok" } },
    {
      body: {
        result: [
          {
            id: "remote-id",
            score: 0.52,
            payload: metadata(),
            vector: VECTOR.vector
          },
          {
            id: "malformed",
            score: "bad-score",
            payload: metadata(),
            vector: ["bad-vector"]
          }
        ]
      }
    },
    { body: { status: "ok" } }
  ]);
  const transport = new QdrantHostedVectorTransport({
    endpoint: "http://127.0.0.1:6333",
    collectionName: "rag_points",
    waitForWrites: false,
    http: { fetch: http.fetch, sleep: async () => undefined }
  });

  await transport.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const queried = await transport.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 1
  });
  await transport.deleteByDocument({ documentId: VECTOR.documentId });

  assert.equal(http.calls[0]?.url, "http://127.0.0.1:6333/collections/rag_points/points");
  assert.deepEqual(
    (
      http.calls[0]?.body as {
        readonly points: readonly { readonly vector: readonly number[] }[];
      }
    ).points[0]?.vector,
    VECTOR.vector
  );
  assert.equal(
    Object.hasOwn(http.calls[1]?.body as Readonly<Record<string, unknown>>, "using"),
    false
  );
  assert.equal(
    Object.hasOwn(http.calls[1]?.body as Readonly<Record<string, unknown>>, "score_threshold"),
    false
  );
  assert.equal(queried.matches.length, 1);
  assert.equal(queried.matches[0]?.score, 0.52);
  assert.equal(http.calls[2]?.url, "http://127.0.0.1:6333/collections/rag_points/points/delete");
});

test("Weaviate and pgvector transports cover optional tenant, distance, schema, and alternate row fields", async () => {
  const weaviateHttp = fakeFetch([
    { body: [{ result: { status: "SUCCESS" } }] },
    {
      body: {
        data: {
          Get: {
            RagVector: [
              {
                ...metadata(),
                vectorId: VECTOR.id,
                _additional: {
                  id: "remote-id",
                  distance: 0.2,
                  vector: VECTOR.vector
                }
              },
              {
                ...metadata(),
                vectorId: "malformed",
                _additional: {
                  id: "malformed",
                  distance: 0.5,
                  vector: ["bad-vector"]
                }
              }
            ]
          }
        }
      }
    },
    { body: { results: {} } }
  ]);
  const weaviate = new WeaviateHostedVectorTransport({
    endpoint: "https://weaviate.example.test",
    collectionName: "RagVector",
    http: { fetch: weaviateHttp.fetch, sleep: async () => undefined }
  });

  await weaviate.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const weaviateQuery = await weaviate.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 2
  });
  const weaviateDelete = await weaviate.deleteByDocument({ documentId: VECTOR.documentId });

  const object = (
    weaviateHttp.calls[0]?.body as {
      readonly objects: readonly Readonly<Record<string, unknown>>[];
    }
  ).objects[0];
  assert.equal(Object.hasOwn(object ?? {}, "tenant"), false);
  assert.equal(
    (weaviateHttp.calls[1]?.body as { readonly query: string }).query.includes("tenant:"),
    false
  );
  assert.equal(weaviateQuery.matches.length, 1);
  assert.equal(weaviateQuery.matches[0]?.score, 0.8);
  assert.equal(weaviateDelete.deletedCount, 0);

  const pgHttp = fakeFetch([
    { body: null },
    { body: null },
    {
      body: [
        {
          vector_id: VECTOR.id,
          chunkId: VECTOR.chunkId,
          documentId: VECTOR.documentId,
          tenantId: VECTOR.tenantId,
          namespaceId: VECTOR.namespaceId,
          textHash: VECTOR.textHash,
          embeddingModel: VECTOR.embeddingModel,
          embeddedAt: VECTOR.embeddedAt,
          dimensions: VECTOR.dimensions,
          vector: VECTOR.vector,
          score: 0.44
        }
      ]
    }
  ]);
  const pgvector = new PgVectorRpcHostedVectorTransport({
    endpoint: "https://supabase.example.test",
    tableName: "rag_vectors",
    matchFunctionName: "match_rag_vectors",
    schema: "private",
    http: { fetch: pgHttp.fetch, sleep: async () => undefined }
  });

  await pgvector.upsert({
    vectors: [VECTOR],
    overwriteMode: "replace",
    indexedAt: "2026-06-23T00:01:00.000Z"
  });
  const pgDelete = await pgvector.deleteByDocument({ documentId: VECTOR.documentId });
  const pgQuery = await pgvector.query({
    vector: VECTOR.vector,
    tenantId: VECTOR.tenantId,
    namespaceId: VECTOR.namespaceId,
    topK: 2
  });

  assert.equal(pgHttp.calls[0]?.init.headers["content-profile"], "private");
  assert.equal(pgHttp.calls[1]?.init.headers["accept-profile"], "private");
  assert.equal(pgHttp.calls[2]?.init.headers["content-profile"], "private");
  assert.equal(pgHttp.calls[2]?.init.headers["accept-profile"], "private");
  assert.equal(pgDelete.deletedCount, 0);
  assert.deepEqual(
    (pgHttp.calls[2]?.body as { readonly match_threshold: number }).match_threshold,
    0
  );
  assert.equal(pgQuery.matches[0]?.id, VECTOR.id);
  assert.equal(pgQuery.matches[0]?.score, 0.44);
});

test("hosted vector transports reject unsafe endpoints and provider names before requests", () => {
  assert.throws(
    () =>
      new PineconeHostedVectorTransport({
        indexHost: "not a url"
      }),
    /valid URL/u
  );
  assert.throws(
    () =>
      new PineconeHostedVectorTransport({
        indexHost: "http://remote.example.test"
      }),
    /https/u
  );
  assert.throws(
    () =>
      new QdrantHostedVectorTransport({
        endpoint: "https://qdrant.example.test",
        collectionName: "bad/name"
      }),
    /Qdrant collectionName/u
  );
  assert.throws(
    () =>
      new WeaviateHostedVectorTransport({
        endpoint: "https://weaviate.example.test",
        collectionName: "bad-name"
      }),
    /GraphQL/u
  );
  assert.throws(
    () =>
      new PgVectorRpcHostedVectorTransport({
        endpoint: "https://supabase.example.test",
        tableName: "bad/name",
        matchFunctionName: "match_rag_vectors"
      }),
    /pgvector tableName/u
  );
  assert.throws(
    () =>
      new PgVectorRpcHostedVectorTransport({
        endpoint: "https://supabase.example.test",
        tableName: "rag_vectors",
        matchFunctionName: "bad/name"
      }),
    /pgvector matchFunctionName/u
  );
});

test("hosted vector HTTP client covers text, serialization, network, timeout, and error branches", async () => {
  const textClient = new HostedVectorHttpClient({
    fetch: async (url, init) => {
      assert.equal(url, "https://vector.example.test/ping");
      assert.equal(init.body, undefined);
      return {
        status: 200,
        headers: new HeadersRecord({ "x-trace-id": "trace_1" }),
        text: async () => "plain text"
      };
    },
    nowMs: () => 100
  });
  const textResponse = await textClient.send({
    url: "https://vector.example.test/ping",
    method: "GET",
    headers: {}
  });
  assert.equal(textResponse.body, "plain text");
  assert.equal(textResponse.headers["x-trace-id"], "trace_1");

  let networkAttempts = 0;
  const networkClient = new HostedVectorHttpClient({
    fetch: async () => {
      networkAttempts += 1;
      if (networkAttempts === 1) {
        throw new Error("network unavailable");
      }
      return {
        status: 200,
        headers: new HeadersRecord(),
        text: async () => ""
      };
    },
    maxRetries: 1,
    sleep: async () => undefined
  });
  await networkClient.send({
    url: "https://vector.example.test/retry",
    method: "POST",
    headers: {},
    body: { ok: true }
  });
  assert.equal(networkAttempts, 2);

  const abortError = new Error("provider aborted request");
  abortError.name = "AbortError";
  const timeoutClient = new HostedVectorHttpClient({
    fetch: async () => {
      throw abortError;
    },
    maxRetries: 0,
    sleep: async () => undefined
  });
  await assert.rejects(
    () =>
      timeoutClient.send({
        url: "https://vector.example.test/timeout",
        method: "POST",
        headers: {},
        body: { ok: true }
      }),
    /timeout/u
  );

  const serializationClient = new HostedVectorHttpClient({
    fetch: async () => {
      throw new Error("fetch should not be called for unserializable bodies");
    },
    maxRetries: 0,
    sleep: async () => undefined
  });
  await assert.rejects(
    () =>
      serializationClient.send({
        url: "https://vector.example.test/serialize",
        method: "POST",
        headers: {},
        body: () => undefined
      }),
    /JSON serializable/u
  );

  const errorClient = new HostedVectorHttpClient({
    fetch: async () => ({
      status: 500,
      headers: new HeadersRecord(),
      text: async () => "server token=secret-key failed"
    }),
    maxRetries: 0,
    sleep: async () => undefined
  });
  await assert.rejects(
    () =>
      errorClient.send(
        {
          url: "https://vector.example.test/error",
          method: "GET",
          headers: {}
        },
        ["secret-key"]
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("secret-key"), false);
      assert.equal(error.message.includes("[REDACTED]"), true);
      return true;
    }
  );
});
