import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { visualVectorsForText } from "../embeddings/fake-visual-embedding-adapter.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { LayoutBox } from "../documents/layout.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { runVisualVectorStoreContract } from "../test-support/visual-vector-store-contract.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import { InMemoryVisualVectorStore, type VisualChunkVector } from "./visual-vector-store.js";

const BOX: LayoutBox = {
  pageNumber: 2,
  x: 10,
  y: 20,
  width: 120,
  height: 60,
  unit: "pixel"
};

runVisualVectorStoreContract({
  name: "InMemoryVisualVectorStore",
  dimensions: 8,
  createStore: ({ chunkStore, dimensions }) =>
    new InMemoryVisualVectorStore({
      chunkStore,
      dimensions,
      now: () => FIXED_NOW
    })
});

test("indexes visual chunk vectors and finds late-interaction matches", () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_dashboard",
      body: "Dashboard screenshot shows overdue invoices and payment status."
    }),
    makeDocument({
      id: "doc_login",
      body: "Login screenshot shows password reset and account recovery."
    })
  ]);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 16,
    now: () => FIXED_NOW
  });

  store.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 16)));

  const result = store.findNearestVisualVectors({
    vectors: visualVectorsForText("overdue invoices", 16),
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_dashboard");
  assert.equal(result.candidates[0]?.rank, 1);
  assert.equal(result.candidates[0]?.visualVector.visualAsset?.title, "Dashboard visual");
  assert.equal(result.candidates[0]?.visualVector.visualAsset?.sheetName, "Model");
  assert.equal(result.candidates[0]?.reasons.includes("visual_late_interaction_maxsim"), true);
});

test("visual vector store resolves every match through chunk access filters", () => {
  const restricted = makeDocument({
    id: "doc_restricted_visual",
    body: "Dashboard screenshot for finance admins only.",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      roles: ["finance_admin"]
    }
  });
  const { chunkIndex, chunks } = makeChunkIndex([restricted]);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 8,
    now: () => FIXED_NOW
  });

  store.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 8)));

  const denied = store.findNearestVisualVectors({
    vectors: visualVectorsForText("dashboard finance", 8),
    filter: makeIndexFilter({
      principal: makePrincipal({ roles: ["support"] })
    }),
    topK: 5,
    includeRejected: true
  });

  assert.equal(denied.candidates.length, 0);
  assert.equal(denied.rejected[0]?.code, "access_denied_or_missing_chunk");
});

test("visual vector store rejects stale vectors whose chunk hash changed", () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_stale_visual",
      body: "Dashboard screenshot for stale visual vector test."
    })
  ]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  store.addVisualChunkVectors([
    {
      ...vectorForChunk(chunk, 3),
      textHash: "wrong_hash"
    }
  ]);

  const result = store.findNearestVisualVectors({
    vectors: [[1, 0, 0]],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "stale_vector");
});

test("visual vector store rejects candidates from a different embedding model", () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  store.addVisualChunkVectors([
    {
      ...vectorForChunk(chunk, 3),
      embeddingModel: "old-visual-model",
      embeddingProvider: "fake-visual",
      embeddingConfigHash: "old-visual-hash"
    }
  ]);

  const result = store.findNearestVisualVectors({
    vectors: visualVectorsForText(chunk.text, 3),
    filter: makeIndexFilter(),
    topK: 1,
    embeddingModel: "new-visual-model",
    embeddingProvider: "fake-visual",
    embeddingConfigHash: "new-visual-hash",
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "embedding_identity_mismatch");
});

test("visual vector store rejects legacy vectors missing required embedding config hash", () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  store.addVisualChunkVectors([
    {
      ...vectorForChunk(chunk, 3),
      embeddingModel: "same-visual-model"
    }
  ]);

  const result = store.findNearestVisualVectors({
    vectors: visualVectorsForText(chunk.text, 3),
    filter: makeIndexFilter(),
    topK: 1,
    embeddingModel: "same-visual-model",
    embeddingProvider: "provider",
    embeddingConfigHash: "required-visual-hash",
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "embedding_identity_mismatch");
});

test("visual vector store rejects dimension mismatches and invalid layout evidence", () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const store = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: 3,
    now: () => FIXED_NOW
  });

  assert.throws(
    () =>
      store.addVisualChunkVectors([
        {
          ...vectorForChunk(chunk, 3),
          vectors: [[1, 0]]
        }
      ]),
    /dimensions must match vector length/
  );

  assert.throws(
    () =>
      store.addVisualChunkVectors([
        {
          ...vectorForChunk(chunk, 3),
          id: "bad_box",
          boundingBoxes: [{ ...BOX, width: -1 }]
        }
      ]),
    /boundingBoxes must be finite/
  );

  assert.throws(
    () =>
      store.addVisualChunkVectors([
        {
          ...vectorForChunk(chunk, 3),
          id: "bad_asset_metadata",
          visualAsset: {
            id: `asset_${chunk.id}`,
            title: " "
          }
        }
      ]),
    /visualAsset title cannot be blank/
  );
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
    visualAsset: {
      id: `asset_${chunk.id}`,
      kind: "figure",
      mediaType: "image/png",
      pageNumber: BOX.pageNumber,
      title: "Dashboard visual",
      sheetName: "Model",
      anchorCell: "R2C5"
    },
    pageNumber: BOX.pageNumber,
    layoutRegionIds: [`region_${chunk.id}`],
    boundingBoxes: [BOX]
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
