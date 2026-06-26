import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "./layout.js";
import { validateDocumentLayout } from "./layout.js";

const body = "Quarterly revenue\n\nRevenue was $10M.\n\nSource: finance deck";

function validLayout(overrides: Partial<DocumentLayout> = {}): DocumentLayout {
  return {
    parserId: "deepdoc-compatible",
    parserVersion: "1.0.0",
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
        text: "Quarterly revenue",
        characterStart: 0,
        characterEnd: 17,
        box: {
          pageNumber: 1,
          x: 40,
          y: 40,
          width: 300,
          height: 40,
          unit: "point"
        }
      },
      {
        id: "region_table",
        kind: "table",
        pageNumber: 1,
        box: {
          pageNumber: 1,
          x: 40,
          y: 120,
          width: 400,
          height: 160,
          unit: "point"
        }
      },
      {
        id: "region_table_caption",
        kind: "table_caption",
        pageNumber: 1,
        text: "Source: finance deck",
        characterStart: 38,
        characterEnd: 58,
        box: {
          pageNumber: 1,
          x: 40,
          y: 290,
          width: 250,
          height: 30,
          unit: "point"
        }
      }
    ],
    tables: [
      {
        id: "table_1",
        pageNumber: 1,
        regionId: "region_table",
        captionRegionId: "region_table_caption",
        cells: [
          {
            rowIndex: 0,
            columnIndex: 0,
            text: "Revenue"
          },
          {
            rowIndex: 0,
            columnIndex: 1,
            text: "$10M"
          }
        ]
      }
    ],
    visualAssets: [
      {
        id: "page_image_1",
        kind: "page_image",
        pageNumber: 1,
        mediaType: "image/png",
        uri: "file:///safe/page-1.png"
      }
    ],
    ...overrides
  };
}

test("accepts a layout with page boxes, regions, tables, and visual assets", () => {
  const result = validateDocumentLayout(validLayout(), body);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("accepts valid cross-region layout relations", () => {
  const layout = validLayout({
    relations: [
      {
        id: "relation_caption_for_table",
        kind: "caption_for",
        fromRegionId: "region_table_caption",
        toRegionId: "region_table",
        confidence: 0.92
      },
      {
        id: "relation_table_same_section",
        kind: "same_section",
        fromRegionId: "region_table",
        toRegionId: "region_title"
      }
    ]
  });

  const result = validateDocumentLayout(layout, body);

  assert.equal(result.valid, true);
});

test("rejects region text that does not match the normalized body range", () => {
  const layout = validLayout({
    regions: [
      {
        id: "bad_region",
        kind: "paragraph",
        pageNumber: 1,
        text: "wrong text",
        characterStart: 0,
        characterEnd: 17
      }
    ],
    tables: [],
    visualAssets: []
  });

  const result = validateDocumentLayout(layout, body);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((issue) => issue.code === "region_text_mismatch"),
    true
  );
});

test("rejects geometry outside the page and duplicate ids", () => {
  const layout = validLayout({
    regions: [
      {
        id: "duplicate",
        kind: "title",
        pageNumber: 1,
        box: {
          pageNumber: 1,
          x: 500,
          y: 40,
          width: 200,
          height: 40,
          unit: "point"
        }
      },
      {
        id: "duplicate",
        kind: "paragraph",
        pageNumber: 1
      }
    ],
    tables: [],
    visualAssets: []
  });

  const result = validateDocumentLayout(layout, body);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((issue) => issue.code === "invalid_region_box"),
    true
  );
  assert.equal(
    result.errors.some((issue) => issue.code === "duplicate_id"),
    true
  );
});

test("rejects tables that reference non-table regions", () => {
  const layout = validLayout({
    regions: [
      {
        id: "not_table",
        kind: "paragraph",
        pageNumber: 1
      }
    ],
    tables: [
      {
        id: "table_1",
        pageNumber: 1,
        regionId: "not_table",
        cells: [
          {
            rowIndex: 0,
            columnIndex: 0,
            rowSpan: 0
          }
        ]
      }
    ],
    visualAssets: []
  });

  const result = validateDocumentLayout(layout, body);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((issue) => issue.code === "invalid_table_reference"),
    true
  );
  assert.equal(
    result.errors.some((issue) => issue.code === "invalid_table_cell"),
    true
  );
});

test("rejects layout relations that point at missing or invalid regions", () => {
  const layout = validLayout({
    relations: [
      {
        id: "bad_relation",
        kind: "caption_for",
        fromRegionId: "missing",
        toRegionId: "region_table_caption",
        confidence: 2
      }
    ]
  });

  const result = validateDocumentLayout(layout, body);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((issue) => issue.code === "invalid_layout_relation"),
    true
  );
});
