import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";

import type { DocumentLayoutRegion } from "../documents/layout.js";
import type { DocumentParseResult } from "../parsing/parser.js";
import type { ParserBenchmarkCase } from "./benchmark-types.js";
import { buildParserBenchmarkReport, evaluateParserBenchmarkResult } from "./parser-evaluators.js";
import { loadTableBankCases } from "./tablebank-loader.js";

const tableBankFixtureCase = loadTableBankCases(
  JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "src",
        "parser-benchmarks",
        "fixtures",
        "tablebank-mini",
        "annotations.json"
      ),
      "utf8"
    )
  )
)[0]!;

const benchmarkCase: ParserBenchmarkCase = {
  dataset: "omnidocbench",
  id: "page_1",
  title: "page_1.png",
  sourceId: "omnidocbench:page_1",
  contentType: "image/png",
  page: { pageNumber: 1, width: 1000, height: 1000, imagePath: "images/page_1.png" },
  annotations: [
    {
      id: "title_1",
      category: "title",
      ignored: false,
      order: 0,
      box: { x: 10, y: 10, width: 500, height: 80 },
      text: "Annual Report"
    },
    {
      id: "table_1",
      category: "table",
      ignored: false,
      order: 1,
      box: { x: 20, y: 140, width: 600, height: 180 },
      html: "<table><tr><td>Revenue</td><td>120</td></tr></table>"
    },
    {
      id: "formula_1",
      category: "equation_isolated",
      ignored: false,
      order: 2,
      box: { x: 30, y: 360, width: 400, height: 80 },
      latex: "E = mc^2"
    }
  ],
  expectedText: "Annual Report\nRevenue 120\nE = mc^2",
  expectedReadingOrder: ["title_1", "table_1", "formula_1"],
  expectedTableHtml: ["<table><tr><td>Revenue</td><td>120</td></tr></table>"],
  expectedFormulaLatex: ["E = mc^2"],
  tags: ["omnidocbench"],
  evaluationScope: {
    text: true,
    layout: true,
    tables: true,
    formulas: true,
    readingOrder: true
  }
};

test("parser benchmark evaluator scores text, layout, tables, formulas, and order", () => {
  const result = evaluateParserBenchmarkResult(benchmarkCase, parseResult());

  assert.equal(result.status, "passed");
  assert.equal(result.textSimilarity, 1);
  assert.equal(result.layoutRecall, 1);
  assert.equal(result.tableRecall, 1);
  assert.equal(result.formulaRecall, 1);
  assert.equal(result.readingOrderScore, 1);
});

test("parser benchmark report marks parser errors as failed cases", () => {
  const report = buildParserBenchmarkReport("omnidocbench", [
    { testCase: benchmarkCase, parseResult: parseResult() },
    { testCase: benchmarkCase, errorMessage: "parser failed" }
  ]);

  assert.equal(report.status, "failed");
  assert.equal(report.caseCount, 2);
  assert.equal(report.passedCount, 1);
  assert.equal(report.failedCount, 1);
});

test("parser benchmark report fails empty runs", () => {
  const report = buildParserBenchmarkReport("omnidocbench", []);

  assert.equal(report.status, "failed");
  assert.equal(report.caseCount, 0);
  assert.equal(report.passedCount, 0);
});

test("parser benchmark evaluator uses benchmark page numbers for layout matching", () => {
  const pageThreeCase: ParserBenchmarkCase = {
    ...benchmarkCase,
    page: { ...benchmarkCase.page, pageNumber: 3 }
  };
  const parsed = parseResult({ pageNumber: 3 });

  const result = evaluateParserBenchmarkResult(pageThreeCase, parsed);

  assert.equal(result.layoutRecall, 1);
  assert.equal(result.tableRecall, 1);
});

test("parser benchmark evaluator can match table content when table box recall is weak", () => {
  const parsed = parseResult({
    tableBox: { pageNumber: 1, x: 800, y: 800, width: 50, height: 50, unit: "pixel" }
  });

  const result = evaluateParserBenchmarkResult(benchmarkCase, parsed);

  assert.equal(result.tableRecall, 1);
});

test("parser benchmark evaluator scores TableBank table box recall from real annotations", () => {
  const parsed = parseResult({
    tableBox: { pageNumber: 1, x: 20, y: 20, width: 120, height: 50, unit: "pixel" },
    tableCells: ["Metric", "Value", "Revenue", "120", "Cost", "75"]
  });

  const result = evaluateParserBenchmarkResult(tableBankFixtureCase, parsed);

  assert.equal(result.status, "passed");
  assert.equal(result.expectedTableCount, 1);
  assert.equal(result.matchedTableCount, 1);
  assert.equal(result.layoutRecall, 1);
  assert.equal(result.tableRecall, 1);
});

test("parser benchmark evaluator scores TableBank table content recall when boxes miss", () => {
  const parsed = parseResult({
    tableBox: { pageNumber: 1, x: 1, y: 1, width: 8, height: 8, unit: "pixel" },
    tableCells: ["Metric", "Value", "Revenue", "120", "Cost", "75"]
  });

  const result = evaluateParserBenchmarkResult(tableBankFixtureCase, parsed, {
    minimumLayoutRecall: 0
  });

  assert.equal(result.layoutRecall, 0);
  assert.equal(result.tableRecall, 1);
  assert.equal(result.matchedTableCount, 1);
});

test("parser benchmark evaluator fails TableBank table recall when box and content both miss", () => {
  const parsed = parseResult({
    tableBox: { pageNumber: 1, x: 1, y: 1, width: 8, height: 8, unit: "pixel" },
    tableCells: ["Unrelated", "Cells"]
  });

  const result = evaluateParserBenchmarkResult(tableBankFixtureCase, parsed, {
    minimumLayoutRecall: 0
  });

  assert.equal(result.status, "failed");
  assert.equal(result.tableRecall, 0);
  assert.deepEqual(result.warnings, ["Table recall 0 below 0.6."]);
});

test("parser benchmark evaluator tolerates table math markup differences on larger tables", () => {
  const mathTableCase: ParserBenchmarkCase = {
    ...benchmarkCase,
    annotations: [
      {
        id: "table_math",
        category: "table",
        ignored: false,
        order: 0,
        box: { x: 20, y: 140, width: 600, height: 180 },
        html: "<table><tr><td>Dimension $(D)$</td><td>$d_{w}$</td><td>$d_{a}$</td><td>$d_{ν}$</td><td>$d_{g}$</td></tr><tr><td>768</td><td>64</td><td>64</td><td>32</td><td>128</td></tr><tr><td>1024</td><td>64</td><td>64</td><td>32</td><td>128</td></tr></table>"
      }
    ],
    expectedText: "Dimension D dw da dν dg 768 64 64 32 128 1024 64 64 32 128",
    expectedReadingOrder: ["table_math"],
    expectedTableHtml: [],
    expectedFormulaLatex: [],
    evaluationScope: {
      text: false,
      layout: false,
      tables: true,
      formulas: false,
      readingOrder: false
    }
  };
  const parsed = parseResult({
    tableBox: { pageNumber: 1, x: 800, y: 800, width: 50, height: 50, unit: "pixel" },
    tableCells: ["Dimension (D)", "dw", "da", "dv", "dg", "768", "64", "32", "128", "1024"]
  });

  const result = evaluateParserBenchmarkResult(mathTableCase, parsed);

  assert.equal(result.tableRecall, 1);
});

test("parser benchmark evaluator treats benchmark text blocks and parser list regions as compatible", () => {
  const parsed = parseResult({
    body: "- Intelligence emerges through the coupling of a physical body.",
    extraRegions: [
      {
        id: "region_bullet",
        kind: "list",
        pageNumber: 1,
        box: { pageNumber: 1, x: 20, y: 140, width: 600, height: 80, unit: "pixel" },
        text: "- Intelligence emerges through the coupling of a physical body.",
        characterStart: 0,
        characterEnd: 61
      }
    ]
  });
  const result = evaluateParserBenchmarkResult(
    {
      ...benchmarkCase,
      annotations: [
        {
          id: "bullet_1",
          category: "text_block",
          ignored: false,
          order: 0,
          box: { x: 20, y: 140, width: 600, height: 80 },
          text: "- Intelligence emerges through the coupling of a physical body."
        }
      ],
      expectedText: "- Intelligence emerges through the coupling of a physical body.",
      expectedReadingOrder: ["bullet_1"],
      expectedTableHtml: [],
      expectedFormulaLatex: [],
      evaluationScope: {
        text: true,
        layout: true,
        tables: false,
        formulas: false,
        readingOrder: true
      }
    },
    parsed
  );

  assert.equal(result.layoutRecall, 1);
});

test("parser benchmark evaluator scores prose text separately from formula fidelity", () => {
  const result = evaluateParserBenchmarkResult(
    {
      ...benchmarkCase,
      annotations: [
        {
          id: "text_1",
          category: "text_block",
          ignored: false,
          order: 0,
          box: { x: 10, y: 10, width: 500, height: 80 },
          text: "The following theorem provides a sufficient condition for exploration."
        },
        {
          id: "formula_1",
          category: "equation_isolated",
          ignored: false,
          order: 1,
          box: { x: 10, y: 120, width: 500, height: 80 },
          latex: "$$S_{\\mathrm{exp}-1}(\\epsilon, \\tau_1, U_e) \\succeq 0$$"
        }
      ],
      expectedText:
        "The following theorem provides a sufficient condition for exploration.\n$$S_{\\mathrm{exp}-1}(\\epsilon, \\tau_1, U_e) \\succeq 0$$",
      expectedReadingOrder: [],
      expectedTableHtml: [],
      expectedFormulaLatex: [],
      evaluationScope: {
        text: true,
        layout: false,
        tables: false,
        formulas: false,
        readingOrder: false
      }
    },
    parseResult({
      body: "The following theorem provides a sufficient condition for exploration.\nSexp junk OCR >= 0"
    })
  );

  assert.equal(result.textSimilarity, 1);
});

test("parser benchmark evaluator tolerates formula latex versus OCR math text", () => {
  const parsed = parseResult({
    body: "The number of parameters is #(Params) = 2DV + 4D + LD (12D + 2 (dw + da + dν + dg) + 19) - (2Ddν + D). (26)"
  });
  const result = evaluateParserBenchmarkResult(
    {
      ...benchmarkCase,
      annotations: [
        {
          id: "formula_params",
          category: "equation_isolated",
          ignored: false,
          order: 0,
          box: { x: 30, y: 360, width: 400, height: 80 },
          latex:
            "$$\\# \\left( \\text{Params}\\right) = {2DV} + {4D} + {LD}\\left( {{12D} + 2\\left( {{d}_{w} + {d}_{a} + {d}_{v} + {d}_{g}}\\right) + {19}}\\right) - \\left( {{2D}{d}_{v} + D}\\right) \\text{.} \\tag{26}$$"
        }
      ],
      expectedText: "",
      expectedReadingOrder: [],
      expectedTableHtml: [],
      expectedFormulaLatex: [],
      evaluationScope: {
        text: false,
        layout: false,
        tables: false,
        formulas: true,
        readingOrder: false
      }
    },
    parsed
  );

  assert.equal(result.formulaRecall, 1);
});

function parseResult(
  options: {
    readonly body?: string;
    readonly pageNumber?: number;
    readonly tableBox?: {
      readonly pageNumber: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly unit: "pixel";
    };
    readonly tableCells?: readonly string[];
    readonly extraRegions?: readonly DocumentLayoutRegion[];
  } = {}
): DocumentParseResult {
  const pageNumber = options.pageNumber ?? 1;
  return {
    sourceId: "omnidocbench:page_1",
    parserId: "test-parser",
    document: {
      body: options.body ?? "Annual Report\nRevenue 120\nE = mc^2",
      layout: {
        parserId: "test-parser",
        strategy: "hybrid",
        pages: [{ pageNumber, width: 1000, height: 1000, unit: "pixel" }],
        regions: [
          {
            id: "region_title",
            kind: "title",
            pageNumber,
            box: { pageNumber, x: 10, y: 10, width: 500, height: 80, unit: "pixel" },
            text: "Annual Report",
            characterStart: 0,
            characterEnd: 13
          },
          {
            id: "region_table",
            kind: "table",
            pageNumber,
            box: options.tableBox ?? {
              pageNumber,
              x: 20,
              y: 140,
              width: 600,
              height: 180,
              unit: "pixel"
            },
            text: "Revenue 120",
            characterStart: 14,
            characterEnd: 25
          },
          {
            id: "region_formula",
            kind: "equation",
            pageNumber,
            box: { pageNumber, x: 30, y: 360, width: 400, height: 80, unit: "pixel" },
            text: "E = mc^2",
            characterStart: 26,
            characterEnd: 34
          },
          ...(options.extraRegions ?? [])
        ],
        tables: [
          {
            id: "table_1",
            pageNumber,
            regionId: "region_table",
            cells: (options.tableCells ?? ["Revenue", "120"]).map((text, columnIndex) => ({
              rowIndex: 0,
              columnIndex,
              text
            }))
          }
        ]
      }
    },
    warnings: []
  };
}
