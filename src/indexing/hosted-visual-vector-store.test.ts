import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { LayoutBox } from "../documents/layout.js";
import { visualVectorsForText } from "../embeddings/fake-visual-embedding-adapter.js";
import { cosineSimilarity } from "../shared/vector-math.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import {
  type HostedVectorQueryRequest,
  type HostedVectorSearchMatch,
  type HostedVectorStoreTransport,
  type HostedVectorUpsertRequest
} from "./hosted-vector-store.js";
import { HostedVisualVectorStore } from "./hosted-visual-vector-store.js";
import { InMemoryRagIndex } from "./in-memory-index.js";
import type { IndexOperationResult } from "./index-types.js";
import type { ChunkVector } from "./vector-store.js";
import type { VisualChunkVector } from "./visual-vector-store.js";

const BOX: LayoutBox = {
  pageNumber: 2,
  x: 10,
  y: 20,
  width: 120,
  height: 60,
  unit: "pixel"
};

class MockHostedVisualVectorTransport {
  readonly queryRequests: HostedVectorQueryRequest[] = [];
  vectors: ChunkVector[] = [];
  private forcedMatches: readonly HostedVectorSearchMatch[] | undefined;

  async upsert(
    input: HostedVectorUpsertRequest
  ): Promise<{ readonly results: readonly IndexOperationResult[] }> {
    const results: IndexOperationResult[] = [];

    for (const vector of input.vectors) {
      const existingIndex = this.vectors.findIndex((stored) => stored.id === vector.id);
      if (existingIndex >= 0 && input.overwriteMode !== "replace") {
        throw new Error(`Hosted visual patch vector "${vector.id}" is already indexed.`);
      }

      if (existingIndex >= 0) {
        this.vectors[existingIndex] = vector;
      } else {
        this.vectors.push(vector);
      }

      results.push({
        accepted: true,
        id: vector.id,
        message:
          existingIndex >= 0 ? "Hosted visual patch replaced." : "Hosted visual patch indexed."
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
    readonly matches: readonly HostedVectorSearchMatch[];
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
        hostedVisualMatch(
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

  forceNextMatches(matches: readonly HostedVectorSearchMatch[]): void {
    this.forcedMatches = matches;
  }
}

test("hosted visual vector store indexes patch vectors and returns visual records", async () => {
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
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 16,
    now: () => FIXED_NOW
  });

  const vectors = chunks.map((chunk) => vectorForChunk(chunk, 16));
  const indexed = await store.addVisualChunkVectors(vectors);

  const result = await store.findNearestVisualVectors({
    vectors: visualVectorsForText("overdue invoices", 16),
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(store.capabilities.storageKind, "hosted");
  assert.equal(store.capabilities.durable, true);
  assert.equal(indexed.length, chunks.length);
  assert.equal(
    indexed.every((entry) => entry.accepted),
    true
  );
  assert.equal(transport.vectors.length > chunks.length, true);
  assert.equal(await store.visualVectorCount(), transport.vectors.length);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_dashboard");
  assert.equal(result.candidates[0]?.visualVector.pageNumber, BOX.pageNumber);
  assert.equal(result.candidates[0]?.visualVector.visualAsset?.title, "Dashboard visual");
  assert.equal(result.candidates[0]?.visualVector.visualAsset?.anchorCell, "R2C5");
  assert.deepEqual(result.candidates[0]?.visualVector.boundingBoxes, [BOX]);
  assert.equal(
    result.candidates[0]?.reasons.includes("hosted_visual_late_interaction_maxsim"),
    true
  );
});

test("hosted visual query does not send principal claims to the remote transport", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 8)));

  await store.findNearestVisualVectors({
    vectors: visualVectorsForText("refund", 8),
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(transport.queryRequests.length, visualVectorsForText("refund", 8).length);
  const serializedRemoteRequest = JSON.stringify(transport.queryRequests[0]);
  assert.equal(serializedRemoteRequest.includes("tenant_1"), true);
  assert.equal(serializedRemoteRequest.includes("user_1"), false);
  assert.equal(serializedRemoteRequest.includes("support_team"), false);
  assert.equal(serializedRemoteRequest.includes("roles"), false);
});

test("hosted visual vector store denies matches that fail local chunk access", async () => {
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
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 8)));

  const denied = await store.findNearestVisualVectors({
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

test("hosted visual vector store rejects stale and cross-tenant remote metadata", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([
    makeDocument({
      id: "doc_stale_visual",
      body: "Dashboard screenshot for stale hosted visual vector test."
    })
  ]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors([vectorForChunk(chunk, 8)]);
  const patchId = patchVectorId(`visual_${chunk.id}`, 0);

  transport.replaceVector(patchId, { textHash: "wrong_hash" });
  transport.forceNextMatches([hostedVisualMatch(requiredVector(transport, patchId), 1)]);
  const stale = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(stale.candidates.length, 0);
  assert.equal(stale.rejected[0]?.code, "stale_vector");

  transport.replaceVector(patchId, { textHash: chunk.textHash, tenantId: "tenant_2" });
  transport.forceNextMatches([hostedVisualMatch(requiredVector(transport, patchId), 1)]);
  const crossTenant = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(crossTenant.candidates.length, 0);
  assert.equal(crossTenant.rejected[0]?.code, "access_denied_or_missing_chunk");
});

test("hosted visual vector store rejects malformed visual patch metadata", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors([vectorForChunk(chunk, 8)]);
  const patchId = patchVectorId(`visual_${chunk.id}`, 0);
  const vector = requiredVector(transport, patchId);

  transport.forceNextMatches([
    {
      ...hostedVisualMatch(vector, 1),
      id: "remote_without_visual_metadata",
      metadata: {
        ...vector.metadata,
        visualPatchCount: undefined
      }
    }
  ]);

  const result = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "stale_vector");

  transport.forceNextMatches([
    {
      ...hostedVisualMatch(vector, 1),
      metadata: {
        ...vector.metadata,
        visualAssetJson: JSON.stringify({
          id: `asset_${chunk.id}`,
          uri: "file:///tmp/leak.png"
        })
      }
    }
  ]);

  const unsafeAsset = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });

  assert.equal(unsafeAsset.candidates.length, 0);
  assert.equal(unsafeAsset.rejected[0]?.code, "stale_vector");
});

test("hosted visual vector store covers invalid filters, min score, and unsupported counts", async () => {
  assert.throws(
    () =>
      new HostedVisualVectorStore({
        chunkStore: new InMemoryRagIndex(),
        transport: new MockHostedVisualVectorTransport(),
        dimensions: 0
      }),
    /positive integer/u
  );

  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, 8)));

  const invalidFilter = await store.findNearestVisualVectors({
    vectors: visualVectorsForText("refund", 8),
    filter: makeIndexFilter({ tenantId: "tenant_2" }),
    topK: 1
  });
  assert.equal(invalidFilter.candidates.length, 0);
  assert.equal(invalidFilter.rejected[0]?.code, "invalid_filter");

  const belowThreshold = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("refund", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    candidatePoolLimit: 2,
    minScore: 2,
    includeRejected: true
  });
  assert.equal(belowThreshold.candidates.length, 0);
  assert.equal(belowThreshold.rejected[0]?.code, "no_visual_match");
  assert.equal(transport.queryRequests.at(-1)?.topK, 2);
  assert.equal(transport.queryRequests.at(-1)?.candidatePoolLimit, 2);
  assert.equal(transport.queryRequests.at(-1)?.minScore, 2);

  const noCountTransport: HostedVectorStoreTransport = {
    upsert: transport.upsert.bind(transport),
    deleteByDocument: transport.deleteByDocument.bind(transport),
    query: transport.query.bind(transport)
  };
  const noCountStore = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport: noCountTransport,
    dimensions: 8
  });
  await assert.rejects(() => noCountStore.visualVectorCount(), /does not expose vector counts/u);
  await assert.rejects(() => store.deleteVisualVectorsForDocument(" "), /documentId/u);
});

test("hosted visual vector store rejects invalid remote patch payloads", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors([vectorForChunk(chunk, 8)]);
  const patchId = patchVectorId(`visual_${chunk.id}`, 0);
  const vector = requiredVector(transport, patchId);

  transport.forceNextMatches([
    {
      ...hostedVisualMatch(vector, 1),
      vector: [1, 0],
      dimensions: 8
    }
  ]);
  const dimensions = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });
  assert.equal(dimensions.candidates.length, 0);
  assert.equal(dimensions.rejected[0]?.code, "vector_dimension_mismatch");

  transport.forceNextMatches([
    {
      ...hostedVisualMatch(vector, 1),
      metadata: {
        ...vector.metadata,
        visualBoundingBoxesJson: "not-json"
      }
    }
  ]);
  const layout = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });
  assert.equal(layout.candidates.length, 0);
  assert.equal(layout.rejected[0]?.code, "stale_vector");
});

test("hosted visual vector store handles parsed ids and inconsistent grouped patches", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors([vectorForChunk(chunk, 8)]);
  const firstPatch = requiredVector(transport, patchVectorId(`visual_${chunk.id}`, 0));
  const secondPatch = requiredVector(transport, patchVectorId(`visual_${chunk.id}`, 1));

  transport.forceNextMatches([
    {
      ...hostedVisualMatch(firstPatch, 1),
      metadata: {
        visualPatchCount: firstPatch.metadata?.["visualPatchCount"] ?? 1
      }
    }
  ]);
  const parsedId = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1
  });
  assert.equal(parsedId.candidates.length, 1);
  assert.equal(parsedId.candidates[0]?.visualVector.id, `visual_${chunk.id}`);

  transport.forceNextMatches([
    hostedVisualMatch(firstPatch, 1),
    {
      ...hostedVisualMatch(secondPatch, 0.9),
      metadata: {
        ...secondPatch.metadata,
        visualAssetId: "different_asset"
      }
    }
  ]);
  const inconsistent = await store.findNearestVisualVectors({
    vectors: [visualVectorsForText("dashboard", 8)[0] ?? []],
    filter: makeIndexFilter(),
    topK: 1,
    includeRejected: true
  });
  assert.equal(inconsistent.candidates.length, 1);
  assert.equal(inconsistent.rejected[0]?.code, "stale_vector");
});

test("hosted visual vector store exposes delete and rejects unsupported snapshots", async () => {
  const { chunkIndex, chunks } = makeChunkIndex([makeDocument()]);
  const [chunk] = chunks;
  assert.ok(chunk);
  const transport = new MockHostedVisualVectorTransport();
  const store = new HostedVisualVectorStore({
    chunkStore: chunkIndex,
    transport,
    dimensions: 8,
    now: () => FIXED_NOW
  });
  await store.addVisualChunkVectors([vectorForChunk(chunk, 8)]);
  const patchCount = transport.vectors.length;

  assert.equal(await store.deleteVisualVectorsForDocument(chunk.documentId), patchCount);
  assert.equal(await store.visualVectorCount(), 0);
  assert.throws(() => store.snapshot(), /does not expose local visual vector snapshots/);
});

function hostedVisualMatch(vector: ChunkVector, score: number): HostedVectorSearchMatch {
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
    reasons: ["mock_hosted_visual_patch_similarity"],
    ...(vector.metadata === undefined ? {} : { metadata: vector.metadata })
  };
}

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

function patchVectorId(visualVectorId: string, patchIndex: number): string {
  return `${visualVectorId}#visual_patch:${patchIndex}`;
}

function requiredVector(transport: MockHostedVisualVectorTransport, vectorId: string): ChunkVector {
  const vector = transport.vectors.find((stored) => stored.id === vectorId);
  assert.ok(vector);
  return vector;
}
