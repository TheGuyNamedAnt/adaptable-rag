import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import { InMemoryVisualVectorStore } from "../indexing/visual-vector-store.js";
import { FIXED_NOW, makeDocument, makeIndexFilter } from "../test-support/fixtures.js";
import {
  FakeVisualEmbeddingAdapter,
  visualVectorsForText
} from "./fake-visual-embedding-adapter.js";
import { VisualEmbeddingIndexer, visualInputsForChunks } from "./visual-embedding-indexer.js";
import type {
  VisualEmbeddingAdapter,
  VisualEmbeddingBatchResult,
  VisualEmbeddingRequest,
  VisualQueryEmbeddingRequest,
  VisualQueryEmbeddingResult
} from "./visual-embedding-types.js";

test("indexes parser layout visual assets into visual chunk vectors", async () => {
  const body = "Visual Invoice\n\nThe invoice screenshot shows overdue balances.";
  const document = {
    ...makeDocument({
      id: "doc_visual_invoice",
      body
    }),
    layout: layoutForBody(body, true)
  };
  const { index, chunks } = makeChunkIndex([document]);
  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 12 });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidateChunkCount, 1);
  assert.equal(result.indexedVisualVectorCount, 1);
  assert.equal(result.skippedChunkCount, 0);
  assert.equal(result.warnings.length, 0);

  const retrieved = visualVectorStore.findNearestVisualVectors({
    vectors: (await adapter.embedQuery({ query: "overdue invoice", requestedAt: FIXED_NOW }))
      .vectors,
    filter: makeIndexFilter(),
    topK: 1
  });

  assert.equal(retrieved.candidates[0]?.chunk.documentId, "doc_visual_invoice");
  assert.equal(retrieved.candidates[0]?.visualVector.pageNumber, 1);
  assert.deepEqual(retrieved.candidates[0]?.visualVector.layoutRegionIds, [
    "region_title",
    "region_body"
  ]);
});

test("indexes each matching parser visual asset URI for a chunk", async () => {
  const body = "Spreadsheet Model\n\nRevenue chart and logo image support the operating model.";
  const document = {
    ...makeDocument({
      id: "doc_spreadsheet_visual_assets",
      body
    }),
    layout: spreadsheetVisualLayoutForBody(body)
  };
  const { index, chunks } = makeChunkIndex([document]);
  const inputs = visualInputsForChunks(chunks, new Map([[document.id, document]]));

  assert.equal(chunks.length, 1);
  assert.equal(inputs.length, 2);
  assert.deepEqual(
    inputs.map((entry) => entry.input.visualAssetId),
    ["sheet_1_chart_1", "sheet_1_image_1"]
  );
  assert.deepEqual(
    inputs.map((entry) => entry.input.uri),
    ["file:///tmp/sheet_1_chart_1.svg", "file:///tmp/sheet_1_image_1.png"]
  );
  assert.equal(inputs[0]?.input.metadata?.["assetType"], "chart");
  assert.equal(inputs[1]?.input.metadata?.["assetType"], "image");
  assert.match(inputs[0]?.input.text ?? "", /Revenue Chart/u);

  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 12 });
  const visualVectorStore = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });
  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore,
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidateChunkCount, 1);
  assert.equal(result.candidateVisualAssetCount, 2);
  assert.equal(result.indexedVisualVectorCount, 2);
  assert.equal(result.skippedChunkCount, 0);
  assert.equal(visualVectorStore.visualVectorCount(), 2);

  const snapshot = visualVectorStore.snapshot();
  const chartVector = snapshot.vectors.find(
    (entry) => entry.visualVector.visualAssetId === "sheet_1_chart_1"
  )?.visualVector;
  assert.equal(chartVector?.visualAsset?.title, "Revenue Chart");
  assert.equal(chartVector?.visualAsset?.sheetName, "Model");
  assert.equal(chartVector?.visualAsset?.anchorCell, "R9C2");
  assert.equal(
    Object.hasOwn(chartVector?.visualAsset ?? {}, "uri"),
    false,
    "Citation visual asset metadata must not expose parser file URIs."
  );
});

test("visual embedding inputs include text from related layout regions", () => {
  const body = "Figure 1: Ownership chart\n\nThe ownership chart shows Parent LLC owns Child LLC.";
  const document = {
    ...makeDocument({
      id: "doc_visual_related_regions",
      body
    }),
    layout: relatedRegionLayoutForBody(body)
  };
  const chunks = chunkDocument({
    document,
    policy: {
      id: "related-region-test-policy",
      preserveStructuredLayoutRegions: true,
      preserveWhitespace: false,
      boundaryStrategy: "paragraph",
      locatorStrategy: "paragraph_range",
      maxCharacters: 30,
      minCharacters: 1,
      overlapCharacters: 0,
      maxChunksPerDocument: 20,
      includeTextHash: true,
      detectSuspiciousText: true
    }
  }).chunks;

  const inputs = visualInputsForChunks(chunks.slice(0, 1), new Map([[document.id, document]]));

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.input.text?.includes("Figure 1: Ownership chart"), true);
  assert.equal(
    inputs[0]?.input.text?.includes("The ownership chart shows Parent LLC owns Child LLC."),
    true
  );
});

test("skips text-only chunks instead of fabricating visual evidence", async () => {
  const document = makeDocument({
    id: "doc_text_only",
    body: "Text-only policy without parser layout."
  });
  const { index, chunks } = makeChunkIndex([document]);
  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 8 });
  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore: new InMemoryVisualVectorStore({
      chunkStore: index,
      dimensions: adapter.dimensions,
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidateChunkCount, 0);
  assert.equal(result.indexedVisualVectorCount, 0);
  assert.equal(result.skippedChunkCount, 1);
  assert.equal(result.warnings.length, 0);
});

test("warns when layout evidence has no matching visual asset", async () => {
  const body = "Visual Invoice\n\nThe invoice screenshot shows overdue balances.";
  const document = {
    ...makeDocument({
      id: "doc_missing_asset",
      body
    }),
    layout: layoutForBody(body, false)
  };
  const { index, chunks } = makeChunkIndex([document]);
  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 8 });
  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore: new InMemoryVisualVectorStore({
      chunkStore: index,
      dimensions: adapter.dimensions,
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.candidateChunkCount, 0);
  assert.equal(result.indexedVisualVectorCount, 0);
  assert.equal(result.warnings[0]?.code, "missing_visual_asset");
});

test("reports visual embedding adapter failure without writing vectors", async () => {
  const { document, chunks, index } = visualFixture("doc_visual_failure");
  const adapter = new FakeVisualEmbeddingAdapter({
    dimensions: 8,
    failWith: "visual provider down"
  });
  const store = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: adapter.dimensions,
    now: () => FIXED_NOW
  });

  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore: store,
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [document],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.indexedVisualVectorCount, 0);
  assert.equal(result.warnings[0]?.code, "visual_embedding_failed");
  assert.equal(store.visualVectorCount(), 0);
});

test("reports malformed visual embedding adapter outputs per chunk", async () => {
  const { document, chunks, index } = visualFixture("doc_visual_malformed");
  const store = new InMemoryVisualVectorStore({
    chunkStore: index,
    dimensions: 8,
    now: () => FIXED_NOW
  });

  const missing = await new VisualEmbeddingIndexer({
    adapter: new StaticVisualEmbeddingAdapter("missing", 8),
    visualVectorStore: store,
    now: () => FIXED_NOW
  }).indexChunks({ documents: [document], chunks, requestedAt: FIXED_NOW });
  assert.equal(missing.warnings[0]?.code, "missing_embedding");

  const empty = await new VisualEmbeddingIndexer({
    adapter: new StaticVisualEmbeddingAdapter("empty", 8),
    visualVectorStore: store,
    now: () => FIXED_NOW
  }).indexChunks({ documents: [document], chunks, requestedAt: FIXED_NOW });
  assert.equal(empty.warnings[0]?.code, "empty_visual_vectors");

  const mismatch = await new VisualEmbeddingIndexer({
    adapter: new StaticVisualEmbeddingAdapter("mismatch", 8),
    visualVectorStore: store,
    now: () => FIXED_NOW
  }).indexChunks({ documents: [document], chunks, requestedAt: FIXED_NOW });
  assert.equal(mismatch.warnings[0]?.code, "dimension_mismatch");
});

test("reports missing source documents for visual chunks", async () => {
  const { chunks, index } = visualFixture("doc_visual_missing_document");
  const adapter = new FakeVisualEmbeddingAdapter({ dimensions: 8 });
  const result = await new VisualEmbeddingIndexer({
    adapter,
    visualVectorStore: new InMemoryVisualVectorStore({
      chunkStore: index,
      dimensions: adapter.dimensions,
      now: () => FIXED_NOW
    }),
    now: () => FIXED_NOW
  }).indexChunks({
    documents: [],
    chunks,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.indexedVisualVectorCount, 0);
  assert.equal(result.warnings[0]?.code, "missing_document");
});

test("fake visual embedding adapter covers validation and query failure branches", async () => {
  assert.throws(() => new FakeVisualEmbeddingAdapter({ dimensions: 1 }), /dimensions/u);
  assert.throws(() => visualVectorsForText("invoice", 1), /dimensions/u);

  const failedQuery = await new FakeVisualEmbeddingAdapter({
    dimensions: 8,
    failWith: "query failed"
  }).embedQuery({ query: "invoice", requestedAt: FIXED_NOW });

  assert.equal(failedQuery.status, "failed");
  assert.equal(failedQuery.errorMessage, "query failed");
});

class StaticVisualEmbeddingAdapter implements VisualEmbeddingAdapter {
  readonly id = "static-visual-adapter";
  readonly provider = "test";
  readonly modelName = "static-visual";

  constructor(
    private readonly mode: "missing" | "empty" | "mismatch",
    readonly dimensions: number
  ) {}

  async embedVisualAssets(request: VisualEmbeddingRequest): Promise<VisualEmbeddingBatchResult> {
    const first = request.inputs[0];
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings:
        first === undefined || this.mode === "missing"
          ? []
          : [
              {
                id: first.id,
                vectors:
                  this.mode === "empty"
                    ? []
                    : [Array.from({ length: this.dimensions - 1 }, () => 1)]
              }
            ],
      usage: {
        inputCount: request.inputs.length,
        totalInputCharacters: 0,
        vectorCount: this.mode === "missing" || this.mode === "empty" ? 0 : 1
      },
      warnings: []
    };
  }

  async embedQuery(request: VisualQueryEmbeddingRequest): Promise<VisualQueryEmbeddingResult> {
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      vectors: visualVectorsForText(request.query, this.dimensions),
      usage: {
        inputCount: 1,
        totalInputCharacters: request.query.length,
        vectorCount: 1
      },
      warnings: []
    };
  }
}

function visualFixture(documentId: string): {
  readonly document: RagDocument;
  readonly index: InMemoryRagIndex;
  readonly chunks: readonly ReturnType<typeof chunkDocument>["chunks"][number][];
} {
  const body = "Visual Invoice\n\nThe invoice screenshot shows overdue balances.";
  const document = {
    ...makeDocument({
      id: documentId,
      body
    }),
    layout: layoutForBody(body, true)
  };
  const { index, chunks } = makeChunkIndex([document]);
  return { document, index, chunks };
}

function makeChunkIndex(documents: readonly RagDocument[]): {
  readonly index: InMemoryRagIndex;
  readonly chunks: readonly ReturnType<typeof chunkDocument>["chunks"][number][];
} {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunks: ReturnType<typeof chunkDocument>["chunks"][number][] = [];

  for (const document of documents) {
    const documentChunks = chunkDocument({ document }).chunks;
    index.addDocument(document);
    index.addChunks(document.id, documentChunks);
    chunks.push(...documentChunks);
  }

  return { index, chunks };
}

function layoutForBody(body: string, includeVisualAsset: boolean): DocumentLayout {
  const titleEnd = body.indexOf("\n\n");
  const bodyStart = titleEnd + 2;

  return {
    parserId: "fixture-parser",
    strategy: "visual_page",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point",
        visualAssetId: "page_1"
      }
    ],
    regions: [
      {
        id: "region_title",
        kind: "title",
        pageNumber: 1,
        text: body.slice(0, titleEnd),
        characterStart: 0,
        characterEnd: titleEnd,
        box: {
          pageNumber: 1,
          x: 40,
          y: 40,
          width: 300,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_body",
        kind: "paragraph",
        pageNumber: 1,
        text: body.slice(bodyStart),
        characterStart: bodyStart,
        characterEnd: body.length,
        box: {
          pageNumber: 1,
          x: 40,
          y: 90,
          width: 400,
          height: 80,
          unit: "point"
        }
      }
    ],
    ...(includeVisualAsset
      ? {
          visualAssets: [
            {
              id: "page_1",
              kind: "page_image",
              pageNumber: 1,
              mediaType: "image/png",
              uri: "file:///tmp/page-1.png"
            }
          ]
        }
      : {})
  };
}

function spreadsheetVisualLayoutForBody(body: string): DocumentLayout {
  const titleEnd = body.indexOf("\n\n");
  const bodyStart = titleEnd + 2;

  return {
    parserId: "fixture-parser",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      }
    ],
    regions: [
      {
        id: "region_title",
        kind: "title",
        pageNumber: 1,
        text: body.slice(0, titleEnd),
        characterStart: 0,
        characterEnd: titleEnd
      },
      {
        id: "region_sheet_table",
        kind: "table",
        pageNumber: 1,
        text: body.slice(bodyStart),
        characterStart: bodyStart,
        characterEnd: body.length
      }
    ],
    visualAssets: [
      {
        id: "sheet_1_chart_1",
        kind: "figure",
        pageNumber: 1,
        mediaType: "image/svg+xml",
        uri: "file:///tmp/sheet_1_chart_1.svg",
        metadata: {
          assetType: "chart",
          title: "Revenue Chart",
          chartType: "BarChart",
          sheetName: "Model",
          anchorCell: "R9C2"
        }
      },
      {
        id: "sheet_1_image_1",
        kind: "figure",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/sheet_1_image_1.png",
        metadata: {
          assetType: "image",
          sheetName: "Model",
          anchorCell: "R2C5"
        }
      }
    ]
  };
}

function relatedRegionLayoutForBody(body: string): DocumentLayout {
  const caption = "Figure 1: Ownership chart";
  const explanation = "The ownership chart shows Parent LLC owns Child LLC.";
  const explanationStart = body.indexOf(explanation);

  return {
    parserId: "fixture-parser",
    strategy: "hybrid",
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        unit: "point"
      },
      {
        pageNumber: 2,
        width: 600,
        height: 800,
        unit: "point"
      }
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
        id: "relation_caption_for_figure",
        kind: "caption_for",
        fromRegionId: "region_caption",
        toRegionId: "region_figure"
      },
      {
        id: "relation_explanation_for_figure",
        kind: "explains",
        fromRegionId: "region_explanation",
        toRegionId: "region_figure"
      }
    ],
    visualAssets: [
      {
        id: "page_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///tmp/page-1.png"
      }
    ]
  };
}
