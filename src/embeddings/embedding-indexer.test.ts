import test from "node:test";
import assert from "node:assert/strict";

import type { RagChunk } from "../documents/chunk.js";
import type { IndexOperationResult } from "../indexing/index-types.js";
import type {
  ChunkVector,
  VectorSearchRequest,
  VectorSearchResult,
  VectorSnapshot,
  VectorStore
} from "../indexing/vector-store.js";
import { hashText } from "../shared/hash.js";
import { EmbeddingIndexer } from "./embedding-indexer.js";
import type { EmbeddingAdapter, EmbeddingRequest } from "./embedding-types.js";

test("embedding indexer uses enriched searchable embedding text when present", async () => {
  const adapter = new CapturingEmbeddingAdapter();
  const vectorStore = new CapturingVectorStore();
  const chunk = fixtureChunk({
    text: "North America 120",
    searchableEmbeddingText: [
      "Table row",
      "Table: Revenue by Region",
      "Columns: Region, Revenue",
      "Row: North America, 120",
      "Page: 3"
    ].join("\n")
  });

  await new EmbeddingIndexer({
    adapter,
    vectorStore,
    now: () => "2026-06-27T00:00:00.000Z"
  }).indexChunks({ chunks: [chunk] });

  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0]?.inputs[0]?.text, chunk.metadata?.["searchableEmbeddingText"]);
  assert.equal(vectorStore.vectors[0]?.textHash, chunk.textHash);
});

class CapturingEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "capturing-embedding-adapter";
  readonly provider = "test";
  readonly modelName = "capturing-model";
  readonly dimensions = 2;
  readonly requests: EmbeddingRequest[] = [];

  async embed(request: EmbeddingRequest) {
    this.requests.push(request);
    return {
      status: "succeeded" as const,
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings: request.inputs.map((input) => ({
        id: input.id,
        vector: [1, 0] as const,
        textHash: hashText(input.text)
      })),
      usage: {
        inputCount: request.inputs.length,
        totalInputCharacters: request.inputs.reduce((sum, input) => sum + input.text.length, 0)
      },
      warnings: []
    };
  }
}

class CapturingVectorStore implements VectorStore {
  readonly capabilities = {
    storageKind: "memory" as const,
    durable: false,
    enforcesAccessFilters: true,
    supportsCosineSimilarity: true,
    dimensions: 2
  };
  readonly vectors: ChunkVector[] = [];

  addChunkVectors(vectors: readonly ChunkVector[]): readonly IndexOperationResult[] {
    this.vectors.push(...vectors);
    return vectors.map((vector) => ({
      accepted: true,
      id: vector.id,
      message: "indexed"
    }));
  }

  deleteVectorsForDocument(): number {
    return 0;
  }

  findNearestVectors(_request: VectorSearchRequest): VectorSearchResult {
    return {
      candidates: [],
      rejected: [],
      candidatePoolSize: 0
    };
  }

  snapshot(): VectorSnapshot {
    return {
      version: 1,
      vectors: this.vectors.map((vector) => ({
        vector,
        indexedAt: "2026-06-27T00:00:00.000Z"
      }))
    };
  }

  vectorCount(): number {
    return this.vectors.length;
  }
}

function fixtureChunk(input: {
  readonly text: string;
  readonly searchableEmbeddingText: string;
}): RagChunk {
  return {
    id: "chunk_table_row",
    documentId: "doc_table",
    namespaceId: "generic-docs",
    text: input.text,
    index: 0,
    textHash: hashText(input.text),
    characterStart: 0,
    characterEnd: input.text.length,
    safetyFlags: [],
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Table",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    citation: {
      sourceId: "docs",
      chunkId: "chunk_table_row",
      title: "Table",
      locator: `chars:0-${input.text.length}`
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    metadata: {
      searchableUnitType: "table_row_chunk",
      searchableEmbeddingText: input.searchableEmbeddingText
    }
  };
}
