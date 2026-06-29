import assert from "node:assert/strict";
import test from "node:test";

import type { RagDocument } from "../documents/document.js";
import { analyzeParserQualityForDocuments } from "./parser-quality.js";

interface ParserTraceFixture {
  readonly selectedParserId?: string;
  readonly selectedTier?: string;
  readonly selectedQualityScore?: number;
  readonly attempts: readonly Readonly<Record<string, unknown>>[];
}

const baseDocument: RagDocument = {
  id: "doc_parser_quality",
  namespaceId: "generic-docs",
  title: "Parser Quality",
  body: "Parser quality evidence.",
  provenance: {
    sourceId: "curated_docs",
    sourceKind: "local_file",
    title: "Parser Quality",
    ingestedAt: "2026-06-25T00:00:00.000Z",
    trustTier: "trusted_internal",
    sensitivity: "internal"
  },
  accessScope: {
    tenantId: "tenant_1",
    namespaceId: "generic-docs"
  }
};

test("parser quality analyzer reports low scores, fallback, rejected, and failed attempts", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace("doc_low", {
      selectedParserId: "fallback-parser",
      selectedTier: "fallback",
      selectedQualityScore: 65,
      attempts: [
        {
          parserId: "fast-parser",
          tier: "fast_native",
          status: "rejected",
          qualityScore: 40,
          reasons: ["layout was required but missing"]
        },
        {
          parserId: "layout-parser",
          tier: "layout_local",
          status: "failed",
          reasons: ["parser failed during parse with Error"]
        },
        {
          parserId: "fallback-parser",
          tier: "fallback",
          status: "accepted",
          qualityScore: 65
        }
      ]
    })
  ]);

  assert.equal(result.summary.documentCount, 1);
  assert.equal(result.summary.tracedDocumentCount, 1);
  assert.equal(result.summary.averageSelectedScore, 65);
  assert.equal(result.summary.lowScoreDocumentCount, 1);
  assert.equal(result.summary.fallbackSelectedCount, 1);
  assert.equal(result.summary.failedAttemptCount, 1);
  assert.equal(result.summary.rejectedAttemptCount, 1);
  assert.equal(result.summary.readiness.status, "insufficient");
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    [
      "parser_score_below_threshold",
      "parser_fallback_selected",
      "parser_failed_attempts",
      "parser_rejected_attempts"
    ]
  );
});

test("parser quality analyzer counts benign rejected attempts without warning", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace("doc_escalated_clean", {
      selectedParserId: "docling-local-layout-parser",
      selectedTier: "layout_local",
      selectedQualityScore: 100,
      attempts: [
        {
          parserId: "markitdown-command-markdown-parser",
          tier: "fast_native",
          status: "rejected",
          qualityScore: 67,
          reasons: ["layout was required but missing"]
        },
        {
          parserId: "docling-local-layout-parser",
          tier: "layout_local",
          status: "accepted",
          qualityScore: 100
        }
      ]
    })
  ]);

  assert.equal(result.summary.rejectedAttemptCount, 1);
  assert.equal(result.summary.warningCount, 0);
});

test("parser quality analyzer marks testing ready after enough traced documents", () => {
  const documents = Array.from({ length: 30 }, (_value, index) =>
    documentWithTrace(`doc_${index}`, {
      selectedParserId: "fast-parser",
      selectedTier: "fast_native",
      selectedQualityScore: 100,
      attempts: [
        {
          parserId: "fast-parser",
          tier: "fast_native",
          status: "accepted",
          qualityScore: 100
        }
      ]
    })
  );

  const result = analyzeParserQualityForDocuments(documents);

  assert.equal(result.summary.tracedDocumentCount, 30);
  assert.equal(result.summary.averageSelectedScore, 100);
  assert.equal(result.summary.warningCount, 0);
  assert.equal(result.summary.readiness.status, "ready");
});

test("parser quality analyzer warns when visual parsing handles text-like input", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_visual",
      {
        selectedParserId: "ocr-parser",
        selectedTier: "visual_local",
        selectedQualityScore: 100,
        attempts: [
          {
            parserId: "ocr-parser",
            tier: "visual_local",
            status: "accepted",
            qualityScore: 100
          }
        ]
      },
      {
        contentType: "text/html"
      }
    )
  ]);

  assert.equal(result.summary.visualSelectedForTextLikeDocumentCount, 1);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["parser_visual_selected_for_text_like_document"]
  );
});

test("parser quality analyzer warns when table-like text has no structured tables", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_table_flattened",
      {
        selectedParserId: "markitdown-command-markdown-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 100,
        attempts: [
          {
            parserId: "markitdown-command-markdown-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 100
          }
        ]
      },
      {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      "Investor | Shares\nAcme LLC | 100\nBeta LLC | 50"
    )
  ]);

  assert.equal(result.summary.tableStructureMissingCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "parser_table_structure_missing"));
});

test("parser quality analyzer does not treat JSON or XML metadata as missing tables", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_json_report_index",
      {
        selectedParserId: "plain-text-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 92,
        attempts: [
          {
            parserId: "plain-text-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 92
          }
        ]
      },
      { contentType: "application/json" },
      '{"reports":[{"name":"Balance Sheet","href":"/a"},{"name":"Income Statement","href":"/b"}]}'
    ),
    documentWithTrace(
      "doc_xml_report_index",
      {
        selectedParserId: "markitdown-command-markdown-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 92,
        attempts: [
          {
            parserId: "markitdown-command-markdown-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 92
          }
        ]
      },
      { contentType: "text/xml" },
      "<reports><report>Balance Sheet</report><report>Income Statement</report></reports>"
    )
  ]);

  assert.equal(result.summary.tableStructureMissingCount, 0);
  assert.equal(
    result.warnings.some((warning) => warning.code === "parser_table_structure_missing"),
    false
  );
});

test("parser quality analyzer does not warn for structured table layout", () => {
  const result = analyzeParserQualityForDocuments([
    {
      ...documentWithTrace(
        "doc_table_structured",
        {
          selectedParserId: "openpyxl_command-structured-parser",
          selectedTier: "fast_native",
          selectedQualityScore: 100,
          attempts: [
            {
              parserId: "openpyxl_command-structured-parser",
              tier: "fast_native",
              status: "accepted",
              qualityScore: 100
            }
          ]
        },
        { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        "Investor | Shares\nAcme LLC | 100"
      ),
      layout: {
        parserId: "openpyxl",
        strategy: "table_structure",
        pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
        regions: [
          {
            id: "table_region",
            kind: "table",
            pageNumber: 1,
            text: "Investor | Shares\nAcme LLC | 100",
            characterStart: 0,
            characterEnd: 32
          }
        ],
        tables: [{ id: "table_1", pageNumber: 1, regionId: "table_region", cells: [] }]
      }
    }
  ]);

  assert.equal(result.summary.tableStructureMissingCount, 0);
  assert.equal(
    result.warnings.some((warning) => warning.code === "parser_table_structure_missing"),
    false
  );
});

test("parser quality analyzer warns when visual references have no visual assets", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_visual_missing",
      {
        selectedParserId: "markitdown-command-markdown-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 100,
        attempts: [
          {
            parserId: "markitdown-command-markdown-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 100
          }
        ]
      },
      { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      "See Figure 4 for the refund workflow diagram."
    )
  ]);

  assert.equal(result.summary.visualAssetsMissingCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "parser_visual_assets_missing"));
});

test("parser quality analyzer warns when MarkItDown handles layout-risk documents without layout", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_layout_risk",
      {
        selectedParserId: "markitdown-command-markdown-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 100,
        attempts: [
          {
            parserId: "markitdown-command-markdown-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 100
          }
        ]
      },
      { contentType: "application/pdf" },
      "Clean text extracted from a PDF."
    )
  ]);

  assert.equal(result.summary.layoutMissingForComplexDocumentCount, 1);
  assert.equal(result.summary.markdownSelectedForLayoutRiskCount, 1);
  assert.ok(
    result.warnings.some((warning) => warning.code === "parser_layout_missing_for_complex_document")
  );
  assert.ok(
    result.warnings.some((warning) => warning.code === "parser_markdown_selected_for_layout_risk")
  );
});

test("parser quality analyzer warns when layout has pages without text", () => {
  const result = analyzeParserQualityForDocuments([
    {
      ...documentWithTrace(
        "doc_sparse_pages",
        {
          selectedParserId: "pdf_text-local-layout-parser",
          selectedTier: "layout_local",
          selectedQualityScore: 100,
          attempts: [
            {
              parserId: "pdf_text-local-layout-parser",
              tier: "layout_local",
              status: "accepted",
              qualityScore: 100
            }
          ]
        },
        { contentType: "application/pdf" },
        "Only page one extracted text."
      ),
      layout: {
        parserId: "pdf_text",
        strategy: "text_extraction",
        pages: [
          { pageNumber: 1, width: 1, height: 1, unit: "normalized" },
          { pageNumber: 2, width: 1, height: 1, unit: "normalized" },
          { pageNumber: 3, width: 1, height: 1, unit: "normalized" }
        ],
        regions: [
          {
            id: "page_1_text",
            kind: "paragraph",
            pageNumber: 1,
            text: "Only page one extracted text.",
            characterStart: 0,
            characterEnd: 29
          }
        ]
      }
    }
  ]);

  assert.equal(result.summary.pageTrackedDocumentCount, 1);
  assert.equal(result.summary.lowPageTextCoverageDocumentCount, 1);
  assert.equal(result.summary.emptyPageCount, 2);
  assert.ok(result.warnings.some((warning) => warning.code === "parser_page_text_coverage_low"));
});

test("parser quality analyzer can use page coverage metadata without layout", () => {
  const result = analyzeParserQualityForDocuments([
    documentWithTrace(
      "doc_page_metadata",
      {
        selectedParserId: "markitdown-command-markdown-parser",
        selectedTier: "fast_native",
        selectedQualityScore: 100,
        attempts: [
          {
            parserId: "markitdown-command-markdown-parser",
            tier: "fast_native",
            status: "accepted",
            qualityScore: 100
          }
        ]
      },
      { contentType: "application/pdf", pageCount: 10, pagesWithText: 7 },
      "Seven pages of text."
    )
  ]);

  assert.equal(result.summary.pageTrackedDocumentCount, 1);
  assert.equal(result.summary.lowPageTextCoverageDocumentCount, 1);
  assert.equal(result.summary.emptyPageCount, 3);
});

test("parser quality analyzer warns when selected result is marked failed", () => {
  const result = analyzeParserQualityForDocuments([
    {
      ...baseDocument,
      id: "doc_failed_result",
      metadata: {
        parserFailed: true,
        parserFailureCode: "command_layout_failed",
        contentType: "text/plain"
      }
    }
  ]);

  assert.equal(result.summary.failedResultSelectedCount, 1);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["parser_failed_result_selected"]
  );
});

test("parser quality analyzer still checks content heuristics without router trace", () => {
  const result = analyzeParserQualityForDocuments([
    {
      ...baseDocument,
      id: "doc_untraced_table",
      body: "Investor | Shares\nAcme LLC | 100",
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      }
    }
  ]);

  assert.equal(result.summary.tracedDocumentCount, 0);
  assert.equal(result.summary.untracedDocumentCount, 1);
  assert.equal(result.summary.tableStructureMissingCount, 1);
  assert.equal(result.summary.layoutMissingForComplexDocumentCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "parser_table_structure_missing"));
  assert.ok(
    result.warnings.some((warning) => warning.code === "parser_layout_missing_for_complex_document")
  );
});

function documentWithTrace(
  id: string,
  trace: ParserTraceFixture,
  metadata: Readonly<Record<string, string | number | boolean>> = {},
  body = baseDocument.body
): RagDocument {
  return {
    ...baseDocument,
    id,
    body,
    metadata: {
      ...metadata,
      parserRouterSelectedScore: trace.selectedQualityScore ?? 100,
      parserRouterTraceJson: JSON.stringify(trace)
    }
  };
}
