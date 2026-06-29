import assert from "node:assert/strict";
import test from "node:test";

import {
  planVectorGenerationCleanup,
  vectorGenerationInventory
} from "./vector-generation-lifecycle.js";
import type { VectorSnapshot } from "./vector-store.js";
import type { VisualVectorSnapshot } from "./visual-vector-store.js";

test("inventories text vector generations by tenant namespace and embedding config", () => {
  const snapshot: VectorSnapshot = {
    version: 1,
    vectors: [
      vector("v1", "hash_a", "index_a", "doc_1"),
      vector("v2", "hash_a", "index_a", "doc_2"),
      vector("v3", "hash_b", "index_b", "doc_2")
    ]
  };

  const inventory = vectorGenerationInventory(snapshot);
  const cleanup = planVectorGenerationCleanup(snapshot, {
    keepEmbeddingConfigHashes: ["hash_b"],
    tenantId: "tenant_1",
    namespaceId: "namespace_1"
  });

  assert.deepEqual(
    inventory.map((entry) => ({
      hash: entry.embeddingConfigHash,
      indexHash: entry.embeddingIndexConfigHash,
      vectors: entry.vectorCount,
      documents: entry.documentCount
    })),
    [
      { hash: "hash_a", indexHash: "index_a", vectors: 2, documents: 2 },
      { hash: "hash_b", indexHash: "index_b", vectors: 1, documents: 1 }
    ]
  );
  assert.deepEqual(cleanup.deleteVectorIds, ["v1", "v2"]);
  assert.deepEqual(cleanup.keepVectorIds, ["v3"]);
});

test("plans visual vector generation cleanup from visual snapshots", () => {
  const snapshot: VisualVectorSnapshot = {
    version: 1,
    vectors: [
      {
        visualVector: {
          id: "visual_old",
          chunkId: "chunk_1",
          documentId: "doc_1",
          tenantId: "tenant_1",
          namespaceId: "namespace_1",
          textHash: "text_hash",
          embeddingModel: "visual_model",
          embeddingProvider: "visual_provider",
          embeddingConfigHash: "old_visual_hash",
          dimensions: 3,
          vectors: [[1, 0, 0]],
          embeddedAt: "2026-06-23T00:00:00.000Z",
          metadata: { embeddingIndexConfigHash: "old_visual_index_hash" }
        },
        indexedAt: "2026-06-23T00:00:00.000Z"
      },
      {
        visualVector: {
          id: "visual_new",
          chunkId: "chunk_1",
          documentId: "doc_1",
          tenantId: "tenant_1",
          namespaceId: "namespace_1",
          textHash: "text_hash",
          embeddingModel: "visual_model",
          embeddingProvider: "visual_provider",
          embeddingConfigHash: "new_visual_hash",
          dimensions: 3,
          vectors: [[1, 0, 0]],
          embeddedAt: "2026-06-23T00:00:00.000Z",
          metadata: { embeddingIndexConfigHash: "new_visual_index_hash" }
        },
        indexedAt: "2026-06-23T00:00:00.000Z"
      }
    ]
  };

  const cleanup = planVectorGenerationCleanup(snapshot, {
    keepEmbeddingConfigHashes: ["new_visual_hash"]
  });

  assert.equal(vectorGenerationInventory(snapshot).length, 2);
  assert.deepEqual(cleanup.deleteVectorIds, ["visual_old"]);
  assert.deepEqual(cleanup.keepVectorIds, ["visual_new"]);
});

test("plans cleanup for legacy vectors with unknown embedding config hash", () => {
  const snapshot: VectorSnapshot = {
    version: 1,
    vectors: [
      vector("current", "hash_current", "index_current", "doc_1"),
      legacyVector("legacy", "doc_1")
    ]
  };

  const inventory = vectorGenerationInventory(snapshot);
  const cleanup = planVectorGenerationCleanup(snapshot, {
    keepEmbeddingConfigHashes: ["hash_current"]
  });

  assert.deepEqual(
    inventory.map((entry) => ({
      hash: entry.embeddingConfigHash,
      vectors: entry.vectorCount
    })),
    [
      { hash: "hash_current", vectors: 1 },
      { hash: "unknown", vectors: 1 }
    ]
  );
  assert.deepEqual(cleanup.deleteVectorIds, ["legacy"]);
  assert.deepEqual(cleanup.keepVectorIds, ["current"]);
});

function vector(
  id: string,
  embeddingConfigHash: string,
  embeddingIndexConfigHash: string,
  documentId: string
): VectorSnapshot["vectors"][number] {
  return {
    vector: {
      id,
      chunkId: `chunk_${id}`,
      documentId,
      tenantId: "tenant_1",
      namespaceId: "namespace_1",
      textHash: "text_hash",
      embeddingModel: "model",
      embeddingProvider: "provider",
      embeddingConfigHash,
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: "2026-06-23T00:00:00.000Z",
      metadata: { embeddingIndexConfigHash }
    },
    indexedAt: "2026-06-23T00:00:00.000Z"
  };
}

function legacyVector(id: string, documentId: string): VectorSnapshot["vectors"][number] {
  return {
    vector: {
      id,
      chunkId: `chunk_${id}`,
      documentId,
      tenantId: "tenant_1",
      namespaceId: "namespace_1",
      textHash: "text_hash",
      embeddingModel: "model",
      dimensions: 3,
      vector: [1, 0, 0],
      embeddedAt: "2026-06-23T00:00:00.000Z",
      metadata: {}
    },
    indexedAt: "2026-06-23T00:00:00.000Z"
  };
}
