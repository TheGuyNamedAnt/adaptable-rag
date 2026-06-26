import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import { VectorRetriever } from "../retrieval/vector-retriever.js";
import { cosineSimilarity } from "../shared/vector-math.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { HostedVectorStore, type HostedVectorQueryRequest } from "./hosted-vector-store.js";
import type { ChunkVector, VectorIndexOptions } from "./vector-store.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import type { IndexOperationResult } from "./index-types.js";

class MockHostedVectorTransport {
  readonly queryRequests: HostedVectorQueryRequest[] = [];
  private forcedMatches: readonly ReturnType<typeof hostedMatch>[] | undefined;
  private vectors: ChunkVector[] = [];

  async upsert(input: {
    readonly vectors: readonly ChunkVector[];
    readonly overwriteMode: VectorIndexOptions["overwriteMode"];
  }): Promise<{ readonly results: readonly IndexOperationResult[] }> {
    const results: IndexOperationResult[] = [];
    for (const vector of input.vectors) {
      const existingIndex = this.vectors.findIndex((stored) => stored.id === vector.id);
      if (existingIndex >= 0 && input.overwriteMode !== "replace") {
        throw new Error(`Hosted vector "${vector.id}" is already indexed.`);
      }

      if (existingIndex >= 0) {
        this.vectors[existingIndex] = vector;
      } else {
        this.vectors.push(vector);
      }

      results.push({
        accepted: true,
        id: vector.id,
        message: existingIndex >= 0 ? "Hosted vector replaced." : "Hosted vector indexed."
      });
    }

    return { results };
  }

  async deleteByDocument(input: {
    readonly documentId: string;
  }): Promise<{ readonly deletedCount: number }> {
    const before = this.vectors.length;
    this.vectors = this.vectors.filter((vector) => vector.documentId !== input.documentId);
    return { deletedCount: before - this.vectors.length };
  }

  async query(request: HostedVectorQueryRequest): Promise<{
    readonly matches: readonly ReturnType<typeof hostedMatch>[];
  }> {
    this.queryRequests.push(request);
    if (this.forcedMatches) {
      const matches = this.forcedMatches;
      this.forcedMatches = undefined;
      return { matches };
    }

    const scored = this.vectors
      .filter(
        (vector) =>
          vector.tenantId === request.tenantId && vector.namespaceId === request.namespaceId
      )
      .map((vector) =>
        hostedMatch(
          vector,
          Math.round(cosineSimilarity(request.vector, vector.vector) * 1000000) / 1000000
        )
      )
      .sort((first, second) => second.score - first.score);

    return { matches: scored.slice(0, request.topK) };
  }

  async count(): Promise<number> {
    return this.vectors.length;
  }

  replaceVector(vectorId: string, update: Partial<ChunkVector>): void {
    const index = this.vectors.findIndex((vector) => vector.id === vectorId);
    assert.notEqual(index, -1);
    const existing = this.vectors[index];
    assert.ok(existing);
    this.vectors[index] = {
      ...existing,
      ...update
    };
  }

  forceNextMatch(vectorId: string, score: number): void {
    const vector = this.vectors.find((stored) => stored.id === vectorId);
    assert.ok(vector);
    this.forcedMatches = [hostedMatch(vector, score)];
  }
}

function hostedMatch(vector: ChunkVector, score: number) {
  return {
    id: vector.id,
    chunkId: vector.chunkId,
    documentId: vector.documentId,
    tenantId: vector.tenantId,
    namespaceId: vector.namespaceId,
    textHash: vector.textHash,
    embeddingModel: vector.embeddingModel,
    embeddedAt: vector.embeddedAt,
    dimensions: vector.dimensions,
    vector: vector.vector,
    score,
    reasons: ["mock_hosted_similarity"]
  };
}

test("hosted vector store indexes through transport and resolves matches through local chunks", async () => {
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
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 32,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 32 });

  const indexed = await new EmbeddingIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;
  assert.ok(queryEmbedding);

  const result = await vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(vectorStore.capabilities.storageKind, "hosted");
  assert.equal(vectorStore.capabilities.durable, true);
  assert.equal(indexed.indexedVectorCount, chunks.length);
  assert.equal(await vectorStore.vectorCount(), chunks.length);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.candidates[0]?.reasons[0], "mock_hosted_similarity");
});

test("hosted vector query does not send principal claims to the remote transport", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });
  await new EmbeddingIndexer({ adapter, vectorStore, now: () => FIXED_NOW }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [queryEmbedding] = (await adapter.embed({ inputs: [{ id: "query", text: "refund" }] }))
    .embeddings;
  assert.ok(queryEmbedding);

  await vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(transport.queryRequests.length, 1);
  const serializedRemoteRequest = JSON.stringify(transport.queryRequests[0]);
  assert.equal(serializedRemoteRequest.includes("tenant_1"), true);
  assert.equal(serializedRemoteRequest.includes("user_1"), false);
  assert.equal(serializedRemoteRequest.includes("support_team"), false);
  assert.equal(serializedRemoteRequest.includes("roles"), false);
});

test("hosted vector store denies remote matches that fail local access filters", async () => {
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
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
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

  const denied = await vectorStore.findNearestVectors({
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

test("hosted vector store rejects stale remote metadata before returning a candidate", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_stale",
      body: "Refund billing policy for stale hosted vector test."
    })
  ]);
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });
  await new EmbeddingIndexer({ adapter, vectorStore, now: () => FIXED_NOW }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [firstChunk] = chunks;
  assert.ok(firstChunk);
  transport.replaceVector(`fake-hashed-token-embedding_${firstChunk.id}`, {
    textHash: "wrong_hash"
  });
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;
  assert.ok(queryEmbedding);

  const result = await vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "stale_vector");
});

test("hosted vector store rejects cross-tenant matches even if the transport returns them", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_cross_tenant",
      body: "Refund billing policy for cross-tenant hosted vector test."
    })
  ]);
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });
  await new EmbeddingIndexer({ adapter, vectorStore, now: () => FIXED_NOW }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [firstChunk] = chunks;
  assert.ok(firstChunk);
  const vectorId = `fake-hashed-token-embedding_${firstChunk.id}`;
  transport.replaceVector(vectorId, {
    tenantId: "tenant_2"
  });
  transport.forceNextMatch(vectorId, 1);
  const [queryEmbedding] = (
    await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
  ).embeddings;
  assert.ok(queryEmbedding);

  const result = await vectorStore.findNearestVectors({
    vector: queryEmbedding.vector,
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "access_denied_or_missing_chunk");
});

test("vector retriever can use an async hosted vector store", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_refund",
      body: "Refund billing policy requires support review."
    })
  ]);
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 16,
    now: () => FIXED_NOW
  });
  const embeddingAdapter = new FakeEmbeddingAdapter({ dimensions: 16 });
  await new EmbeddingIndexer({
    adapter: embeddingAdapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const retriever = new VectorRetriever({
    embeddingAdapter,
    vectorStore,
    now: () => FIXED_NOW
  });

  const result = await retriever.retrieve({
    query: "refund billing",
    filter: makeIndexFilter(),
    topK: 1,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  assert.equal(result.trace.mode, "vector");
});

test("hosted vector store exposes delete and rejects unsupported snapshots", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const transport = new MockHostedVectorTransport();
  const vectorStore = new HostedVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await new EmbeddingIndexer({
    adapter: new FakeEmbeddingAdapter({ dimensions: 8 }),
    vectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    chunks,
    requestedAt: FIXED_NOW
  });
  const [chunk] = chunks;
  assert.ok(chunk);

  assert.equal(await vectorStore.deleteVectorsForDocument(chunk.documentId), chunks.length);
  assert.equal(await vectorStore.vectorCount(), 0);
  assert.throws(() => vectorStore.snapshot(), /does not expose local vector snapshots/);
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
