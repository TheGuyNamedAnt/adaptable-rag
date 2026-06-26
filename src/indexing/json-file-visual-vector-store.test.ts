import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { visualVectorsForText } from "../embeddings/fake-visual-embedding-adapter.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import { JsonFileVisualVectorStore } from "./json-file-visual-vector-store.js";
import type { VisualChunkVector } from "./visual-vector-store.js";

test("persists and reloads a validated visual vector snapshot", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-visual-vectors-"));
  try {
    const filePath = path.join(directory, "visual-vectors.json");
    const { chunkIndex, chunks } = makeChunkIndex([
      makeDocument({
        id: "doc_invoice_visual",
        body: "Invoice screenshot shows overdue balances."
      }),
      makeDocument({
        id: "doc_login_visual",
        body: "Login screenshot shows password reset."
      })
    ]);
    const first = new JsonFileVisualVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 12,
      now: () => FIXED_NOW,
      pretty: true
    });

    first.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 12)));

    const reloaded = new JsonFileVisualVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 12,
      now: () => FIXED_NOW
    });
    const result = reloaded.findNearestVisualVectors({
      vectors: visualVectorsForText("overdue invoice", 12),
      filter: makeIndexFilter(),
      topK: 1
    });

    assert.equal(reloaded.capabilities.durable, true);
    assert.equal(reloaded.capabilities.storageKind, "json_file");
    assert.equal(reloaded.visualVectorCount(), chunks.length);
    assert.equal(result.candidates[0]?.chunk.documentId, "doc_invoice_visual");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reloaded durable visual vector store preserves access-filter enforcement", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-visual-vectors-"));
  try {
    const filePath = path.join(directory, "visual-vectors.json");
    const restricted = makeDocument({
      id: "doc_visual_restricted",
      accessScope: {
        tenantId: "tenant_1",
        namespaceId: "test-namespace",
        roles: ["finance_admin"]
      },
      body: "Invoice screenshot for finance admins only."
    });
    const { chunkIndex, chunks } = makeChunkIndex([restricted]);
    const first = new JsonFileVisualVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 8,
      now: () => FIXED_NOW
    });

    first.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 8)));

    const reloaded = new JsonFileVisualVectorStore({
      filePath,
      chunkStore: chunkIndex,
      dimensions: 8,
      now: () => FIXED_NOW
    });
    const denied = reloaded.findNearestVisualVectors({
      vectors: visualVectorsForText("invoice finance", 8),
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

test("rejects invalid durable visual vector snapshots before serving reads", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-visual-vectors-"));
  try {
    const filePath = path.join(directory, "visual-vectors.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, vectors: {} }), "utf8");

    assert.throws(
      () =>
        new JsonFileVisualVectorStore({
          filePath,
          chunkStore: new InMemoryRagIndex({ now: () => FIXED_NOW }),
          dimensions: 3,
          now: () => FIXED_NOW
        }),
      /Invalid visual vector snapshot/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed visual vector records during durable reload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-visual-vectors-"));
  try {
    const filePath = path.join(directory, "visual-vectors.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        vectors: [
          {
            visualVector: {
              id: "bad_visual_vector",
              chunkId: "chunk_1",
              documentId: "doc_1",
              tenantId: "tenant_1",
              namespaceId: "test-namespace",
              textHash: "hash",
              embeddingModel: "model",
              dimensions: 3,
              vectors: [[1, 2]],
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
        new JsonFileVisualVectorStore({
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

function vectorForChunk(chunk: RagChunk, dimensions: number): VisualChunkVector {
  return {
    id: `visual_${chunk.id}`,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    tenantId: chunk.accessScope.tenantId,
    namespaceId: chunk.namespaceId,
    textHash: chunk.textHash,
    embeddingModel: "test-visual",
    dimensions,
    vectors: visualVectorsForText(chunk.text, dimensions),
    embeddedAt: FIXED_NOW,
    visualAssetId: `asset_${chunk.id}`,
    pageNumber: 1
  };
}

function makeChunkIndex(documents: readonly RagDocument[]): {
  readonly chunkIndex: InMemoryRagIndex;
  readonly chunks: readonly RagChunk[];
} {
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks: RagChunk[] = [];

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
