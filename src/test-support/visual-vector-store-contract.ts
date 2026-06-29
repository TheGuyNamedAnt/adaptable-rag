import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import { visualVectorsForText } from "../embeddings/fake-visual-embedding-adapter.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "./fixtures.js";

export interface VisualVectorStoreContractOptions {
  readonly name: string;
  readonly dimensions: number;
  readonly createStore: (input: {
    readonly chunkStore: InMemoryRagIndex;
    readonly dimensions: number;
  }) => VisualVectorStore;
}

export function runVisualVectorStoreContract(options: VisualVectorStoreContractOptions): void {
  test(`${options.name}: visual vector store enforces plug-and-play retrieval contracts`, async () => {
    const document = makeDocument({
      id: "doc_visual_contract",
      body: "Dashboard image shows contract revenue and renewal risk."
    });
    const chunkStore = new InMemoryRagIndex({ now: () => FIXED_NOW });
    const chunks = chunkDocument({ document }).chunks;
    const [chunk] = chunks;
    assert.ok(chunk);
    chunkStore.addDocument(document, { indexedAt: FIXED_NOW });
    chunkStore.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });

    const store = options.createStore({ chunkStore, dimensions: options.dimensions });
    const base = {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      tenantId: chunk.accessScope.tenantId,
      namespaceId: chunk.namespaceId,
      textHash: chunk.textHash,
      embeddingModel: "contract-visual-model",
      embeddingProvider: "contract-visual-provider",
      dimensions: options.dimensions,
      vectors: visualVectorsForText(chunk.text, options.dimensions),
      embeddedAt: FIXED_NOW
    } as const;

    await store.addVisualChunkVectors(
      [
        {
          ...base,
          id: `visual_hash_a_${chunk.id}`,
          embeddingConfigHash: "visual_hash_a"
        },
        {
          ...base,
          id: `visual_hash_b_${chunk.id}`,
          embeddingConfigHash: "visual_hash_b"
        }
      ],
      { overwriteMode: "replace", indexedAt: FIXED_NOW }
    );

    const result = await store.findNearestVisualVectors({
      vectors: visualVectorsForText(chunk.text, options.dimensions),
      filter: makeIndexFilter(),
      topK: 5,
      embeddingModel: "contract-visual-model",
      embeddingProvider: "contract-visual-provider",
      embeddingConfigHash: "visual_hash_a",
      includeRejected: true
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.visualVector.embeddingConfigHash, "visual_hash_a");
    assert.equal(
      result.rejected.some((rejection) => rejection.code === "embedding_identity_mismatch"),
      true
    );

    assert.equal(await store.deleteVisualVectorsForDocument(document.id), 2);
    assert.equal(await store.visualVectorCount(), 0);
  });
}
