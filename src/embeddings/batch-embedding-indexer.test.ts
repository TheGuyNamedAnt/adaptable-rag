import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { FakeEmbeddingAdapter } from "./fake-embedding-adapter.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { FIXED_NOW, makeDocument } from "../test-support/fixtures.js";
import { BatchEmbeddingIndexer } from "./batch-embedding-indexer.js";

test("batch embedding indexer indexes chunk and layout relation vectors together", async () => {
  const body = "Refund table lists approval rules. Caption explains refund table.";
  const layout: DocumentLayout = {
    parserId: "test-layout",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 800,
        height: 1000,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "table_1",
        kind: "table",
        pageNumber: 1,
        text: "Refund table lists approval rules.",
        characterStart: 0,
        characterEnd: 34
      },
      {
        id: "caption_1",
        kind: "table_caption",
        pageNumber: 1,
        text: "Caption explains refund table.",
        characterStart: 35,
        characterEnd: body.length
      }
    ],
    relations: [
      {
        id: "rel_caption_table",
        kind: "caption_for",
        fromRegionId: "caption_1",
        toRegionId: "table_1"
      }
    ]
  };
  const document: RagDocument = {
    ...makeDocument({
      id: "doc_batch_embedding",
      body
    }),
    layout
  };
  const chunks = chunkDocument({ document }).chunks;
  const chunkStore = new InMemoryRagIndex({ now: () => FIXED_NOW });
  chunkStore.addDocument(document, { indexedAt: FIXED_NOW });
  chunkStore.addChunks(document.id, chunks, { indexedAt: FIXED_NOW });
  const vectorStore = new InMemoryVectorStore({
    chunkStore,
    dimensions: 8,
    now: () => FIXED_NOW
  });

  const result = await new BatchEmbeddingIndexer({
    adapter: new FakeEmbeddingAdapter({ dimensions: 8 }),
    vectorStore,
    now: () => FIXED_NOW
  }).index({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.indexedVectorCount, chunks.length);
  assert.equal(result.candidateRelationCount, 1);
  assert.equal(result.indexedRelationVectorCount, 1);
  assert.equal(vectorStore.vectorCount(), chunks.length + 1);
  assert.deepEqual(result.warnings, []);
});
