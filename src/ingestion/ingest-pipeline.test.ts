import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "../chunking/hash.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { RagChunk } from "../documents/chunk.js";
import type { DocumentLayout } from "../documents/layout.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { IndexChunkOptions, IndexOperationResult } from "../indexing/index-types.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW, makeIndexFilter, makePrincipal } from "../test-support/fixtures.js";
import { IngestPipeline, type IngestPipelineResumeState } from "./ingest-pipeline.js";

const profile = assertValidProfile(genericDocsProfile);
const principal = makePrincipal({
  tenantId: "tenant_1",
  namespaceIds: [genericDocsProfile.namespaceId],
  roles: ["admin"],
  tags: ["support"]
});

class StaticAdapter implements CorpusAdapter {
  readonly id = "local-files";
  readonly description = "Static test adapter";
  readonly records: readonly (CorpusRecord | null | undefined)[];
  readonly sourceId: string;

  constructor(records: readonly (CorpusRecord | null | undefined)[], sourceId = "curated_docs") {
    this.records = records;
    this.sourceId = sourceId;
  }

  async load(_request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: this.sourceId,
      records: this.records,
      warnings: []
    };
  }
}

class RejectingDocumentIndex extends InMemoryRagIndex {
  addDocument(): IndexOperationResult {
    return {
      accepted: false,
      id: "record_ingest",
      message: "Document rejected by durable store."
    };
  }
}

class RejectingChunkIndex extends InMemoryRagIndex {
  addChunks(): readonly IndexOperationResult[] {
    return [
      {
        accepted: false,
        id: "record_ingest_chunk_0001",
        message: "Chunk rejected by durable store."
      }
    ];
  }
}

class ValidationThrowingChunkIndex extends InMemoryRagIndex {
  override addChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    options: IndexChunkOptions = {}
  ): readonly IndexOperationResult[] {
    if (documentId === "record_bad_chunk") {
      throw new Error(
        "Chunks rejected by index validation:\ntext: Chunk exceeds maxCharacters=1800."
      );
    }

    return super.addChunks(documentId, chunks, options);
  }
}

function record(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  const body = overrides.body ?? "Refund policy body for ingest pipeline.";

  return {
    id: "record_ingest",
    sourceId: "curated_docs",
    sourceKind: "local_file",
    title: "Ingest Policy",
    body,
    trustTier: "trusted_internal",
    sensitivity: "internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: genericDocsProfile.namespaceId,
      tags: ["support"]
    },
    capturedAt: FIXED_NOW,
    checksum: hashText(body),
    ...overrides
  };
}

function parserPreservationBody(): string {
  return [
    "Revenue Summary",
    "Table 1: Revenue by quarter",
    "Quarter | Revenue",
    "Q1 | 100",
    "gross_margin = gross_profit / revenue",
    "Chart A",
    "OCR note"
  ].join("\n");
}

function parserPreservationLayout(body: string): DocumentLayout {
  const title = span(body, "Revenue Summary");
  const tableCaption = span(body, "Table 1: Revenue by quarter");
  const tableText = span(body, "Quarter | Revenue\nQ1 | 100");
  const headerQuarter = span(body, "Quarter");
  const headerRevenue = span(body, "Revenue", tableText.start);
  const q1 = span(body, "Q1");
  const revenue100 = span(body, "100");
  const equation = span(body, "gross_margin = gross_profit / revenue");
  const figureCaption = span(body, "Chart A");
  const ocrNote = span(body, "OCR note");

  return {
    parserId: "fixture-parser-preservation",
    parserVersion: "1.0.0",
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
      region("region_title", "title", 1, body, title, box(1, 40, 40, 360, 28)),
      region(
        "region_table_caption",
        "table_caption",
        1,
        body,
        tableCaption,
        box(1, 40, 90, 360, 24)
      ),
      region("region_table", "table", 1, body, tableText, box(1, 40, 130, 420, 90)),
      region("region_header_quarter", "text", 1, body, headerQuarter, box(1, 48, 140, 120, 20)),
      region("region_header_revenue", "text", 1, body, headerRevenue, box(1, 190, 140, 120, 20)),
      region("region_cell_q1", "text", 1, body, q1, box(1, 48, 170, 120, 20)),
      region("region_cell_100", "text", 1, body, revenue100, box(1, 190, 170, 120, 20)),
      region("region_equation_margin", "equation", 1, body, equation, box(1, 40, 230, 360, 28)),
      region(
        "region_figure_caption",
        "figure_caption",
        2,
        body,
        figureCaption,
        box(2, 40, 90, 180, 24)
      ),
      {
        id: "region_figure",
        kind: "figure",
        pageNumber: 2,
        box: box(2, 40, 130, 320, 180)
      },
      {
        id: "region_page_image",
        kind: "page_image",
        pageNumber: 2,
        box: box(2, 0, 0, 600, 800)
      },
      region("region_ocr_note", "text", 2, body, ocrNote, box(2, 40, 330, 180, 24))
    ],
    relations: [
      {
        id: "relation_caption_for_figure",
        kind: "caption_for",
        fromRegionId: "region_figure_caption",
        toRegionId: "region_figure"
      }
    ],
    tables: [
      {
        id: "table_revenue",
        pageNumber: 1,
        regionId: "region_table",
        captionRegionId: "region_table_caption",
        box: box(1, 40, 130, 420, 90),
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Quarter", regionId: "region_header_quarter" },
          { rowIndex: 0, columnIndex: 1, text: "Revenue", regionId: "region_header_revenue" },
          { rowIndex: 1, columnIndex: 0, text: "Q1", regionId: "region_cell_q1" },
          { rowIndex: 1, columnIndex: 1, text: "100", regionId: "region_cell_100" }
        ],
        summary: "Revenue table has one Q1 row."
      }
    ],
    visualAssets: [
      {
        id: "figure_1",
        kind: "figure",
        pageNumber: 2,
        mediaType: "image/png",
        uri: "memory://chart-a.png",
        box: box(2, 40, 130, 320, 180)
      }
    ]
  };
}

function span(
  body: string,
  text: string,
  fromIndex = 0
): { readonly start: number; readonly end: number } {
  const start = body.indexOf(text, fromIndex);
  assert.notEqual(start, -1, `fixture span not found: ${text}`);
  return { start, end: start + text.length };
}

function region(
  id: string,
  kind: NonNullable<DocumentLayout["regions"][number]>["kind"],
  pageNumber: number,
  body: string,
  textSpan: { readonly start: number; readonly end: number },
  layoutBox: NonNullable<DocumentLayout["regions"][number]["box"]>
): DocumentLayout["regions"][number] {
  return {
    id,
    kind,
    pageNumber,
    text: body.slice(textSpan.start, textSpan.end),
    characterStart: textSpan.start,
    characterEnd: textSpan.end,
    box: layoutBox
  };
}

function box(
  pageNumber: number,
  x: number,
  y: number,
  width: number,
  height: number
): NonNullable<DocumentLayout["regions"][number]["box"]> {
  return {
    pageNumber,
    x,
    y,
    width,
    height,
    unit: "point"
  };
}

test("ingests adapter records through normalization, chunking, and indexing", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "ingest_test",
    requestedAt: FIXED_NOW
  });

  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  assert.equal(result.runId, "ingest_test");
  assert.deepEqual(result.loadedSourceIds, ["curated_docs"]);
  assert.equal(result.documents.length, 1);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.rejectedRecords.length, 0);
  assert.equal(index.findDocuments(filter).length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("ingests parser-derived searchable artifacts into the RAG chunk store", async () => {
  const body = parserPreservationBody();
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        id: "record_parser_searchability",
        title: "Parser Searchability",
        body,
        layout: parserPreservationLayout(body),
        metadata: {
          contentType: "application/pdf"
        }
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "ingest_parser_searchability",
    requestedAt: FIXED_NOW
  });
  const storedChunks = index
    .findChunks(
      makeIndexFilter({
        namespaceId: genericDocsProfile.namespaceId,
        principal,
        tenantId: principal.tenantId
      })
    )
    .map((indexed) => indexed.chunk);
  const storedUnitTypes = new Set(
    storedChunks
      .map((chunk) => chunk.metadata?.["searchableUnitType"])
      .filter((unitType): unitType is string => typeof unitType === "string")
  );

  assert.equal(result.documents.length, 1);
  assert.equal(result.searchableArtifactWarnings?.length ?? 0, 0);
  assert.equal(storedChunks.length, result.chunks.length);
  for (const unitType of [
    "table_chunk",
    "table_row_chunk",
    "table_caption_chunk",
    "equation_chunk",
    "visual_asset_chunk",
    "figure_caption_chunk",
    "page_summary_chunk",
    "layout_relation_chunk",
    "parser_gap_chunk"
  ]) {
    assert.equal(storedUnitTypes.has(unitType), true, `missing ${unitType}`);
  }
  assert.equal(
    storedChunks.some((chunk) => chunk.metadata?.["tableId"] === "table_revenue"),
    true
  );
  assert.equal(
    storedChunks.some((chunk) => chunk.metadata?.["visualAssetId"] === "figure_1"),
    true
  );
  assert.equal(
    storedChunks.some(
      (chunk) =>
        chunk.metadata?.["searchableUnitType"] === "equation_chunk" &&
        chunk.text === "gross_margin = gross_profit / revenue"
    ),
    true
  );
  assert.equal(
    storedChunks.some((chunk) =>
      String(chunk.metadata?.["parserGapReasons"] ?? "").includes("page_text_below_threshold")
    ),
    true
  );
});

test("resumes from document checkpoints without reindexing completed documents", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({ id: "record_first", body: "First resumable ingest document." }),
      record({ id: "record_second", body: "Second resumable ingest document." })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  let resumeState: IngestPipelineResumeState = {};
  await assert.rejects(
    pipeline.ingest({
      profile,
      requestedBy: principal,
      runId: "resume_test",
      requestedAt: FIXED_NOW,
      onCheckpoint: (checkpoint) => {
        resumeState = {
          completedSourceIds: checkpoint.completedSourceIds,
          completedDocumentIds: checkpoint.completedDocumentIds
        };
        throw new Error("simulated worker crash");
      }
    }),
    /simulated worker crash/u
  );

  assert.deepEqual(resumeState.completedDocumentIds, ["record_first"]);

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: "resume_test",
    requestedAt: FIXED_NOW,
    resumeState
  });

  assert.deepEqual(
    result.documents.map((document) => document.id),
    ["record_second"]
  );
  assert.equal(
    result.indexResults.every((indexResult) => indexResult.accepted),
    true
  );
  assert.equal(index.stats().documentCount, 2);
});

test("rejects malformed adapter records without indexing them", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      null,
      record({
        id: "record_bad_checksum",
        checksum: hashText("tampered")
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.chunks.length, 0);
  assert.equal(result.rejectedRecords.length, 2);
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "null_record"),
    true
  );
  assert.equal(
    result.normalizationIssues.some((issue) => issue.code === "checksum_mismatch"),
    true
  );
});

test("records adapter source id mismatches as warnings", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()], "wrong_source")]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.adapterWarnings.some((warning) => warning.code === "source_id_mismatch"),
    true
  );
});

test("reports parser quality warnings for accepted parser-backed documents", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        metadata: {
          parserRouterSelectedScore: 65,
          parserRouterTraceJson: JSON.stringify({
            selectedParserId: "fallback-parser",
            selectedTier: "fallback",
            selectedQualityScore: 65,
            attempts: [
              {
                parserId: "native-parser",
                tier: "fast_native",
                status: "rejected",
                qualityScore: 40,
                reasons: ["layout was required but missing"]
              },
              {
                parserId: "fallback-parser",
                tier: "fallback",
                status: "accepted",
                qualityScore: 65
              }
            ]
          })
        }
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.parserQuality.tracedDocumentCount, 1);
  assert.equal(result.parserQuality.lowScoreDocumentCount, 1);
  assert.equal(result.parserQuality.fallbackSelectedCount, 1);
  assert.equal(result.parserQuality.rejectedAttemptCount, 1);
  assert.equal(result.parserQuality.readiness.status, "insufficient");
  assert.deepEqual(
    result.parserQualityWarnings.map((warning) => warning.code),
    ["parser_score_below_threshold", "parser_fallback_selected", "parser_rejected_attempts"]
  );
});

test("does not chunk or report documents when document indexing rejects", async () => {
  const documentIndex = new RejectingDocumentIndex({ now: () => FIXED_NOW });
  const chunkIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: documentIndex,
    chunkStore: chunkIndex,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(
    result.indexResults.some((indexResult) => !indexResult.accepted),
    true
  );
  assert.equal(result.documents.length, 0);
  assert.equal(result.chunks.length, 0);
  assert.equal(
    chunkIndex.hasChunk(
      "record_ingest_chunk_0001",
      makeIndexFilter({
        namespaceId: genericDocsProfile.namespaceId,
        principal,
        tenantId: principal.tenantId
      })
    ),
    false
  );
});

test("skips over-limit documents without committing document-only metadata", async () => {
  const index = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        id: "record_too_large",
        body: ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"].join("\n\n")
      }),
      record({
        id: "record_small",
        body: "Small policy body."
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    chunkingPolicy: {
      ...DEFAULT_CHUNKING_POLICY,
      maxCharacters: 20,
      overlapCharacters: 0,
      minCharacters: 1,
      maxChunksPerDocument: 1,
      boundaryStrategy: "character_window"
    },
    now: () => FIXED_NOW
  });
  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.rejectedRecords.map((rejected) => rejected.recordId),
    ["record_too_large"]
  );
  assert.deepEqual(
    result.chunkingWarnings.map((warning) => warning.code),
    ["max_chunks_per_document_exceeded"]
  );
  assert.equal(index.hasDocument("record_too_large", filter), false);
  assert.equal(index.hasDocument("record_small", filter), true);
  assert.equal(result.documents.length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("rolls back document metadata when chunk index validation fails", async () => {
  const index = new ValidationThrowingChunkIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([
    new StaticAdapter([
      record({
        id: "record_bad_chunk",
        body: "This document chunks cleanly before the chunk store rejects it.",
        accessScope: {
          tenantId: "tenant_1",
          namespaceId: genericDocsProfile.namespaceId,
          roles: ["admin"],
          tags: ["private-cleanup"]
        }
      }),
      record({
        id: "record_after_bad_chunk",
        body: "This document should still be indexed after the bad chunk."
      })
    ])
  ]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: index,
    chunkStore: index,
    now: () => FIXED_NOW
  });
  const filter = makeIndexFilter({
    namespaceId: genericDocsProfile.namespaceId,
    principal,
    tenantId: principal.tenantId
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    result.rejectedRecords.map((rejected) => rejected.recordId),
    ["record_bad_chunk"]
  );
  assert.deepEqual(
    result.chunkingWarnings.map((warning) => warning.code),
    ["chunk_index_validation_failed"]
  );
  assert.equal(index.hasDocument("record_bad_chunk", filter), false);
  assert.equal(index.hasDocument("record_after_bad_chunk", filter), true);
  assert.equal(result.documents.length, 1);
  assert.equal(index.findChunks(filter).length, 1);
});

test("reports only chunks accepted by the chunk store", async () => {
  const documentIndex = new InMemoryRagIndex({ now: () => FIXED_NOW });
  const chunkIndex = new RejectingChunkIndex({ now: () => FIXED_NOW });
  const registry = new CorpusAdapterRegistry([new StaticAdapter([record()])]);
  const pipeline = new IngestPipeline({
    adapterRegistry: registry,
    documentStore: documentIndex,
    chunkStore: chunkIndex,
    now: () => FIXED_NOW
  });

  const result = await pipeline.ingest({
    profile,
    requestedBy: principal,
    requestedAt: FIXED_NOW
  });

  assert.equal(result.documents.length, 1);
  assert.equal(
    result.indexResults.some((indexResult) => !indexResult.accepted),
    true
  );
  assert.equal(result.chunks.length, 0);
});
