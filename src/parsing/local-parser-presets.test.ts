import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import type { CommandLayoutParserInput } from "./command-layout-parser.js";
import {
  commandForLocalVisualParser,
  commandForLocalStructuredParser,
  createBestCombinedLocalParserRouter,
  createLocalDocumentParserRouter,
  defaultLocalStructuredParsers,
  defaultLocalVisualParsers,
  localStructuredParserCandidates,
  localVisualParserCandidates,
  policyForLocalDocumentParserPreset
} from "./local-parser-presets.js";
import type { DocumentParseRequest } from "./parser.js";

const requestedAt = "2026-06-25T00:00:00.000Z";

test("local parser router uses native text before local visual parsers when good enough", async () => {
  const visualInputs: CommandLayoutParserInput[] = [];
  const router = createLocalDocumentParserRouter({
    visualParsers: [
      {
        engine: "docling",
        runner: async (_command, input) => {
          visualInputs.push(input);
          return { body: "layout text", layout: layoutFixture("docling") };
        }
      }
    ]
  });

  const result = await router.parse(textRequest("Enough native text."));

  assert.equal(result.document.body, "Enough native text.");
  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "plain-text-parser");
  assert.equal(visualInputs.length, 0);
});

test("local parser router escalates to local visual parser when layout is required", async () => {
  const router = createLocalDocumentParserRouter({
    requireLayout: true,
    visualParsers: [
      {
        engine: "paddleocr",
        runner: async () => ({ body: "layout text", layout: layoutFixture("paddleocr") })
      }
    ]
  });

  const result = await router.parse(textRequest("Enough native text.", "application/pdf"));

  assert.equal(result.document.layout?.parserId, "paddleocr");
  assert.equal(
    result.document.metadata?.["parserRouterSelectedParserId"],
    "paddleocr-local-layout-parser"
  );
});

test("local visual parser candidates are local-only and configurable", () => {
  const candidates = localVisualParserCandidates([
    {
      engine: "custom",
      command: { executable: "/opt/rag/my-parser", args: ["--json"] },
      parserId: "my-local-parser",
      priority: 5
    }
  ]);

  assert.equal(candidates[0]?.tier, "visual_local");
  assert.equal(candidates[0]?.parser.id, "my-local-parser");
  assert.equal(
    commandForLocalVisualParser(defaultLocalVisualParsers()[0]!).args?.[0],
    "scripts/pdf-rag-parser.mjs"
  );
});

test("custom local visual parser requires an explicit command", () => {
  assert.throws(() => commandForLocalVisualParser({ engine: "custom" }), /requires a command/);
});

test("local parser presets encode common open-source RAG parser strategies", () => {
  assert.deepEqual(
    defaultLocalVisualParsers("balanced").map((config) => config.engine),
    ["pdf_text", "docling", "paddleocr", "mineru"]
  );
  assert.deepEqual(
    defaultLocalVisualParsers("ocr_heavy").map((config) => config.engine),
    ["pdf_text", "paddleocr", "mineru", "docling"]
  );
  assert.deepEqual(
    defaultLocalVisualParsers("structure_heavy").map((config) => config.engine),
    ["pdf_text", "docling", "mineru", "paddleocr"]
  );
  assert.deepEqual(policyForLocalDocumentParserPreset("balanced"), {
    requireLayout: false,
    preferTables: false,
    preferVisualAssets: false
  });
  assert.deepEqual(policyForLocalDocumentParserPreset("table_heavy"), {
    requireLayout: true,
    preferTables: true,
    preferVisualAssets: false
  });
});

test("best combined local router tries native PDF text extraction before OCR parsers", async () => {
  const router = createBestCombinedLocalParserRouter({
    visualParsers: [
      {
        engine: "pdf_text",
        runner: async () => ({
          body: "PDF text layer",
          layout: layoutFixture("pdf_text", "PDF text layer")
        })
      },
      {
        engine: "paddleocr",
        runner: async () => ({ body: "ocr text", layout: layoutFixture("paddleocr") })
      }
    ]
  });

  const result = await router.parse(textRequest("", "application/pdf"));

  assert.equal(
    result.document.metadata?.["parserRouterSelectedParserId"],
    "pdf_text-local-layout-parser"
  );
});

test("visual-heavy preset escalates beyond native text and prefers visual assets", async () => {
  const router = createLocalDocumentParserRouter({
    preset: "visual_heavy",
    visualParsers: [
      {
        engine: "paddleocr",
        runner: async () => ({
          body: "layout text",
          layout: {
            ...layoutFixture("paddleocr"),
            visualAssets: [
              {
                id: "figure_1",
                kind: "figure",
                pageNumber: 1,
                mediaType: "image/png"
              }
            ]
          }
        })
      }
    ]
  });

  const result = await router.parse(textRequest("Enough native text.", "application/pdf"));

  assert.equal(result.document.metadata?.["parserRouterSelectedTier"], "visual_local");
});

test("best combined local router parses CSV through structured table path before generic text", async () => {
  const router = createBestCombinedLocalParserRouter({
    visualParsers: [
      {
        engine: "docling",
        runner: async () => ({ body: "docling text", layout: layoutFixture("docling") })
      }
    ]
  });

  const result = await router.parse({
    sourceId: "csv_1",
    sourceKind: "uploaded_file",
    title: "financials.csv",
    contentType: "text/csv",
    text: "Region,Revenue\nNA,120",
    requestedAt
  });

  assert.equal(
    result.document.metadata?.["parserRouterSelectedParserId"],
    "delimited-table-parser"
  );
  assert.equal(result.document.layout?.tables?.[0]?.cells[3]?.text, "120");
});

test("best combined local router parses SEC HTML through native SEC parser before generic text", async () => {
  const router = createBestCombinedLocalParserRouter();

  const result = await router.parse({
    sourceId: "sec_1",
    sourceKind: "local_file",
    title: "exhibit21.htm",
    contentType: "text/html",
    text: `<DOCUMENT><TEXT><html><body><table><tr><td>Name</td><td>Jurisdiction</td></tr><tr><td>Google LLC</td><td>Delaware</td></tr></table></body></html></TEXT></DOCUMENT>`,
    requestedAt
  });

  assert.equal(result.document.metadata?.["parserRouterSelectedParserId"], "sec-html-parser");
  assert.equal(result.document.layout?.tables?.[0]?.cells[2]?.text, "Google LLC");
  assert.equal(result.document.body, "Name | Jurisdiction\nGoogle LLC | Delaware");
});

test("best combined local router exposes swappable openpyxl-style command parser for spreadsheets", () => {
  const candidates = localStructuredParserCandidates([
    {
      engine: "openpyxl_command",
      command: { executable: "/opt/rag/openpyxl-wrapper", args: ["--json"] },
      parserId: "financial-xlsx-parser"
    }
  ]);

  assert.deepEqual(
    defaultLocalStructuredParsers().map((parser) => parser.engine),
    ["delimited_table", "sec_html", "openpyxl_command"]
  );
  assert.equal(candidates[0]?.parser.id, "financial-xlsx-parser");
  assert.equal(
    commandForLocalStructuredParser({ engine: "openpyxl_command" }).args?.[0],
    "scripts/openpyxl-rag-parser.mjs"
  );
  assert.throws(() => commandForLocalStructuredParser({ engine: "sec_html" }), /built in/);
  assert.throws(() => commandForLocalStructuredParser({ engine: "custom" }), /requires a command/);
});

test("best combined local router routes XLSX to OpenPyXL command parser automatically", async () => {
  const router = createBestCombinedLocalParserRouter({
    structuredParsers: [
      { engine: "delimited_table" },
      {
        engine: "openpyxl_command",
        runner: async () => ({
          body: "# Financials\n\nRegion | Revenue\nNA | 120",
          layout: tableLayoutFixture("# Financials\n\nRegion | Revenue\nNA | 120")
        })
      }
    ],
    visualParsers: [
      {
        engine: "docling",
        runner: async () => ({ body: "docling text", layout: layoutFixture("docling") })
      }
    ]
  });

  const result = await router.parse({
    sourceId: "xlsx_1",
    sourceKind: "uploaded_file",
    title: "financials.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  });

  assert.equal(
    result.document.metadata?.["parserRouterSelectedParserId"],
    "openpyxl_command-structured-parser"
  );
  assert.equal(result.document.layout?.tables?.[0]?.cells[3]?.text, "120");
});

test("best combined local router routes XLSM to OpenPyXL command parser automatically", async () => {
  const router = createBestCombinedLocalParserRouter({
    structuredParsers: [
      {
        engine: "openpyxl_command",
        runner: async () => ({
          body: "# MacroExtension\n\nTask | Owner | Status\nRefresh model | Finance | Open",
          layout: tableLayoutFixture(
            "# MacroExtension\n\nTask | Owner | Status\nRefresh model | Finance | Open"
          )
        })
      }
    ],
    visualParsers: []
  });

  const result = await router.parse({
    sourceId: "xlsm_1",
    sourceKind: "uploaded_file",
    title: "macro_extension.xlsm",
    contentType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  });

  assert.equal(
    result.document.metadata?.["parserRouterSelectedParserId"],
    "openpyxl_command-structured-parser"
  );
});

test("best combined local router does not treat legacy XLS as OpenXML", async () => {
  let openPyxlAttempted = false;
  const router = createBestCombinedLocalParserRouter({
    structuredParsers: [
      {
        engine: "openpyxl_command",
        runner: async () => {
          openPyxlAttempted = true;
          return {
            body: "should not parse",
            layout: tableLayoutFixture("should not parse")
          };
        }
      }
    ],
    visualParsers: []
  });

  await assert.rejects(
    router.parse({
      sourceId: "xls_1",
      sourceKind: "uploaded_file",
      title: "legacy_binary.xls",
      contentType: "application/vnd.ms-excel",
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      requestedAt
    }),
    /No eligible parser candidates/u
  );
  assert.equal(openPyxlAttempted, false);
});

function textRequest(text: string, contentType = "text/plain"): DocumentParseRequest {
  return {
    sourceId: "source_1",
    sourceKind: "uploaded_file",
    title: "Document.pdf",
    contentType,
    text,
    bytes: new Uint8Array([1, 2, 3]),
    requestedAt
  };
}

function layoutFixture(parserId: string, body = "layout text"): DocumentLayout {
  return {
    parserId,
    strategy: "hybrid",
    pages: [{ pageNumber: 1, width: 612, height: 792, unit: "point" }],
    regions: [
      {
        id: "region_1",
        kind: "paragraph",
        pageNumber: 1,
        text: body,
        characterStart: 0,
        characterEnd: body.length
      }
    ],
    tables: [],
    visualAssets: []
  };
}

function tableLayoutFixture(body: string): DocumentLayout {
  return {
    parserId: "openpyxl",
    strategy: "table_structure",
    pages: [{ pageNumber: 1, width: 2, height: 2, unit: "normalized" }],
    regions: [
      {
        id: "region_1",
        kind: "table",
        pageNumber: 1,
        text: body,
        characterStart: 0,
        characterEnd: body.length
      }
    ],
    tables: [
      {
        id: "table_1",
        pageNumber: 1,
        regionId: "region_1",
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Region" },
          { rowIndex: 0, columnIndex: 1, text: "Revenue" },
          { rowIndex: 1, columnIndex: 0, text: "NA" },
          { rowIndex: 1, columnIndex: 1, text: "120" }
        ]
      }
    ],
    visualAssets: []
  };
}
