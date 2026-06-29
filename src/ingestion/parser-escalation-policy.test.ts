import assert from "node:assert/strict";
import test from "node:test";

import { buildParserEscalationRecommendations } from "./parser-escalation-policy.js";
import type { ParserQualityWarning } from "./parser-quality.js";

test("parser escalation policy maps table and visual warnings to stronger parser targets", () => {
  const recommendations = buildParserEscalationRecommendations({
    warnings: [
      warning("doc_1", "parser_table_structure_missing"),
      warning("doc_1", "parser_visual_assets_missing")
    ],
    selectedParserByDocumentId: new Map([["doc_1", "markitdown-command-markdown-parser"]])
  });

  assert.equal(recommendations.length, 1);
  assert.deepEqual(recommendations[0]?.reasons, ["table_structure_needed", "visual_assets_needed"]);
  assert.deepEqual(recommendations[0]?.targetParserIds, [
    "docling-local-layout-parser",
    "mineru-local-layout-parser"
  ]);
});

test("parser escalation policy recommends table parsers for table-only warnings", () => {
  const recommendations = buildParserEscalationRecommendations({
    warnings: [warning("doc_1", "parser_table_structure_missing")],
    selectedParserByDocumentId: new Map([["doc_1", "markitdown-command-markdown-parser"]])
  });

  assert.deepEqual(recommendations[0]?.targetParserIds, [
    "docling-local-layout-parser",
    "mineru-local-layout-parser"
  ]);
});

test("parser escalation policy maps low page coverage to OCR-capable targets", () => {
  const recommendations = buildParserEscalationRecommendations({
    warnings: [warning("doc_pdf", "parser_page_text_coverage_low")],
    selectedParserByDocumentId: new Map([["doc_pdf", "pdf_text-local-layout-parser"]])
  });

  assert.deepEqual(recommendations[0]?.reasons, ["ocr_needed"]);
  assert.deepEqual(recommendations[0]?.targetParserIds, ["paddleocr-local-layout-parser"]);
});

test("parser escalation policy ignores non-escalating quality warnings", () => {
  const recommendations = buildParserEscalationRecommendations({
    warnings: [warning("doc_low", "parser_score_below_threshold")],
    selectedParserByDocumentId: new Map([["doc_low", "plain-text-parser"]])
  });

  assert.deepEqual(recommendations, []);
});

function warning(documentId: string, code: ParserQualityWarning["code"]): ParserQualityWarning {
  return {
    documentId,
    sourceId: "source",
    code,
    message: code
  };
}
