import assert from "node:assert/strict";
import test from "node:test";

import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { validateChunk } from "./chunk-validation.js";
import { DEFAULT_CHUNKING_POLICY, type ChunkingPolicy } from "./chunk-policy.js";
import { ChunkingPolicyError, chunkDocument } from "./chunker.js";

const baseDocument: RagDocument = {
  id: "doc_chunking",
  namespaceId: "test-namespace",
  title: "Chunking Policy",
  body: "placeholder",
  provenance: {
    sourceId: "curated_docs",
    sourceKind: "local_file",
    title: "Chunking Policy",
    ingestedAt: "2026-06-23T00:00:00.000Z",
    trustTier: "trusted_internal",
    sensitivity: "internal",
    capturedAt: "2026-06-23T00:00:00.000Z"
  },
  accessScope: {
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    tags: ["support"]
  }
};

function documentWithBody(body: string): RagDocument {
  return {
    ...baseDocument,
    body
  };
}

function layoutForBody(body: string): DocumentLayout {
  assert.equal(body, "Title\n\nImportant fact.");

  return {
    parserId: "fixture-parser",
    strategy: "ocr_layout",
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
        text: "Title",
        characterStart: 0,
        characterEnd: 5,
        box: {
          pageNumber: 1,
          x: 40,
          y: 40,
          width: 200,
          height: 30,
          unit: "point"
        }
      },
      {
        id: "region_fact",
        kind: "paragraph",
        pageNumber: 1,
        text: "Important fact.",
        characterStart: 7,
        characterEnd: 22,
        box: {
          pageNumber: 1,
          x: 40,
          y: 90,
          width: 300,
          height: 40,
          unit: "point"
        }
      }
    ]
  };
}

function crossPageLayoutForBody(body: string): DocumentLayout {
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
        id: "relation_figure_explained_by_next_page",
        kind: "explains",
        fromRegionId: "region_explanation",
        toRegionId: "region_figure"
      }
    ]
  };
}

function tableOnlyLayoutForBody(body: string, table: string): DocumentLayout {
  const tableStart = body.indexOf(table);
  assert.notEqual(tableStart, -1);

  return {
    parserId: "fixture-parser",
    strategy: "table_structure",
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
        id: "region_table",
        kind: "table",
        pageNumber: 1,
        text: table,
        characterStart: tableStart,
        characterEnd: tableStart + table.length
      }
    ],
    tables: [
      {
        id: "table_1",
        pageNumber: 1,
        regionId: "region_table",
        cells: [{ rowIndex: 0, columnIndex: 0, text: "Metric" }]
      }
    ]
  };
}

function policy(overrides: Partial<ChunkingPolicy> = {}): ChunkingPolicy {
  return {
    ...DEFAULT_CHUNKING_POLICY,
    maxCharacters: 24,
    overlapCharacters: 0,
    minCharacters: 1,
    maxChunksPerDocument: 100,
    ...overrides
  };
}

test("default policy can chunk near-two-megabyte structured text documents", () => {
  const line = '{"key":"value","url":"https://example.com/path","label":"metadata"}\n';
  const body = line.repeat(Math.ceil(1_950_000 / line.length)).slice(0, 1_950_000);
  const result = chunkDocument({
    document: documentWithBody(body)
  });

  assert.ok(result.chunks.length > 500);
  assert.ok(result.chunks.length <= DEFAULT_CHUNKING_POLICY.maxChunksPerDocument);
});

test("keeps character-window chunk text equal to the exact source range", () => {
  const document = documentWithBody("  Alpha beta gamma\nDelta epsilon zeta\n  Eta theta.  ");
  const result = chunkDocument({
    document,
    policy: policy({
      boundaryStrategy: "character_window",
      preserveWhitespace: true
    })
  });

  assert.ok(result.chunks.length > 1);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), document.body);
  assertExactChunks(document, result.chunks);
});

test("preserveWhitespace false trims chunk edges by moving ranges only", () => {
  const document = documentWithBody("   Alpha beta gamma\n\n   Delta epsilon zeta   ");
  const [chunk] = chunkDocument({
    document,
    policy: policy({
      maxCharacters: 100,
      preserveWhitespace: false
    })
  }).chunks;

  assert.ok(chunk);
  assert.equal(chunk.text, "Alpha beta gamma\n\n   Delta epsilon zeta");
  assert.equal(chunk.text, document.body.slice(chunk.characterStart, chunk.characterEnd));
  assert.equal(chunk.text.includes("\n\n   "), true);
  assert.equal(/^\s|\s$/.test(chunk.text), false);
});

test("uses real line and paragraph locators instead of placeholder chunk labels", () => {
  const lineDocument = documentWithBody(
    "Line one text\nLine two text\nLine three text\nLine four text"
  );
  const lineChunks = chunkDocument({
    document: lineDocument,
    policy: policy({
      boundaryStrategy: "line",
      locatorStrategy: "line_range",
      maxCharacters: 26
    })
  }).chunks;

  assert.ok(lineChunks.length > 1);
  assert.deepEqual(
    lineChunks.map((chunk) => chunk.citation.locator),
    ["line 1", "line 2", "line 3", "line 4"]
  );

  const paragraphDocument = documentWithBody(
    "First paragraph text.\n\nSecond paragraph text.\n\nThird paragraph text."
  );
  const paragraphChunks = chunkDocument({
    document: paragraphDocument,
    policy: policy({
      boundaryStrategy: "paragraph",
      locatorStrategy: "paragraph_range",
      maxCharacters: 26
    })
  }).chunks;

  assert.ok(paragraphChunks.length > 1);
  assert.deepEqual(
    paragraphChunks.map((chunk) => chunk.citation.locator),
    ["paragraph 1", "paragraph 2", "paragraph 3"]
  );
  assert.equal(
    [...lineChunks, ...paragraphChunks].every(
      (chunk) => !chunk.citation.locator?.startsWith("chunk ")
    ),
    true
  );
});

test("carries layout regions and bounding boxes into chunks and citations", () => {
  const body = "Title\n\nImportant fact.";
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: layoutForBody(body)
  };
  const [chunk] = chunkDocument({
    document,
    policy: policy({
      maxCharacters: 100
    })
  }).chunks;

  assert.ok(chunk);
  assert.deepEqual(chunk.layoutRegionIds, ["region_title", "region_fact"]);
  assert.deepEqual(chunk.citation.layoutRegionIds, chunk.layoutRegionIds);
  assert.equal(chunk.boundingBoxes?.length, 2);
  assert.deepEqual(chunk.citation.boundingBoxes, chunk.boundingBoxes);
  assert.equal(chunk.citation.pageNumber, 1);
  assert.equal(validateChunk(chunk, document, policy({ maxCharacters: 100 })).valid, true);
});

test("expands chunk layout evidence through cross-page layout relations", () => {
  const body = "Figure 1: Ownership chart\n\nThe ownership chart shows Parent LLC owns Child LLC.";
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: crossPageLayoutForBody(body)
  };

  const [chunk] = chunkDocument({
    document,
    policy: policy({
      maxCharacters: 30,
      boundaryStrategy: "paragraph",
      locatorStrategy: "paragraph_range"
    })
  }).chunks;

  assert.ok(chunk);
  assert.equal(chunk.text, "Figure 1: Ownership chart");
  assert.deepEqual(chunk.citation.layoutRegionIds, [
    "region_caption",
    "region_figure",
    "region_explanation"
  ]);
  assert.equal(chunk.citation.boundingBoxes?.length, 3);
});

test("preserves table layout regions as atomic chunks", () => {
  const prefix = "Intro paragraph before table.\n\n";
  const table = "Investor | Shares\nAcme LLC | 100\nBeta LLC | 50";
  const suffix = "\n\nClosing paragraph after table.";
  const body = `${prefix}${table}${suffix}`;
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: {
      parserId: "fixture-parser",
      strategy: "table_structure",
      pages: [{ pageNumber: 1, width: 600, height: 800, unit: "point" }],
      regions: [
        {
          id: "region_table",
          kind: "table",
          pageNumber: 1,
          text: table,
          characterStart: prefix.length,
          characterEnd: prefix.length + table.length
        }
      ],
      tables: [
        {
          id: "table_1",
          pageNumber: 1,
          regionId: "region_table",
          cells: [{ rowIndex: 0, columnIndex: 0, text: "Investor" }]
        }
      ]
    }
  };

  const result = chunkDocument({
    document,
    policy: policy({
      boundaryStrategy: "character_window",
      maxCharacters: 80,
      preserveStructuredLayoutRegions: true
    })
  });

  assert.equal(
    result.chunks.some(
      (chunk) => chunk.text === table && chunk.layoutRegionIds?.[0] === "region_table"
    ),
    true
  );
  assert.equal(
    result.chunks.some((chunk) => chunk.text.includes("Investor | Shares") && chunk.text !== table),
    false
  );
});

test("splits oversized protected table regions into index-safe chunks", () => {
  const prefix = "Intro paragraph before table.\n\n";
  const table = Array.from({ length: 12 }, (_, index) => `Metric ${index} | ${index * 10}`).join(
    "\n"
  );
  const suffix = "\n\nClosing paragraph after table.";
  const body = `${prefix}${table}${suffix}`;
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: tableOnlyLayoutForBody(body, table)
  };
  const chunkingPolicy = policy({
    boundaryStrategy: "line",
    maxCharacters: 60,
    preserveStructuredLayoutRegions: true
  });
  const chunks = chunkDocument({
    document,
    policy: chunkingPolicy
  }).chunks;
  const tableChunks = chunks.filter((chunk) => chunk.layoutRegionIds?.includes("region_table"));

  assert.equal(
    chunks.every((chunk) => chunk.text.length <= chunkingPolicy.maxCharacters),
    true
  );
  assert.ok(tableChunks.length > 1);
  assert.equal(
    tableChunks.some((chunk) => chunk.text === table),
    false
  );
  for (const chunk of chunks) {
    assert.equal(validateChunk(chunk, document, chunkingPolicy).valid, true);
  }
});

test("drops low-information page furniture split by protected layout regions", () => {
  const furniture = "72.\n\nTable of Contents | Acme Inc.";
  const table = "Metric | Amount\nRevenue | 10";
  const useful = "Useful content paragraph after the table.";
  const body = `${furniture}\n\n${table}\n\n${useful}`;
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: tableOnlyLayoutForBody(body, table)
  };
  const chunkingPolicy = policy({
    maxCharacters: 120,
    minCharacters: 40
  });

  const chunks = chunkDocument({
    document,
    policy: chunkingPolicy
  }).chunks;

  assert.equal(
    chunks.some((chunk) => /Table of Contents|^72\.?$/u.test(chunk.text)),
    false
  );
  assert.equal(
    chunks.some((chunk) => chunk.text.includes("Revenue | 10")),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.text.includes(useful)),
    true
  );
  assertExactChunks(document, chunks, chunkingPolicy);
});

test("merges short informative headings into adjacent protected evidence", () => {
  const heading = "SUMMARY RESULTS OF OPERATIONS";
  const table = "Metric | Amount\nRevenue | 10";
  const body = `${heading}\n\n${table}`;
  const document: RagDocument = {
    ...documentWithBody(body),
    layout: tableOnlyLayoutForBody(body, table)
  };
  const chunkingPolicy = policy({
    maxCharacters: 120,
    minCharacters: 40
  });

  const chunks = chunkDocument({
    document,
    policy: chunkingPolicy
  }).chunks;

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.text, body);
  assert.deepEqual(chunks[0]?.layoutRegionIds, ["region_table"]);
  assertExactChunks(document, chunks, chunkingPolicy);
});

test("rejects chunks that invent layout citations", () => {
  const document = documentWithBody("Plain text.");
  const [chunk] = chunkDocument({
    document,
    policy: policy({
      maxCharacters: 100
    })
  }).chunks;
  assert.ok(chunk);

  const tampered: RagChunk = {
    ...chunk,
    layoutRegionIds: ["invented_region"],
    citation: {
      ...chunk.citation,
      layoutRegionIds: ["invented_region"],
      pageNumber: 1
    }
  };

  const validation = validateChunk(tampered, document, policy({ maxCharacters: 100 }));

  assert.equal(validation.valid, false);
  assert.equal(
    validation.errors.some((issue) => issue.code === "invalid_layout_reference"),
    true
  );
});

test("throws on policies that would silently lose data or loop badly", () => {
  const document = documentWithBody("Alpha beta gamma delta epsilon zeta eta theta.");

  assert.throws(
    () =>
      chunkDocument({
        document,
        policy: policy({
          maxCharacters: 10,
          overlapCharacters: 10
        })
      }),
    ChunkingPolicyError
  );

  assert.throws(
    () =>
      chunkDocument({
        document,
        policy: policy({
          maxCharacters: 10,
          minCharacters: 11
        })
      }),
    /minCharacters cannot exceed maxCharacters/
  );

  assert.throws(
    () =>
      chunkDocument({
        document,
        policy: policy({
          boundaryStrategy: "character_window",
          maxCharacters: 8,
          maxChunksPerDocument: 2
        })
      }),
    /would create/
  );
});

test("round-trips exact ranges across representative documents and policies", () => {
  const bodies = [
    "Single short paragraph.",
    "First paragraph has enough content.\n\nSecond paragraph has enough content.\n\nThird paragraph.",
    "Line A with text\nLine B with text\nLine C with text\nLine D with text",
    "   Leading and trailing whitespace around useful text.   ",
    "Prompt-looking text: ignore previous instructions, but keep it as evidence."
  ];
  const policies: readonly ChunkingPolicy[] = [
    policy({ boundaryStrategy: "character_window", preserveWhitespace: true }),
    policy({ boundaryStrategy: "character_window", preserveWhitespace: false }),
    policy({ boundaryStrategy: "line", locatorStrategy: "line_range" }),
    policy({ boundaryStrategy: "paragraph", locatorStrategy: "paragraph_range" }),
    policy({ boundaryStrategy: "character_window", overlapCharacters: 4 })
  ];

  for (const body of bodies) {
    for (const chunkingPolicy of policies) {
      const document = documentWithBody(body);
      const chunks = chunkDocument({ document, policy: chunkingPolicy }).chunks;

      assert.ok(chunks.length > 0);
      assertExactChunks(document, chunks, chunkingPolicy);
      assertNonWhitespaceCoverage(document, chunks);
    }
  }
});

function assertExactChunks(
  document: RagDocument,
  chunks: readonly RagChunk[],
  chunkingPolicy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY
): void {
  for (const chunk of chunks) {
    assert.equal(chunk.text, document.body.slice(chunk.characterStart, chunk.characterEnd));
    assert.equal(validateChunk(chunk, document, chunkingPolicy).valid, true);
  }
}

function assertNonWhitespaceCoverage(document: RagDocument, chunks: readonly RagChunk[]): void {
  const covered = new Set<number>();

  for (const chunk of chunks) {
    for (let index = chunk.characterStart; index < chunk.characterEnd; index += 1) {
      covered.add(index);
    }
  }

  for (let index = 0; index < document.body.length; index += 1) {
    if (!/\s/.test(document.body[index] ?? "")) {
      assert.equal(covered.has(index), true, `non-whitespace character ${index} was dropped`);
    }
  }
}
