import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PARSER_CAPABILITY_MATRIX,
  parserCapabilityEntryFor,
  parserEscalationTargetsFor,
  parserHasCapability
} from "./parser-capability-matrix.js";

test("default parser capability matrix defines unique parser ids", () => {
  const ids = DEFAULT_PARSER_CAPABILITY_MATRIX.map((entry) => entry.parserId);
  assert.equal(new Set(ids).size, ids.length);
});

test("MarkItDown is modeled as broad Markdown extraction, not layout parsing", () => {
  const entry = parserCapabilityEntryFor("markitdown-command-markdown-parser");

  assert.ok(entry);
  assert.equal(entry.capabilities.emitsLayout, false);
  assert.equal(entry.capabilities.emitsTables, false);
  assert.equal(entry.capabilities.emitsVisualAssets, false);
  assert.equal(parserHasCapability(entry.parserId, "markdown"), true);
  assert.equal(parserHasCapability(entry.parserId, "layout"), false);
  assert.ok(entry.risks.includes("broad_converter_not_layout_parser"));
  assert.ok(
    entry.recommendedForContentTypes.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
  );
});

test("layout and visual parsers advertise escalation paths for weak fast parses", () => {
  assert.deepEqual(parserEscalationTargetsFor("plain-text-parser"), [
    "markdown-structure-parser",
    "markitdown-command-markdown-parser"
  ]);
  assert.deepEqual(parserEscalationTargetsFor("pdf_text-local-layout-parser"), [
    "docling-local-layout-parser",
    "paddleocr-local-layout-parser"
  ]);
  assert.deepEqual(parserEscalationTargetsFor("mineru-local-layout-parser"), []);
});

test("PDF text layer parser is not modeled as a structured visual parser", () => {
  const entry = parserCapabilityEntryFor("pdf_text-local-layout-parser");

  assert.equal(entry?.capabilities.emitsLayout, true);
  assert.equal(entry?.capabilities.emitsTables, false);
  assert.equal(entry?.capabilities.emitsVisualAssets, false);
  assert.equal(entry?.strengths.includes("tables"), false);
  assert.equal(entry?.strengths.includes("visual_assets"), false);
});

test("table parsers advertise structured table strength", () => {
  assert.equal(parserHasCapability("delimited-table-parser", "tables"), true);
  assert.equal(parserHasCapability("markdown-structure-parser", "tables"), true);
  assert.equal(parserHasCapability("openpyxl_command-structured-parser", "tables"), true);
  assert.equal(parserHasCapability("paddleocr-local-layout-parser", "tables"), false);
  assert.equal(parserHasCapability("plain-text-parser", "tables"), false);
});
