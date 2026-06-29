import assert from "node:assert/strict";
import test from "node:test";

import type { RagDocument } from "../documents/document.js";
import {
  buildParserEscalationRecommendations,
  type ParserEscalationRecommendation
} from "./parser-escalation-policy.js";
import { buildParserDecisionTraces } from "./parser-decision-trace.js";
import type { ParserQualityWarning } from "./parser-quality.js";

test("parser decision traces summarize selected parser attempts and warnings", () => {
  const document = documentWithRouterTrace("doc-1", {
    selectedParserId: "markitdown-command-markdown-parser",
    selectedTier: "fast_local",
    attempts: [
      {
        parserId: "markitdown-command-markdown-parser",
        tier: "fast_local",
        status: "selected",
        qualityScore: 85,
        reasons: ["satisfied parser router policy"]
      },
      {
        parserId: "docling-local-layout-parser",
        tier: "layout_local",
        status: "skipped",
        reasons: ["lower ranked"]
      }
    ]
  });
  const warnings: ParserQualityWarning[] = [
    warning(document, "parser_layout_missing_for_complex_document"),
    warning(document, "parser_markdown_selected_for_layout_risk")
  ];
  const recommendations = buildParserEscalationRecommendations({
    warnings,
    selectedParserByDocumentId: new Map([[document.id, "markitdown-command-markdown-parser"]])
  });

  const traces = buildParserDecisionTraces({
    documents: [document],
    warnings,
    escalationRecommendations: recommendations
  });

  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.selectedParserId, "markitdown-command-markdown-parser");
  assert.equal(traces[0]?.selectedTier, "fast_local");
  assert.equal(traces[0]?.selectedScore, 85);
  assert.equal(traces[0]?.attemptCount, 2);
  assert.equal(traces[0]?.skippedAttemptCount, 1);
  assert.equal(traces[0]?.attempts[0]?.qualityScore, 85);
  assert.deepEqual(traces[0]?.attempts[1]?.reasons, ["lower ranked"]);
  assert.deepEqual(traces[0]?.warningCodes, [
    "parser_layout_missing_for_complex_document",
    "parser_markdown_selected_for_layout_risk"
  ]);
  assert.deepEqual(traces[0]?.escalationReasons, ["layout_needed", "markdown_layout_risk"]);
  assert.deepEqual(traces[0]?.escalationTargetParserIds, [
    "pdf_text-local-layout-parser",
    "docling-local-layout-parser",
    "paddleocr-local-layout-parser",
    "mineru-local-layout-parser"
  ]);
  assert.equal(traces[0]?.needsEscalation, true);
});

test("parser decision traces keep untraced documents auditable", () => {
  const document = baseDocument("doc-2", {});
  const recommendations: ParserEscalationRecommendation[] = [
    {
      documentId: document.id,
      sourceId: document.provenance.sourceId,
      reasons: ["ocr_needed"],
      targetParserIds: [],
      warningCodes: ["parser_page_text_coverage_low"]
    }
  ];

  const traces = buildParserDecisionTraces({
    documents: [document],
    warnings: [warning(document, "parser_page_text_coverage_low")],
    escalationRecommendations: recommendations
  });

  assert.equal(traces[0]?.selectedParserId, undefined);
  assert.equal(traces[0]?.attemptCount, 0);
  assert.deepEqual(traces[0]?.warningCodes, ["parser_page_text_coverage_low"]);
  assert.deepEqual(traces[0]?.escalationReasons, ["ocr_needed"]);
  assert.equal(traces[0]?.needsEscalation, false);
});

function documentWithRouterTrace(id: string, trace: Record<string, unknown>): RagDocument {
  return baseDocument(id, {
    parserRouterSelectedScore: 85,
    parserRouterTraceJson: JSON.stringify(trace)
  });
}

function baseDocument(
  id: string,
  metadata: Readonly<Record<string, string | number | boolean>>
): RagDocument {
  return {
    id,
    namespaceId: "ns",
    title: id,
    body: "body",
    provenance: {
      sourceId: `source-${id}`,
      sourceKind: "uploaded_file",
      title: id,
      originUri: `file://${id}.pdf`,
      ingestedAt: "2026-01-01T00:00:00.000Z",
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant",
      namespaceId: "ns"
    },
    metadata
  };
}

function warning(document: RagDocument, code: ParserQualityWarning["code"]): ParserQualityWarning {
  return {
    documentId: document.id,
    sourceId: document.provenance.sourceId,
    code,
    message: code
  };
}
