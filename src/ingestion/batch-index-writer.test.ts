import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { IndexChunkOptions } from "../indexing/index-types.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import { BatchIndexWriter } from "./batch-index-writer.js";

test("batch index writer writes documents and accepted chunks", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_batch_index",
    body: "Batch index writer accepts this policy document."
  });
  const chunks = chunkDocument({ document }).chunks;

  const result = await new BatchIndexWriter({
    documentStore: index,
    chunkStore: index
  }).write({
    documents: [{ document, chunks }],
    indexedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.acceptedDocuments.map((accepted) => accepted.id),
    ["doc_batch_index"]
  );
  assert.equal(result.acceptedChunks.length, chunks.length);
  assert.equal(result.failedDocuments.length, 0);
  assert.equal(index.findDocuments(makeIndexFilter()).length, 1);
  assert.equal(index.findChunks(makeIndexFilter()).length, chunks.length);
});

test("batch index writer rolls back document when chunk validation fails", async () => {
  const index = new ValidationThrowingChunkIndex({ now: () => FIXED_NOW });
  const document = makeDocument({
    id: "doc_bad_chunk",
    body: "Batch index writer rollback document."
  });
  const chunks = chunkDocument({ document }).chunks;

  const result = await new BatchIndexWriter({
    documentStore: index,
    chunkStore: index
  }).write({
    documents: [{ document, chunks }],
    indexedAt: FIXED_NOW
  });

  assert.equal(result.acceptedDocuments.length, 0);
  assert.equal(result.failedDocuments[0]?.code, "chunk_index_validation_failed");
  assert.equal(result.failedDocuments[0]?.rolledBack, true);
  assert.equal(index.findDocuments(makeIndexFilter()).length, 0);
  assert.equal(index.findChunks(makeIndexFilter()).length, 0);
});

class ValidationThrowingChunkIndex extends InMemoryRagIndex {
  override addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly never[] {
    if (documentId === "doc_bad_chunk") {
      throw new Error(
        "Chunks rejected by index validation:\ntext: Chunk exceeds maxCharacters=1800."
      );
    }

    super.addChunks(documentId, chunks, options);
    return [];
  }
}
