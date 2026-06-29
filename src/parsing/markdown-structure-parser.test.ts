import assert from "node:assert/strict";
import test from "node:test";

import { validateDocumentLayout } from "../documents/layout.js";
import { MarkdownStructureParser, parseMarkdownPipeTables } from "./markdown-structure-parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";

test("markdown structure parser extracts GitHub-style pipe tables", async () => {
  const parser = new MarkdownStructureParser();
  const markdown = [
    "# Parser Smoke Guide",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    "| Revenue | 120 |",
    "| Growth | 25% |",
    "",
    "Formula: gross margin = revenue - cost."
  ].join("\n");

  const parsed = await parser.parse({
    sourceId: "markdown_1",
    sourceKind: "uploaded_file",
    title: "guide.md",
    contentType: "text/markdown",
    text: markdown,
    requestedAt
  });

  assert.equal(parsed.parserId, "markdown-structure-parser");
  assert.equal(parsed.document.body, markdown);
  assert.equal(parsed.document.layout?.tables?.length, 1);
  assert.equal(parsed.document.layout?.tables?.[0]?.cells[0]?.text, "Metric");
  assert.equal(parsed.document.layout?.tables?.[0]?.cells[3]?.text, "120");
  assert.equal(
    parsed.document.layout?.regions.some((region) => region.kind === "heading"),
    true
  );
  assert.equal(validateDocumentLayout(parsed.document.layout, parsed.document.body).valid, true);
});

test("markdown pipe table detector ignores non-table pipe text", () => {
  const tables = parseMarkdownPipeTables("Status | maybe\nNo separator here");

  assert.equal(tables.length, 0);
});
