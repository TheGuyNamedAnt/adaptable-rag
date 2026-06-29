import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../chunking/chunker.js";
import type { RagDocument } from "../documents/document.js";
import { assertDocumentParserContract } from "./parser-contract.js";
import { SecHtmlParser } from "./sec-html-parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";

test("sec html parser strips SEC HTML and emits validated table layout", async () => {
  const parser = new SecHtmlParser();
  const result = await assertDocumentParserContract({
    parser,
    request: {
      sourceId: "sec_source",
      sourceKind: "local_file",
      title: "exhibit21.htm",
      contentType: "text/html",
      text: secHtmlFixture(),
      requestedAt
    },
    expectations: { requireLayout: true }
  });

  assert.equal(result.layoutIssueCount, 0);

  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "exhibit21.htm",
    contentType: "text/html",
    text: secHtmlFixture(),
    requestedAt
  });

  assert.match(parsed.document.body, /Google LLC \| Delaware/u);
  assert.match(parsed.document.body, /XXVI Holdings Inc\. \| Delaware/u);
  assert.doesNotMatch(parsed.document.body, /<td|style=/iu);
  assert.equal(parsed.document.layout?.tables?.length, 1);
  assert.equal(parsed.document.layout?.tables?.[0]?.cells[0]?.text, "Name of Subsidiary");
});

test("sec html parser batches large tables so chunking preserves row groups without raw HTML", async () => {
  const parser = new SecHtmlParser({
    maxRowsPerTableRegion: 2,
    maxTableRegionCharacters: 120
  });
  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "exhibit21.htm",
    contentType: "text/html",
    text: secHtmlFixture({
      extraRows: [
        ["Alphabet Capital US LLC", "Delaware"],
        ["Google Payment Corp.", "Delaware"],
        ["Google Ireland Holdings Unlimited Company", "Ireland"]
      ]
    }),
    requestedAt
  });

  assert.ok(parsed.document.layout);
  assert.ok((parsed.document.layout.tables?.length ?? 0) > 1);

  const document: RagDocument = {
    id: "doc_1",
    namespaceId: "generic-docs",
    title: "exhibit21",
    body: parsed.document.body,
    provenance: {
      sourceId: "sec_source",
      sourceKind: "local_file",
      title: "exhibit21",
      ingestedAt: requestedAt,
      trustTier: "trusted_internal",
      sensitivity: "internal"
    },
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "generic-docs"
    },
    layout: parsed.document.layout
  };

  const chunks = chunkDocument({ document }).chunks;
  const tableChunks = chunks.filter((chunk) => (chunk.layoutRegionIds ?? []).length > 0);

  assert.ok(tableChunks.length >= 2);
  assert.equal(
    chunks.some((chunk) => chunk.text.includes("<td")),
    false
  );
  assert.equal(
    chunks.some((chunk) => chunk.safetyFlags.includes("oversized_chunk")),
    false
  );
  assert.ok(chunks.some((chunk) => chunk.text.includes("Google LLC | Delaware")));
});

test("sec html parser handles SEC edge markup, spans, and entity decoding", async () => {
  const parser = new SecHtmlParser({
    parserId: "sec-html-custom",
    parserVersion: "2.0.0",
    supportedContentTypes: ["text/html"],
    maxBytes: 10000
  });

  assert.equal(parser.id, "sec-html-custom");
  assert.equal(parser.version, "2.0.0");
  assert.equal(parser.capabilities.maxBytes, 10000);

  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "spans.htm",
    contentType: "text/html",
    text: `<html>
<body>
<div style="display:none">Hidden display text</div>
<ix:header>Hidden ix header</ix:header>
<ix:hidden>Hidden ix payload</ix:hidden>
<section><h1>Visible &amp; &#x41; &#65; &unknown;</h1></section>
<table>
  <tr><th rowspan="2">Name<br>Field</th><th colspan="2">Jurisdiction</th></tr>
  <tr><td colspan="1">Google LLC</td><td>Delaware</td></tr>
  <tr><td>S&ouml;fft Shoe Company, LLC</td><td>Delaware</td></tr>
  <tr><td>Duracell International Operations S&agrave;rl</td><td>Switzerland</td></tr>
</table>
</body>
</html>`,
    requestedAt
  });

  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.document.layout?.parserId, "sec-html-custom");
  assert.equal(parsed.document.layout?.strategy, "table_structure");
  assert.match(parsed.document.body, /Visible & A A/u);
  assert.match(parsed.document.body, /Name Field \| Jurisdiction/u);
  assert.match(parsed.document.body, /Söfft Shoe Company, LLC \| Delaware/u);
  assert.match(parsed.document.body, /Duracell International Operations Sàrl \| Switzerland/u);
  assert.doesNotMatch(parsed.document.body, /Hidden/u);

  const table = parsed.document.layout?.tables?.[0];
  assert.ok(table);
  assert.equal(table.cells[0]?.rowSpan, 2);
  assert.equal(table.cells[1]?.columnSpan, 2);
  assert.equal(table.cells[2]?.columnSpan, undefined);
});

test("sec html parser preserves common Latin named entities in entity labels", async () => {
  const parser = new SecHtmlParser();
  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "latin-entities.htm",
    contentType: "text/html",
    text: `<html>
<body>
<table>
  <tr><td>Name</td><td>Jurisdiction</td></tr>
  <tr><td>Cr&eacute;dit Agricole CIB</td><td>France</td></tr>
  <tr><td>Pe&ntilde;a Holdings LLC</td><td>Spain</td></tr>
  <tr><td>Fran&ccedil;ais Reinsurance Ltd.</td><td>Canada</td></tr>
  <tr><td>M&uuml;nchen Services GmbH</td><td>Germany</td></tr>
</table>
</body>
</html>`,
    requestedAt
  });

  assert.equal(parsed.warnings.length, 0);
  assert.match(parsed.document.body, /Crédit Agricole CIB \| France/u);
  assert.match(parsed.document.body, /Peña Holdings LLC \| Spain/u);
  assert.match(parsed.document.body, /Français Reinsurance Ltd\. \| Canada/u);
  assert.match(parsed.document.body, /München Services GmbH \| Germany/u);
  assert.doesNotMatch(parsed.document.body, /Cr dit|Pe a|Fran ais|M nchen/u);
});

test("sec html parser warns on non-html input without SEC text wrapper", async () => {
  const parser = new SecHtmlParser();
  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "submission.txt",
    contentType: "text/plain",
    bytes: new TextEncoder().encode("Plain submission text without a wrapper."),
    requestedAt
  });

  assert.equal(parsed.warnings[0]?.code, "sec_text_wrapper_missing");
  assert.equal(parsed.document.layout?.strategy, "text_extraction");
  assert.match(parsed.document.body, /Plain submission text without a wrapper/u);
});

test("sec html parser keeps tiny tables as text instead of protected table regions", async () => {
  const parser = new SecHtmlParser();
  const parsed = await parser.parse({
    sourceId: "sec_source",
    sourceKind: "local_file",
    title: "tiny.htm",
    contentType: "text/html",
    text: "<html><body><table><tr><td>A</td><td>B</td></tr></table></body></html>",
    requestedAt
  });

  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.document.layout?.strategy, "text_extraction");
  assert.equal(parsed.document.layout?.tables?.length, 0);
  assert.equal(parsed.document.body, "A | B");
  assert.equal(parsed.document.layout?.regions[0]?.kind, "paragraph");
  assert.equal(parsed.document.layout?.regions[0]?.metadata?.["sourceElement"], "table");
});

function secHtmlFixture(options: { readonly extraRows?: readonly string[][] } = {}): string {
  const rows = [
    ["Name of Subsidiary", "Jurisdiction of Incorporation or Organization"],
    ["Google LLC", "Delaware"],
    ["XXVI Holdings Inc.", "Delaware"],
    ...(options.extraRows ?? [])
  ];
  return `<DOCUMENT>
<TYPE>EX-21
<TEXT>
<html>
<body>
<div style="text-align:center"><font>SUBSIDIARIES OF THE REGISTRANT</font></div>
<div><font>The following is a list of subsidiaries of Alphabet Inc.</font></div>
<table style="border-collapse:collapse">
${rows
  .map(
    (row) =>
      `<tr>${row
        .map(
          (cell) => `<td style="padding:2px"><font style="font-family:Arial">${cell}</font></td>`
        )
        .join("")}</tr>`
  )
  .join("\n")}
</table>
</body>
</html>
</TEXT>
</DOCUMENT>`;
}
