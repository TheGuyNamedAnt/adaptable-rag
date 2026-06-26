import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVectorStore } from "../indexing/vector-store.js";
import { VectorRetriever } from "../retrieval/vector-retriever.js";
import {
  FIXED_NOW,
  makeDocument,
  makeIndexFilter,
  makePrincipal
} from "../test-support/fixtures.js";
import { FakeEmbeddingAdapter } from "./fake-embedding-adapter.js";
import { LayoutRelationIndexer, layoutRelationInputsForChunks } from "./layout-relation-indexer.js";

test("builds relation embedding inputs from validated layout relations", () => {
  const document = relationDocument();
  const chunks = chunkDocument({ document }).chunks;
  const inputs = layoutRelationInputsForChunks([document], chunks);

  assert.equal(inputs.length, 2);
  assert.equal(
    inputs.some(
      (input) =>
        input.relation.kind === "explains" &&
        input.text.includes("Parent LLC owns Child LLC") &&
        input.text.includes("[visual region]")
    ),
    true
  );
});

test("indexes layout relation vectors and retrieves their anchor chunk", async () => {
  const document = relationDocument();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks = chunkDocument({ document }).chunks;
  index.addDocument(document);
  index.addChunks(document.id, chunks);

  const adapter = new FakeEmbeddingAdapter({ dimensions: 32 });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  const relationIndex = await new LayoutRelationIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexRelations({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });
  const retriever = new VectorRetriever({
    embeddingAdapter: adapter,
    vectorStore,
    now: () => FIXED_NOW
  });
  const result = await retriever.retrieve({
    query: "what explains the ownership figure parent child llc",
    filter: makeIndexFilter(),
    topK: 1,
    requestedAt: FIXED_NOW
  });

  assert.equal(relationIndex.candidateRelationCount, 2);
  assert.equal(relationIndex.indexedRelationVectorCount, 2);
  assert.equal(await vectorStore.vectorCount(), 2);
  assert.equal(result.candidates[0]?.chunk.documentId, "doc_relation_visual");
  assert.deepEqual(result.candidates[0]?.chunk.layoutRegionIds, [
    "region_caption",
    "region_figure",
    "region_explanation"
  ]);
});

test("layout relation vectors still obey chunk access filters", async () => {
  const principal = makePrincipal({ roles: ["reader"] });
  const restrictedDocument = relationDocument({
    accessScope: {
      tenantId: principal.tenantId,
      namespaceId: "test-namespace",
      roles: ["finance_admin"]
    }
  });
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks = chunkDocument({ document: restrictedDocument }).chunks;
  index.addDocument(restrictedDocument);
  index.addChunks(restrictedDocument.id, chunks);

  const adapter = new FakeEmbeddingAdapter({ dimensions: 32 });
  const vectorStore = new InMemoryVectorStore({
    chunkStore: index,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  await new LayoutRelationIndexer({
    adapter,
    vectorStore,
    now: () => FIXED_NOW
  }).indexRelations({
    documents: [restrictedDocument],
    chunks,
    requestedAt: FIXED_NOW
  });
  const result = await vectorStore.findNearestVectors({
    vector: (await adapter.embed({ inputs: [{ id: "query", text: "ownership figure" }] }))
      .embeddings[0]!.vector,
    filter: makeIndexFilter({ principal }),
    topK: 1,
    includeRejected: true
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0]?.code, "access_denied_or_missing_chunk");
});

function relationDocument(overrides: Partial<RagDocument> = {}): RagDocument {
  const body =
    "Figure 1: Ownership chart\n\nThe page two explanation says Parent LLC owns Child LLC.";
  return {
    ...makeDocument({
      id: "doc_relation_visual",
      body
    }),
    layout: relationLayout(body),
    ...overrides
  };
}

function relationLayout(body: string): DocumentLayout {
  const caption = "Figure 1: Ownership chart";
  const explanation = "The page two explanation says Parent LLC owns Child LLC.";
  const explanationStart = body.indexOf(explanation);

  return {
    parserId: "deepdoc-json",
    strategy: "hybrid",
    pages: [
      { pageNumber: 1, width: 600, height: 800, unit: "point" },
      { pageNumber: 2, width: 600, height: 800, unit: "point" }
    ],
    regions: [
      {
        id: "region_caption",
        kind: "figure_caption",
        pageNumber: 1,
        text: caption,
        characterStart: 0,
        characterEnd: caption.length,
        box: {
          pageNumber: 1,
          x: 40,
          y: 500,
          width: 360,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_figure",
        kind: "figure",
        pageNumber: 1,
        box: {
          pageNumber: 1,
          x: 40,
          y: 120,
          width: 420,
          height: 360,
          unit: "point"
        }
      },
      {
        id: "region_explanation",
        kind: "paragraph",
        pageNumber: 2,
        text: explanation,
        characterStart: explanationStart,
        characterEnd: explanationStart + explanation.length,
        box: {
          pageNumber: 2,
          x: 40,
          y: 90,
          width: 420,
          height: 80,
          unit: "point"
        }
      }
    ],
    relations: [
      {
        id: "relation_explains_figure",
        kind: "explains",
        fromRegionId: "region_explanation",
        toRegionId: "region_figure",
        confidence: 0.9
      },
      {
        id: "relation_caption_for_figure",
        kind: "caption_for",
        fromRegionId: "region_caption",
        toRegionId: "region_figure",
        confidence: 0.95
      }
    ]
  };
}
