import assert from "node:assert/strict";
import test from "node:test";

import { assertDocumentParserContract } from "./parser-contract.js";
import { DelimitedTableParser, parseDelimitedRows } from "./delimited-table-parser.js";
import type { DocumentParseRequest } from "./parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";

test("delimited table parser preserves CSV cells as table layout", async () => {
  const parser = new DelimitedTableParser();
  const result = await assertDocumentParserContract({
    parser,
    request: request("Region,Revenue\nNA,120\nEU,90", "text/csv"),
    expectations: { requireLayout: true }
  });

  assert.equal(result.layoutIssueCount, 0);
  const parsed = await parser.parse(request("Region,Revenue\nNA,120\nEU,90", "text/csv"));
  assert.equal(parsed.document.layout?.tables?.[0]?.cells.length, 6);
  assert.equal(parsed.document.layout?.tables?.[0]?.cells[3]?.text, "120");
});

test("delimited table parser supports quoted commas and TSV", () => {
  assert.deepEqual(parseDelimitedRows('"Region, Name",Revenue\nNA,120', ","), [
    ["Region, Name", "Revenue"],
    ["NA", "120"]
  ]);
  assert.deepEqual(parseDelimitedRows("Region\tRevenue\nEU\t90", "\t"), [
    ["Region", "Revenue"],
    ["EU", "90"]
  ]);
});

function request(text: string, contentType: string): DocumentParseRequest {
  return {
    sourceId: "table_1",
    sourceKind: "uploaded_file",
    title: contentType === "text/csv" ? "financials.csv" : "financials.tsv",
    contentType,
    text,
    requestedAt
  };
}
