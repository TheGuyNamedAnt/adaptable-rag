import test from "node:test";
import assert from "node:assert/strict";

import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import { chunkDocument } from "../chunking/chunker.js";
import { buildSearchableArtifacts } from "./searchable-artifacts.js";

test("materializes source-backed table rows as searchable chunks", () => {
  const document = fixtureDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const tableChunk = result.chunks.find(
    (chunk) =>
      chunk.metadata?.["searchableUnitType"] === "table_chunk" &&
      chunk.metadata?.["tableId"] === "table_revenue"
  );
  const rowChunk = result.chunks.find(
    (chunk) =>
      chunk.metadata?.["searchableUnitType"] === "table_row_chunk" &&
      chunk.metadata?.["tableRowIndex"] === 1
  );

  assert.ok(tableChunk);
  assert.match(String(tableChunk.metadata?.["searchableEmbeddingText"]), /Table/u);
  assert.match(String(tableChunk.metadata?.["searchableEmbeddingText"]), /North America/u);
  assert.ok(rowChunk);
  assert.equal(rowChunk.text, "North America 120");
  assert.equal(rowChunk.documentId, document.id);
  assert.equal(rowChunk.accessScope, document.accessScope);
  assert.deepEqual(rowChunk.layoutRegionIds, ["cell_region", "cell_revenue"]);
  assert.equal(rowChunk.metadata?.["tableId"], "table_revenue");
  assert.match(String(rowChunk.metadata?.["searchableEmbeddingText"]), /Table row/u);
  assert.match(String(rowChunk.metadata?.["searchableEmbeddingText"]), /Q4 revenue summary/u);
  assert.match(String(rowChunk.metadata?.["searchableEmbeddingText"]), /North America, 120/u);
});

test("materializes table rows from source text even when cells lack region ids", () => {
  const document = tableWithoutCellRegionsDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const rowChunk = result.chunks.find(
    (chunk) =>
      chunk.metadata?.["searchableUnitType"] === "table_row_chunk" &&
      chunk.metadata?.["tableRowIndex"] === 1
  );

  assert.ok(rowChunk);
  assert.equal(rowChunk.text, "Revenue | 125");
  assert.deepEqual(rowChunk.layoutRegionIds, ["table_region"]);
  assert.equal(
    result.warnings.some((warning) => warning.code === "table_row_not_source_backed"),
    false
  );
});

test("materializes source-backed headings as routing chunks", () => {
  const document = fixtureDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const headingChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "heading_chunk"
  );

  assert.ok(headingChunk);
  assert.equal(headingChunk.text, "Revenue by Region");
  assert.deepEqual(headingChunk.layoutRegionIds, ["heading_revenue"]);
  assert.match(String(headingChunk.metadata?.["searchableEmbeddingText"]), /Heading/u);
});

test("materializes source-backed equations as searchable chunks", () => {
  const document = equationDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const equationChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "equation_chunk"
  );

  assert.ok(equationChunk);
  assert.equal(equationChunk.text, "retention = active_users / total_users");
  assert.deepEqual(equationChunk.layoutRegionIds, ["equation_retention"]);
  assert.equal(equationChunk.citation.pageNumber, 2);
  assert.match(String(equationChunk.metadata?.["searchableEmbeddingText"]), /Equation/u);
  assert.match(
    String(equationChunk.metadata?.["searchableEmbeddingText"]),
    /retention = active_users/u
  );
  assert.match(String(equationChunk.metadata?.["searchableEmbeddingText"]), /Page: 2/u);
});

test("warns instead of fabricating equation chunks without source text", () => {
  const document = equationWithoutSourceTextDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  assert.equal(
    result.chunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "equation_chunk"),
    false
  );
  assert.equal(
    result.warnings.some((warning) => warning.code === "equation_not_source_backed"),
    true
  );
});

test("materializes visual fallback chunks from source-backed captions", () => {
  const document = fixtureDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const visualChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "visual_asset_chunk"
  );
  const figureChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "figure_caption_chunk"
  );

  assert.ok(visualChunk);
  assert.equal(visualChunk.metadata?.["visualAssetId"], "figure_1");
  assert.deepEqual(visualChunk.layoutRegionIds, ["figure_caption", "figure_region"]);
  assert.ok(figureChunk);
  assert.equal(figureChunk.text, "Refund workflow diagram");
  assert.equal(figureChunk.metadata?.["visualAssetId"], "figure_1");
  assert.match(String(figureChunk.metadata?.["searchableEmbeddingText"]), /Visual asset/u);
  assert.match(String(figureChunk.metadata?.["searchableEmbeddingText"]), /figure_1/u);
  assert.doesNotMatch(String(figureChunk.metadata?.["searchableEmbeddingText"]), /Q4 revenue/u);
});

test("materializes visual assets from page text when no caption exists", () => {
  const document = visualAssetWithPageTextDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const visualChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "visual_asset_chunk"
  );

  assert.ok(visualChunk);
  assert.equal(visualChunk.text, document.body);
  assert.equal(visualChunk.metadata?.["visualAssetId"], "page_image_1");
  assert.match(String(visualChunk.metadata?.["searchableEmbeddingText"]), /Page text/u);
  assert.equal(
    result.warnings.some((warning) => warning.code === "visual_asset_missing_text_fallback"),
    false
  );
});

test("materializes source-backed page and layout relation chunks", () => {
  const document = fixtureDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const pageChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "page_summary_chunk"
  );
  const relationChunk = result.chunks.find(
    (chunk) =>
      chunk.metadata?.["searchableUnitType"] === "layout_relation_chunk" &&
      chunk.metadata?.["layoutRelationId"] === "table_caption_for_table"
  );

  assert.ok(pageChunk);
  assert.equal(pageChunk.citation.pageNumber, 1);
  assert.match(String(pageChunk.metadata?.["searchableEmbeddingText"]), /Page summary/u);
  assert.ok(relationChunk);
  assert.equal(relationChunk.metadata?.["layoutRelationKind"], "caption_for");
  assert.match(String(relationChunk.metadata?.["searchableEmbeddingText"]), /Layout relation/u);
});

test("caps long derived chunks to index-safe source ranges", () => {
  const body = "Long source-backed page text ".repeat(100);
  const document: RagDocument = {
    id: "doc_long_derived_chunk",
    namespaceId: "generic-docs",
    title: "Long Derived Chunk",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Long Derived Chunk",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "text_extraction",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "page_text",
          kind: "paragraph",
          pageNumber: 1,
          text: body,
          characterStart: 0,
          characterEnd: body.length
        }
      ]
    }
  };
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });
  const pageChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "page_summary_chunk"
  );

  assert.ok(pageChunk);
  assert.equal(pageChunk.text.length, DEFAULT_CHUNKING_POLICY.maxCharacters);
  assert.equal(pageChunk.characterEnd, DEFAULT_CHUNKING_POLICY.maxCharacters);
  assert.equal(pageChunk.text, body.slice(0, DEFAULT_CHUNKING_POLICY.maxCharacters));
  assert.deepEqual(pageChunk.safetyFlags, ["oversized_chunk"]);
  assert.equal(pageChunk.metadata?.["derivedChunkTruncated"], true);
  assert.equal(pageChunk.metadata?.["derivedOriginalCharacterEnd"], body.length);
  assert.ok(
    String(pageChunk.metadata?.["searchableEmbeddingText"]).length <=
      DEFAULT_CHUNKING_POLICY.maxCharacters
  );
});

test("materializes source-backed parser gap chunks for OCR-risk pages", () => {
  const document = ocrRiskDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  const gapChunk = result.chunks.find(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "parser_gap_chunk"
  );

  assert.ok(gapChunk);
  assert.equal(gapChunk.text, "OCR note");
  assert.equal(gapChunk.metadata?.["pageNumber"], 1);
  assert.equal(gapChunk.metadata?.["answerEvidence"], false);
  assert.match(String(gapChunk.metadata?.["parserGapReasons"]), /page_text_below_threshold/u);
  assert.match(String(gapChunk.metadata?.["searchableEmbeddingText"]), /Parser gap/u);
});

test("warns instead of fabricating parser gap chunks without source text", () => {
  const document = imageOnlyDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const result = buildSearchableArtifacts({ document, bodyChunks });

  assert.equal(
    result.chunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "parser_gap_chunk"),
    false
  );
  assert.equal(
    result.warnings.some((warning) => warning.code === "parser_gap_not_source_backed"),
    true
  );
});

function fixtureDocument(): RagDocument {
  const body = [
    "Revenue by Region",
    "Revenue table: Q4 revenue summary",
    "Region Revenue",
    "North America 120",
    "Europe 90",
    "Refund workflow diagram"
  ].join("\n");
  return {
    id: "doc_parser_searchability",
    namespaceId: "generic-docs",
    title: "Parser Searchability Fixture",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Parser Searchability Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: fixtureLayout(body)
  };
}

function fixtureLayout(body: string): DocumentLayout {
  const headingStart = body.indexOf("Revenue by Region");
  const captionStart = body.indexOf("Revenue table: Q4 revenue summary");
  const headerStart = body.indexOf("Region Revenue");
  const rowStart = body.indexOf("North America 120");
  const europeStart = body.indexOf("Europe 90");
  const figureCaptionStart = body.indexOf("Refund workflow diagram");
  return {
    parserId: "fixture-parser",
    parserVersion: "1.0.0",
    strategy: "hybrid",
    pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
    regions: [
      {
        id: "heading_revenue",
        kind: "heading",
        pageNumber: 1,
        text: "Revenue by Region",
        characterStart: headingStart,
        characterEnd: headingStart + "Revenue by Region".length
      },
      {
        id: "table_caption",
        kind: "table_caption",
        pageNumber: 1,
        text: "Revenue table: Q4 revenue summary",
        characterStart: captionStart,
        characterEnd: captionStart + "Revenue table: Q4 revenue summary".length
      },
      {
        id: "table_region",
        kind: "table",
        pageNumber: 1,
        characterStart: headerStart,
        characterEnd: europeStart + "Europe 90".length
      },
      {
        id: "cell_header_region",
        kind: "text",
        pageNumber: 1,
        text: "Region",
        characterStart: headerStart,
        characterEnd: headerStart + "Region".length
      },
      {
        id: "cell_header_revenue",
        kind: "text",
        pageNumber: 1,
        text: "Revenue",
        characterStart: headerStart + "Region ".length,
        characterEnd: headerStart + "Region Revenue".length
      },
      {
        id: "cell_region",
        kind: "text",
        pageNumber: 1,
        text: "North America",
        characterStart: rowStart,
        characterEnd: rowStart + "North America".length
      },
      {
        id: "cell_revenue",
        kind: "text",
        pageNumber: 1,
        text: "120",
        characterStart: rowStart + "North America ".length,
        characterEnd: rowStart + "North America 120".length
      },
      {
        id: "figure_region",
        kind: "figure",
        pageNumber: 1
      },
      {
        id: "figure_caption",
        kind: "figure_caption",
        pageNumber: 1,
        text: "Refund workflow diagram",
        characterStart: figureCaptionStart,
        characterEnd: figureCaptionStart + "Refund workflow diagram".length
      }
    ],
    relations: [
      {
        id: "table_caption_for_table",
        kind: "caption_for",
        fromRegionId: "table_caption",
        toRegionId: "table_region"
      },
      {
        id: "figure_caption_for_figure",
        kind: "caption_for",
        fromRegionId: "figure_caption",
        toRegionId: "figure_region"
      }
    ],
    tables: [
      {
        id: "table_revenue",
        pageNumber: 1,
        regionId: "table_region",
        captionRegionId: "table_caption",
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Region", regionId: "cell_header_region" },
          { rowIndex: 0, columnIndex: 1, text: "Revenue", regionId: "cell_header_revenue" },
          { rowIndex: 1, columnIndex: 0, text: "North America", regionId: "cell_region" },
          { rowIndex: 1, columnIndex: 1, text: "120", regionId: "cell_revenue" }
        ]
      }
    ],
    visualAssets: [
      {
        id: "figure_1",
        kind: "figure",
        pageNumber: 1,
        mediaType: "image/png"
      }
    ]
  };
}

function ocrRiskDocument(): RagDocument {
  const body = "OCR note";
  return {
    id: "doc_parser_gap",
    namespaceId: "generic-docs",
    title: "Parser Gap Fixture",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Parser Gap Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "ocr_layout",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "page_image_region",
          kind: "page_image",
          pageNumber: 1
        },
        {
          id: "ocr_note",
          kind: "text",
          pageNumber: 1,
          text: body,
          characterStart: 0,
          characterEnd: body.length
        }
      ]
    }
  };
}

function tableWithoutCellRegionsDocument(): RagDocument {
  const body = "Metric | Value\nRevenue | 125\nCost | 75";
  return {
    id: "doc_table_without_cell_regions",
    namespaceId: "generic-docs",
    title: "Table Without Cell Regions Fixture",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Table Without Cell Regions Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "table_structure",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "table_region",
          kind: "table",
          pageNumber: 1,
          text: body
        }
      ],
      tables: [
        {
          id: "table_1",
          pageNumber: 1,
          regionId: "table_region",
          cells: [
            { rowIndex: 0, columnIndex: 0, text: "Metric" },
            { rowIndex: 0, columnIndex: 1, text: "Value" },
            { rowIndex: 1, columnIndex: 0, text: "Revenue" },
            { rowIndex: 1, columnIndex: 1, text: "125" },
            { rowIndex: 2, columnIndex: 0, text: "Cost" },
            { rowIndex: 2, columnIndex: 1, text: "75" }
          ]
        }
      ]
    }
  };
}

function visualAssetWithPageTextDocument(): RagDocument {
  const body = "Alphabet Inc. Class A\nNASDAQ Composite\n12/24";
  return {
    id: "doc_visual_asset_page_text",
    namespaceId: "generic-docs",
    title: "Visual Asset Page Text Fixture",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Visual Asset Page Text Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "ocr_layout",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "page_text",
          kind: "text",
          pageNumber: 1,
          text: body,
          characterStart: 0,
          characterEnd: body.length
        },
        {
          id: "page_image_region",
          kind: "page_image",
          pageNumber: 1
        }
      ],
      visualAssets: [
        {
          id: "page_image_1",
          kind: "page_image",
          pageNumber: 1,
          mediaType: "image/png"
        }
      ]
    }
  };
}

function imageOnlyDocument(): RagDocument {
  return {
    id: "doc_image_only_gap",
    namespaceId: "generic-docs",
    title: "Image Only Parser Gap Fixture",
    body: "Image-only scan placeholder",
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Image Only Parser Gap Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "ocr_layout",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "page_image_region",
          kind: "page_image",
          pageNumber: 1
        }
      ],
      visualAssets: [
        {
          id: "page_image_1",
          kind: "page_image",
          pageNumber: 1,
          mediaType: "image/png"
        }
      ]
    }
  };
}

function equationDocument(): RagDocument {
  const body = [
    "Retention metric",
    "retention = active_users / total_users",
    "The metric is reported monthly."
  ].join("\n");
  const equationStart = body.indexOf("retention = active_users / total_users");
  return {
    id: "doc_equation_searchability",
    namespaceId: "generic-docs",
    title: "Equation Searchability Fixture",
    body,
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Equation Searchability Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "hybrid",
      pages: [
        { pageNumber: 1, width: 612, height: 792, unit: "point" },
        { pageNumber: 2, width: 612, height: 792, unit: "point" }
      ],
      regions: [
        {
          id: "equation_retention",
          kind: "equation",
          pageNumber: 2,
          text: "retention = active_users / total_users",
          characterStart: equationStart,
          characterEnd: equationStart + "retention = active_users / total_users".length,
          box: {
            pageNumber: 2,
            x: 80,
            y: 220,
            width: 360,
            height: 36,
            unit: "point"
          }
        }
      ]
    }
  };
}

function equationWithoutSourceTextDocument(): RagDocument {
  return {
    id: "doc_equation_without_source",
    namespaceId: "generic-docs",
    title: "Equation Without Source Fixture",
    body: "Equation appears only as parser layout metadata.",
    provenance: {
      sourceId: "docs",
      sourceKind: "local_file",
      title: "Equation Without Source Fixture",
      ingestedAt: "2026-06-27T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: {
      parserId: "fixture-parser",
      parserVersion: "1.0.0",
      strategy: "hybrid",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [
        {
          id: "equation_missing_offsets",
          kind: "equation",
          pageNumber: 1,
          text: "x = y + z",
          box: {
            pageNumber: 1,
            x: 80,
            y: 220,
            width: 180,
            height: 36,
            unit: "point"
          }
        }
      ]
    }
  };
}
