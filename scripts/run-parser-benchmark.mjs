#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildParserBenchmarkReport,
  createBestCombinedLocalParserRouter,
  createOmniDocBenchParseRequest,
  createTableBankParseRequest,
  loadOmniDocBenchCasesFromFile,
  loadTableBankCasesFromFile
} from "../dist/index.js";
import {
  checkParserBenchmarkEnvironment,
  renderParserBenchmarkEnvironmentReport
} from "./check-parser-benchmark-env.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!["omnidocbench", "tablebank"].includes(options.dataset)) {
    throw new Error(`Unsupported parser benchmark dataset "${options.dataset}".`);
  }

  if (!options.skipEnvCheck) {
    const envReport = await checkParserBenchmarkEnvironment({
      dataset: options.dataset,
      inputMode: parserBenchmarkInputMode(options)
    });
    if (envReport.status === "failed") {
      throw new Error(renderParserBenchmarkEnvironmentReport(envReport));
    }
  }

  const cases = await loadCases(options);
  if (cases.length === 0) {
    throw new Error(`No ${options.dataset} benchmark cases were loaded from --annotations.`);
  }
  const parser =
    options.parser === "fixture-layout"
      ? new FixtureLayoutParser(cases)
      : createBestCombinedLocalParserRouter({
          parserId: "benchmark-local-parser",
          requireLayout: true,
          preferTables: true,
          preferVisualAssets: true
        });
  const results = [];

  for (const testCase of cases) {
    try {
      const request = await createParseRequest(testCase, options);
      const parseResult = await parser.parse(request);
      results.push({ testCase, parseResult });
    } catch (error) {
      results.push({
        testCase,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const report = buildParserBenchmarkReport(options.dataset, results, {
    ...(options.minimumTextSimilarity === undefined
      ? {}
      : { minimumTextSimilarity: options.minimumTextSimilarity }),
    ...(options.minimumLayoutRecall === undefined
      ? {}
      : { minimumLayoutRecall: options.minimumLayoutRecall }),
    ...(options.minimumTableRecall === undefined
      ? {}
      : { minimumTableRecall: options.minimumTableRecall }),
    ...(options.minimumFormulaRecall === undefined
      ? {}
      : { minimumFormulaRecall: options.minimumFormulaRecall }),
    ...(options.minimumReadingOrderScore === undefined
      ? {}
      : { minimumReadingOrderScore: options.minimumReadingOrderScore })
  });

  await mkdir(options.reportDir, { recursive: true });
  await writeFile(
    path.join(options.reportDir, "parser-benchmark.json"),
    JSON.stringify(report, null, 2)
  );
  await writeFile(path.join(options.reportDir, "parser-benchmark.md"), renderMarkdown(report));
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    dataset: "omnidocbench",
    parser: "local",
    reportDir: path.join(".rag", "parser-benchmarks", "latest"),
    requestedAt: new Date().toISOString(),
    preferPdf: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dataset":
        options.dataset = requiredValue(args, ++index, arg);
        break;
      case "--parser":
        options.parser = parserValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--annotations":
        options.annotationsPath = requiredValue(args, ++index, arg);
        break;
      case "--images-root":
        options.imagesRoot = requiredValue(args, ++index, arg);
        break;
      case "--pdf-root":
        options.pdfRoot = requiredValue(args, ++index, arg);
        break;
      case "--prefer-pdf":
        options.preferPdf = booleanValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--limit":
        options.limit = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--minimum-text-similarity":
        options.minimumTextSimilarity = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--minimum-layout-recall":
        options.minimumLayoutRecall = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--minimum-table-recall":
        options.minimumTableRecall = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--minimum-formula-recall":
        options.minimumFormulaRecall = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--minimum-reading-order-score":
        options.minimumReadingOrderScore = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--skip-env-check":
        options.skipEnvCheck = booleanValue(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown parser benchmark argument "${arg}".`);
    }
  }

  if (!options.annotationsPath) {
    throw new Error("--annotations is required.");
  }
  if (options.dataset === "omnidocbench" && !options.imagesRoot && !options.pdfRoot) {
    throw new Error("--images-root or --pdf-root is required.");
  }
  if (options.dataset === "tablebank" && !options.imagesRoot) {
    throw new Error("--images-root is required for TableBank.");
  }
  return options;
}

function parserBenchmarkInputMode(options) {
  if (options.dataset === "omnidocbench" && options.pdfRoot && options.preferPdf === true) {
    return "pdf";
  }
  return "image";
}

async function loadCases(options) {
  if (options.dataset === "tablebank") {
    return loadTableBankCasesFromFile(options.annotationsPath, {
      maxCases: options.limit,
      tags: ["parser-benchmark"]
    });
  }
  return loadOmniDocBenchCasesFromFile(options.annotationsPath, {
    maxCases: options.limit,
    tags: ["parser-benchmark"]
  });
}

async function createParseRequest(testCase, options) {
  if (options.dataset === "tablebank") {
    return createTableBankParseRequest(testCase, {
      requestedAt: options.requestedAt,
      imagesRoot: options.imagesRoot
    });
  }
  return createOmniDocBenchParseRequest(testCase, {
    requestedAt: options.requestedAt,
    imagesRoot: options.imagesRoot,
    pdfRoot: options.pdfRoot,
    preferPdf: options.preferPdf
  });
}

function renderMarkdown(report) {
  const lines = [
    "# Parser Benchmark Report",
    "",
    `- Dataset: ${report.dataset}`,
    `- Status: ${report.status}`,
    `- Cases: ${report.caseCount}`,
    `- Passed: ${report.passedCount}`,
    `- Failed: ${report.failedCount}`,
    `- Average text similarity: ${report.averageTextSimilarity}`,
    `- Average layout recall: ${report.averageLayoutRecall}`,
    `- Average table recall: ${report.averageTableRecall}`,
    `- Average formula recall: ${report.averageFormulaRecall}`,
    `- Average reading order score: ${report.averageReadingOrderScore}`,
    "",
    "| Case | Status | Text | Layout | Tables | Formulas | Order | Warnings |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.cases.map(
      (testCase) =>
        `| ${escapeMarkdown(testCase.caseId)} | ${testCase.status} | ${testCase.textSimilarity} | ${testCase.layoutRecall} | ${testCase.tableRecall} | ${testCase.formulaRecall} | ${testCase.readingOrderScore} | ${escapeMarkdown(testCase.warnings.join("; "))} |`
    )
  ];
  return `${lines.join("\n")}\n`;
}

class FixtureLayoutParser {
  id = "parser-benchmark-fixture-layout-parser";
  description = "Fixture parser that turns benchmark annotations into layout regions.";
  version = "1.0.0";
  capabilities = {
    inputMode: "text_or_binary",
    emitsLayout: true,
    emitsTables: true,
    emitsVisualAssets: true
  };

  constructor(cases) {
    this.casesBySourceId = new Map(cases.map((testCase) => [testCase.sourceId, testCase]));
  }

  async parse(request) {
    const testCase = this.casesBySourceId.get(request.sourceId);
    if (!testCase) {
      throw new Error(`Fixture benchmark case not found for source "${request.sourceId}".`);
    }
    const { body, regions } = fixtureBodyAndRegions(testCase);
    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body,
        layout: {
          parserId: this.id,
          parserVersion: this.version,
          strategy: "fixture",
          pages: [
            {
              pageNumber: testCase.page.pageNumber,
              width: testCase.page.width,
              height: testCase.page.height,
              unit: "pixel"
            }
          ],
          regions,
          tables: fixtureTables(testCase)
        }
      },
      warnings: []
    };
  }
}

function fixtureBodyAndRegions(testCase) {
  const bodyParts = [];
  const regions = [];
  for (const annotation of testCase.annotations.filter((entry) => !entry.ignored)) {
    const text = annotation.text ?? annotation.latex ?? textFromHtml(annotation.html ?? "");
    const characterStart = bodyParts.join("\n").length + (bodyParts.length > 0 ? 1 : 0);
    if (text) {
      bodyParts.push(text);
    }
    const characterEnd = characterStart + text.length;
    regions.push({
      id: annotation.id,
      kind: regionKindForBenchmarkCategory(annotation.category),
      pageNumber: testCase.page.pageNumber,
      ...(annotation.box === undefined
        ? {}
        : {
            box: {
              pageNumber: testCase.page.pageNumber,
              x: annotation.box.x,
              y: annotation.box.y,
              width: annotation.box.width,
              height: annotation.box.height,
              unit: "pixel"
            }
          }),
      ...(text ? { text, characterStart, characterEnd } : {}),
      confidence: 1
    });
  }
  const body = bodyParts.join("\n") || testCase.expectedText;
  return { body, regions };
}

function fixtureTables(testCase) {
  return testCase.annotations
    .filter((annotation) => !annotation.ignored && /table/iu.test(annotation.category))
    .map((annotation) => ({
      id: `${annotation.id}_table`,
      regionId: annotation.id,
      pageNumber: testCase.page.pageNumber,
      ...(annotation.box === undefined
        ? {}
        : {
            box: {
              pageNumber: testCase.page.pageNumber,
              x: annotation.box.x,
              y: annotation.box.y,
              width: annotation.box.width,
              height: annotation.box.height,
              unit: "pixel"
            }
          }),
      cells: fixtureTableCells(annotation)
    }));
}

function fixtureTableCells(annotation) {
  const tokens = textFromHtml(annotation.html ?? annotation.text ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  return tokens.map((token, index) => ({
    id: `${annotation.id}_cell_${index + 1}`,
    text: token,
    rowIndex: Math.floor(index / 2),
    columnIndex: index % 2
  }));
}

function regionKindForBenchmarkCategory(category) {
  if (/table/iu.test(category)) return "table";
  if (/formula|equation/iu.test(category)) return "equation";
  if (/figure|image/iu.test(category)) return "figure";
  if (/title/iu.test(category)) return "title";
  return "paragraph";
}

function textFromHtml(value) {
  return String(value)
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function parserValue(value, flag) {
  if (value === "local" || value === "fixture-layout") {
    return value;
  }
  throw new Error(`${flag} must be local or fixture-layout.`);
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function scoreValue(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number from 0 to 1.`);
  }
  return parsed;
}

function booleanValue(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${flag} must be true or false.`);
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

await main();
