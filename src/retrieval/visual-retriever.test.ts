import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import {
  FakeVisualEmbeddingAdapter,
  visualVectorsForText
} from "../embeddings/fake-visual-embedding-adapter.js";
import { embeddingIdentityFor } from "../embeddings/embedding-identity.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { LayoutBox } from "../documents/layout.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import {
  InMemoryVisualVectorStore,
  type VisualChunkVector
} from "../indexing/visual-vector-store.js";
import { FakeModelAdapter } from "../model/fake-model-adapter.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { RagAnswerRuntime } from "../runtime/rag-answer-runtime.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { VisualRetriever } from "./visual-retriever.js";

const BOX: LayoutBox = {
  pageNumber: 3,
  x: 42,
  y: 88,
  width: 300,
  height: 120,
  unit: "pixel"
};

test("retrieves visual matches with layout citations and redacted trace fields", async () => {
  const { retriever } = makeVisualRetriever([
    makeDocument({
      id: "doc_invoice_screen",
      body: "Invoice dashboard screenshot shows overdue balances and payment status."
    }),
    makeDocument({
      id: "doc_login_screen",
      body: "Login screenshot shows account recovery and password reset."
    })
  ]);

  const result = await retriever.retrieve({
    query: "overdue invoice dashboard",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "visual_retrieval_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates[0]?.chunk.documentId, "doc_invoice_screen");
  assert.equal(result.candidates[0]?.citation.pageNumber, BOX.pageNumber);
  assert.equal(
    result.candidates[0]?.citation.visualAssetId,
    `asset_${result.candidates[0]?.chunk.id}`
  );
  assert.equal(result.candidates[0]?.citation.visualAsset?.title, "Invoice dashboard");
  assert.equal(result.candidates[0]?.citation.visualAsset?.sheetName, "Model");
  assert.equal(result.candidates[0]?.citation.visualAsset?.anchorCell, "R2C5");
  assert.deepEqual(result.candidates[0]?.citation.boundingBoxes, [BOX]);
  assert.equal(result.candidates[0]?.reasons.includes("visual_late_interaction_maxsim"), true);
  assert.deepEqual(result.candidates[0]?.matchedTerms, []);
  assert.equal(result.trace.mode, "visual");
  assert.equal(result.trace.retrievalId, "visual_retrieval_test");
  assert.deepEqual(result.trace.searchTermHashes, []);
  assert.equal(result.trace.returnedCount, 2);
});

test("visual retrieval expands the pool and avoids duplicate visual chunks", async () => {
  const { retriever, chunkIndex, vectorStore, adapter } = makeVisualRetriever([
    makeDocument({
      id: "doc_invoice_dashboard",
      body: "Invoice dashboard screenshot shows overdue balances and payment status."
    }),
    makeDocument({
      id: "doc_invoice_trace",
      body: "Invoice dashboard trace keeps visual citations and finance review evidence."
    })
  ]);
  const firstChunk = chunkIndex.snapshot().chunks[0]?.chunk;
  assert.ok(firstChunk);
  vectorStore.addVisualChunkVectors([
    {
      ...vectorForChunk(firstChunk, adapter),
      id: `visual_duplicate_${firstChunk.id}`,
      visualAssetId: "asset_duplicate_invoice_dashboard"
    }
  ]);

  const result = await retriever.retrieve({
    query: "invoice dashboard visual finance review",
    filter: makeIndexFilter(),
    topK: 2,
    retrievalId: "visual_diverse_pool_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(new Set(result.candidates.map((candidate) => candidate.chunk.id)).size, 2);
  assert.deepEqual(
    new Set(result.candidates.map((candidate) => candidate.chunk.documentId)),
    new Set(["doc_invoice_dashboard", "doc_invoice_trace"])
  );
});

test("advertises honest visual-only retrieval capabilities", () => {
  const { retriever } = makeVisualRetriever([makeDocument()]);

  assert.deepEqual(retriever.capabilities.modes, ["visual"]);
  assert.equal(retriever.capabilities.supportsVectorSearch, true);
  assert.equal(retriever.capabilities.supportsHybridSearch, false);
  assert.equal(retriever.capabilities.supportsVisualSearch, true);
});

test("visual retriever refuses to serve keyword mode", async () => {
  const { retriever } = makeVisualRetriever([makeDocument()]);

  await assert.rejects(
    () =>
      retriever.retrieve({
        query: "invoice",
        mode: "keyword",
        filter: makeIndexFilter(),
        topK: 1
      }),
    /cannot serve retrieval mode/
  );
});

test("visual retriever cannot return chunks denied by the shared index filter", async () => {
  const restrictedPrincipal = makePrincipal({ roles: ["finance_admin"] });
  const { retriever } = makeVisualRetriever([
    makeDocument({
      id: "doc_visual_finance",
      body: "Invoice dashboard screenshot for finance admins only.",
      accessScope: {
        tenantId: restrictedPrincipal.tenantId,
        namespaceId: "test-namespace",
        roles: ["finance_admin"]
      }
    })
  ]);

  const result = await retriever.retrieve({
    query: "invoice dashboard",
    filter: makeIndexFilter({
      principal: makePrincipal({ roles: ["support"] })
    }),
    topK: 1,
    includeRejected: true,
    retrievalId: "visual_denied_test",
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "access_denied_or_missing_chunk");
  assert.equal(result.trace.returnedCount, 0);
  assert.equal(result.trace.rejectedCount, 1);
});

test("runtime can answer with a profile configured for visual retrieval", async () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      mode: "visual"
    }
  });
  const principal = makePrincipal({
    namespaceIds: [profile.namespaceId],
    roles: ["reader"],
    tags: ["curated", "docs"]
  });
  const { retriever } = makeVisualRetriever([
    makeDocument({
      id: "doc_visual_refund",
      namespaceId: profile.namespaceId,
      body: "Refund dashboard screenshot shows billing review status.",
      accessScope: {
        tenantId: principal.tenantId,
        namespaceId: profile.namespaceId,
        roles: ["reader"],
        tags: ["curated", "docs"]
      }
    })
  ]);
  const runtime = new RagAnswerRuntime({
    retriever,
    now: () => FIXED_NOW
  });

  const result = await runtime.answer({
    profile,
    question: "What does the refund dashboard show?",
    filter: makeIndexFilter({
      namespaceId: profile.namespaceId,
      principal,
      tenantId: principal.tenantId
    }),
    model: new FakeModelAdapter({ now: () => FIXED_NOW }),
    requestedAt: FIXED_NOW
  });

  assert.equal(result.status, "succeeded");
  assert.equal("retrieval" in result ? result.retrieval.trace.mode : undefined, "visual");
  assert.equal("context" in result ? result.context.evidence.status : undefined, "answerable");
});

function makeVisualRetriever(documents: readonly RagDocument[]): {
  readonly retriever: VisualRetriever;
  readonly chunkIndex: InMemoryRagIndex;
  readonly vectorStore: InMemoryVisualVectorStore;
  readonly adapter: FakeVisualEmbeddingAdapter;
} {
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks: RagChunk[] = [];
  for (const document of documents) {
    const documentChunks = chunkDocument({ document }).chunks;
    chunkIndex.addDocument(document);
    chunkIndex.addChunks(document.id, documentChunks);
    chunks.push(...documentChunks);
  }

  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 24 });
  const vectorStore = new InMemoryVisualVectorStore({
    chunkStore: chunkIndex,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  vectorStore.addVisualChunkVectors(chunks.map((chunk) => vectorForChunk(chunk, adapter)));

  return {
    retriever: new VisualRetriever({
      embeddingAdapter: adapter,
      vectorStore,
      now: () => FIXED_NOW
    }),
    chunkIndex,
    vectorStore,
    adapter
  };
}

function vectorForChunk(chunk: RagChunk, adapter: FakeVisualEmbeddingAdapter): VisualChunkVector {
  const identity = embeddingIdentityFor({
    provider: adapter.provider,
    modelName: adapter.modelName,
    dimensions: adapter.dimensions,
    adapterId: adapter.id
  });
  return {
    id: `visual_${chunk.id}`,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    tenantId: chunk.accessScope.tenantId,
    namespaceId: chunk.namespaceId,
    textHash: chunk.textHash,
    embeddingModel: adapter.modelName,
    embeddingProvider: adapter.provider,
    embeddingConfigHash: identity.embeddingConfigHash,
    dimensions: adapter.dimensions,
    vectors: visualVectorsForText(chunk.text, adapter.dimensions),
    embeddedAt: FIXED_NOW,
    visualAssetId: `asset_${chunk.id}`,
    visualAsset: {
      id: `asset_${chunk.id}`,
      kind: "figure",
      mediaType: "image/png",
      pageNumber: BOX.pageNumber,
      title: "Invoice dashboard",
      sheetName: "Model",
      anchorCell: "R2C5"
    },
    pageNumber: BOX.pageNumber,
    layoutRegionIds: [`region_${chunk.id}`],
    boundingBoxes: [BOX]
  };
}
