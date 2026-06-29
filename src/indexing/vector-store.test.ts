import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { embeddingConfigHashFor } from "../embeddings/embedding-identity.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import type { RagDocument } from "../documents/document.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { runVectorStoreContract } from "../test-support/vector-store-contract.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import { InMemoryVectorStore } from "./vector-store.js";

runVectorStoreContract({
  name: "InMemoryVectorStore",
  dimensions: 3,
  createStore: ({ chunkStore, dimensions }) =>
    new InMemoryVectorStore({
      chunkStore,
      dimensions,
      now: () => FIXED_NOW
    })
});

test("indexes chunk embeddings and finds nearest vectors", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    }),
    makeDocument({
      id: "doc_login",
      body: "Login password reset steps for account recovery."
    })
  ]);
  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 32,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 32 });
  const indexer = new EmbeddingIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  });
  const indexed = await indexer.indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;

  assert.ok(queryEmbedding);
  assert.equal(indexed.indexedVectorCount, chunks.length);

  const result = vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.candidates[0]?.rank, 1);
});

test("embedding indexer uses config-hash vector ids", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });

  await new EmbeddingIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });

  const expectedHash = embeddingConfigHashFor({
    provider: adapter.provider,
    modelName: adapter.modelName,
    dimensions: adapter.dimensions,
    adapterId: adapter.id
  });

  assert.equal(vectorStore.snapshot().vectors[0]?.vector.id.startsWith(`${expectedHash}_`), true);
});

test("vector store enforces access filters by resolving chunks through the chunk store", async () => {
  const restricted = makeDocument({
    id: "doc_restricted",
    body: "Refund billing policy for finance admins only.",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      roles: ["finance_admin"]
    }
  });
  const { chunkIndex, chunks } = makeChunkIndex([restricted]);
  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 16,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 16 });
  await new EmbeddingIndexer({ adapter, vectorStore, now: () => FIXED_NOW }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;

  assert.ok(queryEmbedding);

  const denied = vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter({
      principal: makePrincipal({ roles: ["support"] })
    }),
    topK: 5,
    includeRejected: true
  });

  assert.equal(denied.candidates.length, 0);
  assert.equal(denied.rejected[0]?.code, "access_denied_or_missing_chunk");
});

test("vector store rejects stale vectors whose chunk text hash changed", async () => {
  const document = makeDocument({
    id: "doc_stale",
    body: "Refund billing policy for stale-vector test."
  });
  const { chunkIndex, chunks } = makeChunkIndex([document]);
  const [chunk] = chunks;
  assert.ok(chunk);

  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });
  vectorStore.addChunkVectors([
    {
      id: "manual_stale_vector",
      chunkId: chunk.id,
      documentId: chunk.documentId,
      tenantId: chunk.accessScope.tenantId,
      namespaceId: chunk.namespaceId,
      textHash: "wrong_hash",
      embeddingModel: "manual",
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: FIXED_NOW
    }
  ]);

  const result = vectorStore.findNearestVectors({
    vector: [1, 0, 0],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "stale_vector");
});

test("vector store rejects candidates from a different embedding model", () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);

  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });
  vectorStore.addChunkVectors([
    {
      id: "manual_old_model_vector",
      chunkId: chunk.id,
      documentId: chunk.documentId,
      tenantId: chunk.accessScope.tenantId,
      namespaceId: chunk.namespaceId,
      textHash: chunk.textHash,
      embeddingModel: "old-model",
      embeddingProvider: "fake",
      embeddingConfigHash: "old-hash",
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: FIXED_NOW
    }
  ]);

  const result = vectorStore.findNearestVectors({
    vector: [1, 0, 0],
    filter: makeIndexFilter(),
    topK: 1,
    embeddingModel: "new-model",
    embeddingProvider: "fake",
    embeddingConfigHash: "new-hash",
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "embedding_identity_mismatch");
});

test("vector store rejects legacy vectors missing required embedding config hash", () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);

  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });
  vectorStore.addChunkVectors([
    {
      id: "legacy_vector_without_hash",
      chunkId: chunk.id,
      documentId: chunk.documentId,
      tenantId: chunk.accessScope.tenantId,
      namespaceId: chunk.namespaceId,
      textHash: chunk.textHash,
      embeddingModel: "same-model",
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: FIXED_NOW
    }
  ]);

  const result = vectorStore.findNearestVectors({
    vector: [1, 0, 0],
    filter: makeIndexFilter(),
    topK: 1,
    embeddingModel: "same-model",
    embeddingProvider: "provider",
    embeddingConfigHash: "required-hash",
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "embedding_identity_mismatch");
});

test("vector store rejects vectors whose tenant metadata no longer matches the chunk", () => {
  const document = makeDocument({
    id: "doc_wrong_tenant_vector",
    body: "Refund billing policy for vector tenant metadata test."
  });
  const { chunkIndex, chunks } = makeChunkIndex([document]);
  const [chunk] = chunks;
  assert.ok(chunk);

  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });
  vectorStore.addChunkVectors([
    {
      id: "manual_wrong_tenant_vector",
      chunkId: chunk.id,
      documentId: chunk.documentId,
      tenantId: "tenant_2",
      namespaceId: chunk.namespaceId,
      textHash: chunk.textHash,
      embeddingModel: "manual",
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: FIXED_NOW
    }
  ]);

  const result = vectorStore.findNearestVectors({
    vector: [1, 0, 0],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "stale_vector");
});

test("embedding indexer reports adapter failures without writing vectors", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const vectorStore = new InMemoryVectorStore({
    chunkStore: chunkIndex,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const indexer = new EmbeddingIndexer({
    adapter: new FakeEmbeddingAdapter({ dimensions: 8, failWith: "provider down" }),
    vectorStore,
    now: () => FIXED_NOW
  });

  const result = await indexer.indexChunks({ chunks, requestedAt: FIXED_NOW });

  assert.equal(result.indexedVectorCount, 0);
  assert.equal(vectorStore.vectorCount(), 0);
  assert.equal(result.warnings[0]?.code, "embedding_failed");
});

function makeChunkIndex(documents: readonly RagDocument[]): {
  readonly chunkIndex: InMemoryRagIndex;
  readonly chunks: readonly ReturnType<typeof chunkDocument>["chunks"][number][];
} {
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks = [];

  for (const document of documents) {
    const documentChunks = chunkDocument({ document }).chunks;
    chunkIndex.addDocument(document);
    chunkIndex.addChunks(document.id, documentChunks);
    chunks.push(...documentChunks);
  }

  return {
    chunkIndex,
    chunks
  };
}
