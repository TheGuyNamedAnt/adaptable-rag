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

function documentWithTrace(
  id: string,
  trace: ParserTraceFixture,
  metadata: Readonly<Record<string, string | number | boolean>> = {}
): RagDocument {
  return {
    ...baseDocument,
    id,
    metadata: {
      ...metadata,
      parserRouterSelectedScore: trace.selectedQualityScore ?? 100,
      parserRouterTraceJson: JSON.stringify(trace)
    }
  };
}
