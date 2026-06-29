import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { VectorStore } from "../indexing/vector-store.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "./fixtures.js";

export interface VectorStoreContractOptions {
  readonly name: string;
  readonly dimensions: number;
  readonly createStore: (input: {
    readonly chunkStore: InMemoryRagIndex;
    readonly dimensions: number;
  }) => VectorStore;
}

export function runVectorStoreContract(options: VectorStoreContractOptions): void {
  test(`${options.name}: vector store enforces plug-and-play retrieval contracts`, async () => {
    const document = makeDocument({
      id: "doc_contract",
      body: "Contract retrieval policy for vector store adapters."
    });
    const chunkStore = new InMemoryRagIndex({ now: () => FIXED_NOW });
    const chunks = chunkDocument({ document }).chunks;
    const [chunk] = chunks;
    assert.ok(chunk);
    chunkStore.addDocument(document, { indexedAt: FIXED_NOW });
    chunkStore.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    const vectorStore = options.createStore({
      chunkStore,
      dimensions: options.dimensions
    });
    await vectorStore.addChunkVectors(
      [
        {
          id: `hash_a_${chunk.id}`,
          chunkId: chunk.id,
          documentId: chunk.documentId,
          tenantId: chunk.accessScope.tenantId,
          namespaceId: chunk.namespaceId,
          textHash: chunk.textHash,
          embeddingModel: "contract-model",
          embeddingProvider: "contract-provider",
          embeddingConfigHash: "hash_a",
          dimensions: options.dimensions,
          vector: unitVector(options.dimensions),
          embeddedAt: FIXED_NOW
        },
        {
          id: `hash_b_${chunk.id}`,
          chunkId: chunk.id,
          documentId: chunk.documentId,
          tenantId: chunk.accessScope.tenantId,
          namespaceId: chunk.namespaceId,
          textHash: chunk.textHash,
          embeddingModel: "contract-model",
          embeddingProvider: "contract-provider",
          embeddingConfigHash: "hash_b",
          dimensions: options.dimensions,
          vector: unitVector(options.dimensions),
          embeddedAt: FIXED_NOW
        }
      ],
      { overwriteMode: "replace", indexedAt: FIXED_NOW }
    );

    const matched = await vectorStore.findNearestVectors({
      vector: unitVector(options.dimensions),
      filter: makeIndexFilter(),
      topK: 5,
      embeddingModel: "contract-model",
      embeddingProvider: "contract-provider",
      embeddingConfigHash: "hash_a",
      includeRejected: true
    });

    assert.equal(matched.candidates.length, 1);
    assert.equal(matched.candidates[0]?.vector.embeddingConfigHash, "hash_a");
    assert.equal(
      matched.rejected.some((rejection) => rejection.code === "embedding_identity_mismatch"),
      true
    );

    assert.equal(await vectorStore.deleteVectorsForDocument(document.id), 2);
    assert.equal(await vectorStore.vectorCount(), 0);
  });
}

function unitVector(dimensions: number): readonly number[] {
  return [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
}
