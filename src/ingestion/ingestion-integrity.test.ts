import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayout } from "../documents/layout.js";
import { buildChunkRelationships } from "./chunk-relationships.js";
import type { IngestPipelineResult } from "./ingest-pipeline.js";
import { buildIngestionIntegrityReport } from "./ingestion-integrity.js";
import { buildSearchableArtifacts } from "./searchable-artifacts.js";

const FIXED_NOW = "2026-06-27T00:00:00.000Z";

test("ingestion integrity fails missing OCR, visual, vector, and graph coverage", () => {
  const document = documentWithLayout({
    id: "doc_scan",
    body: "Scanned page placeholder.",
    metadata: { contentType: "application/pdf" },
    layout: {
      parserId: "fixture-parser",
      strategy: "ocr_layout",
      pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
      regions: [{ id: "page_image_region", kind: "page_image", pageNumber: 1 }],
      visualAssets: [
        { id: "page_image_1", kind: "page_image", pageNumber: 1, mediaType: "image/png" }
      ]
    }
  });
  const bodyChunks = chunkDocument({ document }).chunks;
  const searchable = buildSearchableArtifacts({ document, bodyChunks });
  const chunks = [...bodyChunks, ...searchable.chunks];

  const report = buildIngestionIntegrityReport({
    ingest: ingestResult({
      documents: [document],
      chunks,
      searchableWarnings: searchable.warnings
    }),
    postIngest: {
      indexedVectorCount: 0,
      indexedVisualVectorCount: 0,
      knowledgeEntityCount: 0,
      knowledgeRelationCount: 0
    },
    options: {
      requireVectorCoverage: true,
      requireVisualCoverage: true,
      requireGraphCoverage: true
    }
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(
    new Set(report.issues.map((issue) => issue.code)),
    new Set([
      "searchable_artifact_warning",
      "page_needs_ocr",
      "visual_asset_not_searchable",
      "vector_coverage_low",
      "visual_vector_coverage_low",
      "graph_knowledge_missing"
    ])
  );
});

test("ingestion integrity passes source-backed table, visual, page, and relation coverage", () => {
  const document = sourceBackedDocument();
  const bodyChunks = chunkDocument({ document }).chunks;
  const searchable = buildSearchableArtifacts({ document, bodyChunks });
  const chunks = [...bodyChunks, ...searchable.chunks];
  const chunkRelationships = buildChunkRelationships({ documents: [document], chunks });

  const report = buildIngestionIntegrityReport({
    ingest: ingestResult({
      documents: [document],
      chunks,
      chunkRelationships,
      searchableWarnings: searchable.warnings
    }),
    postIngest: {
      indexedVectorCount: chunks.length,
      indexedVisualVectorCount: 1
    },
    options: {
      requireVectorCoverage: true,
      requireVisualCoverage: true
    }
  });

  assert.equal(report.status, "passed");
  assert.equal(report.errorCount, 0);
  assert.equal(report.searchableUnitCounts["table_chunk"], 1);
  assert.equal(report.searchableUnitCounts["visual_asset_chunk"], 1);
  assert.equal(report.searchableUnitCounts["page_summary_chunk"], 1);
  assert.ok((report.searchableUnitCounts["layout_relation_chunk"] ?? 0) >= 1);
});

function ingestResult(input: {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly chunkRelationships?: IngestPipelineResult["chunkRelationships"];
  readonly searchableWarnings?: NonNullable<IngestPipelineResult["searchableArtifactWarnings"]>;
}): IngestPipelineResult {
  return {
    runId: "integrity_test",
    startedAt: FIXED_NOW,
    finishedAt: FIXED_NOW,
    loadedSourceIds: ["curated_docs"],
    documents: input.documents,
    chunks: input.chunks,
    chunkRelationships: input.chunkRelationships ?? [],
    rejectedRecords: [],
    normalizationIssues: [],
    adapterWarnings: [],
    parserQuality: {
      documentCount: input.documents.length,
      tracedDocumentCount: input.documents.length,
      untracedDocumentCount: 0,
      averageSelectedScore: 100,
      lowScoreDocumentCount: 0,
      failedResultSelectedCount: 0,
      fallbackSelectedCount: 0,
      visualSelectedForTextLikeDocumentCount: 0,
      failedAttemptCount: 0,
      rejectedAttemptCount: 0,
      skippedCandidateCount: 0,
      tableStructureMissingCount: 0,
      visualAssetsMissingCount: 0,
      layoutMissingForComplexDocumentCount: 0,
      markdownSelectedForLayoutRiskCount: 0,
      pageTrackedDocumentCount: input.documents.length,
      lowPageTextCoverageDocumentCount: 0,
      emptyPageCount: 0,
      warningCount: 0,
      readiness: {
        status: "ready",
        tracedDocumentCount: input.documents.length,
        minimumTracedDocumentsForTesting: 1,
        recommendedTracedDocumentsForBaseline: 1,
        message: "Ready."
      }
    },
    parserQualityWarnings: [],
    searchableArtifactWarnings: input.searchableWarnings ?? [],
    chunkingWarnings: [],
    indexResults: []
  };
}

function sourceBackedDocument(): RagDocument {
  const body = [
    "Revenue by Region",
    "Revenue table: Q4 revenue summary",
    "Region Revenue",
    "North America 120",
    "Refund workflow diagram"
  ].join("\n");
  return documentWithLayout({
    id: "doc_source_backed",
    body,
    metadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    },
    layout: sourceBackedLayout(body)
  });
}

function documentWithLayout(input: {
  readonly id: string;
  readonly body: string;
  readonly layout: DocumentLayout;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): RagDocument {
  return {
    id: input.id,
    namespaceId: "generic-docs",
    title: input.id,
    body: input.body,
    provenance: {
      sourceId: "curated_docs",
      sourceKind: "local_file",
      title: input.id,
      ingestedAt: FIXED_NOW,
      trustTier: "trusted_internal",
      sensitivity: "internal",
      capturedAt: FIXED_NOW
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs",
      roles: ["reader"]
    },
    layout: input.layout,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata })
  };
}

function sourceBackedLayout(body: string): DocumentLayout {
  const titleStart = body.indexOf("Revenue by Region");
  const captionStart = body.indexOf("Revenue table: Q4 revenue summary");
  const headerStart = body.indexOf("Region Revenue");
  const rowStart = body.indexOf("North America 120");
  const figureCaptionStart = body.indexOf("Refund workflow diagram");
  return {
    parserId: "fixture-parser",
    strategy: "hybrid",
    pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
    regions: [
      {
        id: "title",
        kind: "heading",
        pageNumber: 1,
        text: "Revenue by Region",
        characterStart: titleStart,
        characterEnd: titleStart + "Revenue by Region".length
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
        characterEnd: rowStart + "North America 120".length
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
        id: "caption_for_table",
        kind: "caption_for",
        fromRegionId: "table_caption",
        toRegionId: "table_region"
      },
      {
        id: "caption_for_figure",
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
    visualAssets: [{ id: "figure_1", kind: "figure", pageNumber: 1, mediaType: "image/png" }]
  };
}
