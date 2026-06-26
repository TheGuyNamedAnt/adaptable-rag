import assert from "node:assert/strict";
import test from "node:test";

import { makeDocument } from "../test-support/fixtures.js";
import { classifyDocumentIntelligence } from "./document-intelligence.js";

test("classifies ownership documents as graph-extractable", () => {
  const result = classifyDocumentIntelligence(
    makeDocument({
      id: "doc_shareholder",
      title: "Shareholder Agreement",
      body: "Parent LLC owns Child LLC. The shareholder agreement describes ownership."
    })
  );

  assert.equal(result.docType, "shareholder_agreement");
  assert.equal(result.shouldExtractGraph, true);
  assert.equal(result.signals.includes("ownership_terms"), true);
});

test("classifies support policies without recommending graph extraction", () => {
  const result = classifyDocumentIntelligence(
    makeDocument({
      id: "doc_support",
      title: "Refund Support Policy",
      body: "Refund tickets should be escalated to support when a customer asks for review."
    })
  );

  assert.equal(result.docType, "support_policy");
  assert.equal(result.shouldExtractGraph, false);
  assert.equal(result.signals.includes("support_policy_terms"), true);
});

test("detects structured layout signals for table and figure documents", () => {
  const document = makeDocument({
    id: "doc_layout",
    title: "Cap Table",
    body: "Capitalization table\nInvestor | Shares\nAcme | 100"
  });
  const result = classifyDocumentIntelligence({
    ...document,
    layout: {
      parserId: "fixture",
      strategy: "table_structure",
      pages: [{ pageNumber: 1, width: 600, height: 800, unit: "point" }],
      regions: [
        {
          id: "region_table",
          kind: "table",
          pageNumber: 1,
          characterStart: 0,
          characterEnd: document.body.length
        }
      ],
      tables: [
        {
          id: "table_1",
          pageNumber: 1,
          regionId: "region_table",
          cells: [{ rowIndex: 0, columnIndex: 0, text: "Investor" }]
        }
      ],
      visualAssets: [{ id: "figure_1", kind: "figure", pageNumber: 1, mediaType: "image/png" }]
    }
  });

  assert.equal(result.docType, "cap_table");
  assert.equal(result.shouldPreserveStructuredRegions, true);
  assert.equal(result.signals.includes("has_tables"), true);
  assert.equal(result.signals.includes("has_figures"), true);
});
