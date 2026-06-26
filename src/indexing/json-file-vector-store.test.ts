import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { FakeEmbeddingAdapter } from "../embeddings/fake-embedding-adapter.js";
import { EmbeddingIndexer } from "../embeddings/embedding-indexer.js";
import type { RagDocument } from "../documents/document.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import { JsonFileVectorStore } from "./json-file-vector-store.js";

test("persists and reloads a validated vector snapshot", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-vectors-"));
  try {
    const filePath = path.join(directory, "vectors.json");
    const { chunkIndex, chunks } = makeChunkIndex([
      makeDocument({
        id: "doc_refund",
        body: "Durable refund policy evidence."
      }),
      makeDocument({
        id: "doc_login",
        body: "Login troubleshooting evidence."
      })
    ]);
    const adapter = new FakeEmbeddingAdapter({ dimensions: 16 });
    const first = new JsonFileVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 16,
      now: () => FIXED_NOW,
      pretty: true
    });

    await new EmbeddingIndexer({ adapter, vectorStore: first, now: () => FIXED_NOW }).indexChunks({
      chunks,
      requestedAt: FIXED_NOW
    });

    const reloaded = new JsonFileVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 16,
      now: () => FIXED_NOW
    });
    const [queryEmbedding] = (
      await adapter.embed({ inputs: [{ id: "query", text: "refund policy" }] })
    ).embeddings;
    assert.ok(queryEmbedding);

    const result = reloaded.findNearestVectors({
      vector: queryEmbedding.vector,
      filter: makeIndexFilter(),
      topK: 1
    });

    assert.equal(reloaded.capabilities.durable, true);
    assert.equal(reloaded.capabilities.storageKind, "json_file");
    assert.equal(reloaded.vectorCount(), chunks.length);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.chunk.documentId, "doc_refund");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reloaded durable vector store preserves access-filter enforcement", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-vectors-"));
  try {
    const filePath = path.join(directory, "vectors.json");
    const restricted = makeDocument({
      id: "doc_restricted_vector",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        roles: ["finance_admin"]
      },
      body: "Refund billing policy for finance admins only."
    });
    const { chunkIndex, chunks } = makeChunkIndex([restricted]);
    const adapter = new FakeEmbeddingAdapter({ dimensions: 8 });
    const first = new JsonFileVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 8,
      now: () => FIXED_NOW
    });

    await new EmbeddingIndexer({ adapter, vectorStore: first, now: () => FIXED_NOW }).indexChunks({
      chunks,
      requestedAt: FIXED_NOW
    });

    const reloaded = new JsonFileVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 8,
      now: () => FIXED_NOW
    });
    const [queryEmbedding] = (
      await adapter.embed({ inputs: [{ id: "query", text: "refund billing" }] })
    ).embeddings;
    assert.ok(queryEmbedding);

    const denied = reloaded.findNearestVectors({
      vector: queryEmbedding.vector,
      filter: makeIndexFilter({
        principal: makePrincipal({ roles: ["support"] })
      }),
      topK: 5,
      includeRejected: true
    });

    assert.equal(denied.candidates.length, 0);
    assert.equal(denied.rejected[0]?.code, "access_denied_or_missing_chunk");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid durable vector snapshots before serving reads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-vectors-"));
  try {
    const filePath = path.join(directory, "vectors.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, vectors: {} }), "utf8");

    assert.throws(
      () =>
        new JsonFileVectorStore({
          filePath,
          chunkStore: new InMemoryRagIndex({ now: () => FIXED_NOW }),
          dimensions: 3,
          now: () => FIXED_NOW
        }),
      /Invalid vector snapshot/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed vector records during durable reload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-vectors-"));
  try {
    const filePath = path.join(directory, "vectors.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        vectors: [
          {
            vector: {
              id: "bad_vector",
              chunkId: "chunk_1",
              documentId: "doc_1",
              tenantId: "tenant_1",
              namespaceId: "test-namespace",
              textHash: "hash",
              embeddingModel: "model",
              dimensions: 3,
              vector: [1, 2],
              embeddedAt: FIXED_NOW
            },
            indexedAt: FIXED_NOW
          }
        ]
      }),
      "utf8"
    );

    assert.throws(
      () =>
        new JsonFileVectorStore({
          filePath,
          chunkStore: new InMemoryRagIndex({ now: () => FIXED_NOW }),
          dimensions: 3,
          now: () => FIXED_NOW
        }),
      /dimensions must match vector length/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
