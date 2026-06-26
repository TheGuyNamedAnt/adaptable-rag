#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidProfile,
  createBestCombinedLocalParserRouter,
  genericDocsProfile,
  LocalFilesCorpusAdapter
} from "../dist/index.js";
import { normalizeCorpusRecords } from "../dist/corpus/normalize.js";

const DEFAULT_SOURCES_PATH = path.join(".rag", "excel-parser-corpus", "local-files.sources.json");
const DEFAULT_REPORT_DIR = path.join(".rag", "excel-parser-corpus", "validation");
const FIXED_REQUESTED_AT = "2026-06-25T00:00:00.000Z";

const options = parseArgs(process.argv.slice(2));
const profile = assertValidProfile(genericDocsProfile);
const source = profile.corpusSources.find((candidate) => candidate.id === options.sourceId);

if (!source) {
  throw new Error(`Unknown profile source id "${options.sourceId}".`);
}

const localSources = await readLocalFilesSources(options.sourcesPath);
const adapter = new LocalFilesCorpusAdapter({
  sources: localSources,
  parsers: [createBestCombinedLocalParserRouter({ parserId: "best-local-parser" })]
});
const requestedBy = {
  userId: "excel_validator",
  tenantId: "tenant_1",
  namespaceIds: [profile.namespaceId],
  roles: ["admin"],
  tags: ["excel-parser-stress"]
};
const loaded = await adapter.load({
  profile,
  source,
  requestedBy,
  runId: "excel_parser_validation",
  requestedAt: FIXED_REQUESTED_AT
});
const normalized = normalizeCorpusRecords(loaded.records, {
  profile,
  source,
  requestedBy,
  ingestedAt: FIXED_REQUESTED_AT
});
const documentsByPath = new Map(
  normalized.documents.flatMap((document) =>
    typeof document.provenance.path === "string" ? [[document.provenance.path, document]] : []
  )
);
const checks = validateExcelCorpus({
  documentsByPath,
  adapterWarnings: loaded.warnings,
  normalizationIssues: normalized.issues,
  rejectedRecords: normalized.rejectedRecords
});
const summary = summarizeChecks(checks);
const report = {
  status:
    summary.failed === 0 ? (summary.warning === 0 ? "passed" : "passed_with_warnings") : "failed",
  generatedAt: new Date().toISOString(),
  sourcesPath: options.sourcesPath,
  acceptedDocumentCount: normalized.documents.length,
  adapterWarningCount: loaded.warnings.length,
  normalizationIssueCount: normalized.issues.length,
  rejectedRecordCount: normalized.rejectedRecords.length,
  summary,
  checks,
  adapterWarnings: loaded.warnings,
  normalizationIssues: normalized.issues,
  rejectedRecords: normalized.rejectedRecords
};

await mkdir(options.reportDir, { recursive: true });
await writeFile(path.join(options.reportDir, "validation.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(options.reportDir, "validation.md"), renderMarkdown(report));
console.log(JSON.stringify(report, null, 2));

if (summary.failed > 0) {
  process.exitCode = 1;
}

function validateExcelCorpus(input) {
  const checks = [];
  const { documentsByPath, adapterWarnings, normalizationIssues, rejectedRecords } = input;

  checks.push(
    check(
      "normalization_clean",
      "corpus",
      normalizationIssues.length === 0 && rejectedRecords.length === 0,
      "All parsed spreadsheet records pass corpus normalization.",
      `Found ${normalizationIssues.length} normalization issue(s) and ${rejectedRecords.length} rejected record(s).`
    )
  );

  validateMultiSheetFinancials(checks, documentsByPath.get("multi_sheet_financials.xlsx"));
  validateFormulasMergedHidden(
    checks,
    documentsByPath.get("formulas_merged_hidden.xlsx"),
    adapterWarnings
  );
  validateLargeSheet(checks, documentsByPath.get("large_sheet.xlsx"));
  validateMacroExtension(checks, documentsByPath.get("macro_extension.xlsm"));
  validateDelimitedFile(checks, documentsByPath.get("comma_export.csv"), {
    path: "comma_export.csv",
    parserId: "delimited-table-parser",
    requiredText: "Alpha Subsidiary Inc."
  });
  validateDelimitedFile(checks, documentsByPath.get("tab_export.tsv"), {
    path: "tab_export.tsv",
    parserId: "delimited-table-parser",
    requiredText: "Beta Operations GmbH"
  });
  validateExpectedFailure(checks, documentsByPath, adapterWarnings, {
    path: "empty_workbook.xlsx",
    expectedWarningCode: "parser_failed",
    expectedMessage: "body had 0 character"
  });
  validateExpectedFailure(checks, documentsByPath, adapterWarnings, {
    path: "legacy_binary.xls",
    expectedWarningCode: "binary_file_skipped",
    expectedMessage: "Skipped binary-looking file"
  });

  return checks;
}

function validateMultiSheetFinancials(checks, document) {
  const file = "multi_sheet_financials.xlsx";
  checks.push(documentExists(file, document));
  if (!document) {
    return;
  }

  checks.push(parserCheck(file, document, "openpyxl_command-structured-parser"));
  checks.push(metadataCheck(file, "sheet_count", document.metadata?.["sheetCount"] === 3));
  checks.push(layoutTableCountCheck(file, document, 3));
  checks.push(pageNamesCheck(file, document, ["Summary", "Ownership", "Notes"]));
  checks.push(bodyContainsCheck(file, document, "Parent Holdings LLC"));
  checks.push(bodyContainsCheck(file, document, "Alpha Subsidiary Inc."));
  checks.push(bodyContainsCheck(file, document, "Beta Operations GmbH"));
  checks.push(bodyContainsCheck(file, document, "Germany"));
  checks.push(sourceCellCheck(file, document, "Alpha Subsidiary Inc."));
}

function validateFormulasMergedHidden(checks, document, warnings) {
  const file = "formulas_merged_hidden.xlsx";
  checks.push(documentExists(file, document));
  if (!document) {
    return;
  }

  checks.push(parserCheck(file, document, "openpyxl_command-structured-parser"));
  checks.push(metadataCheck(file, "sheet_count", document.metadata?.["sheetCount"] === 2));
  checks.push(bodyContainsCheck(file, document, "Operating Model"));
  checks.push(bodyContainsCheck(file, document, "=SUM(B2:B4)"));
  checks.push(bodyContainsCheck(file, document, "=B6/B5"));
  checks.push(bodyContainsCheck(file, document, "Discount Rate"));
  checks.push(
    check(
      "hidden_sheet_metadata",
      file,
      pageMetadata(document).some(
        (metadata) =>
          metadata?.["sheetName"] === "HiddenAssumptions" && metadata?.["sheetState"] === "hidden"
      ),
      "Hidden sheet state is preserved in page metadata.",
      "HiddenAssumptions sheet metadata was missing or not marked hidden."
    )
  );
  checks.push(
    check(
      "formula_warning",
      file,
      warningsForFile(warnings, file).filter(
        (warning) =>
          warning.code === "parser_warning" &&
          warning.message.includes("formula_without_cached_value")
      ).length >= 4,
      "Formulas without cached values are reported as parser warnings.",
      "Expected formula_without_cached_value warnings were not found."
    )
  );
  checks.push(sourceCellCheck(file, document, "Operating Model"));
  checks.push(
    check(
      "spreadsheet_visual_assets",
      file,
      hasMaterializedVisualAsset(document, "chart") &&
        hasMaterializedVisualAsset(document, "image"),
      "Charts and embedded spreadsheet images are emitted as materialized visual assets.",
      "Expected both chart and image visual assets with existing file URIs."
    )
  );
}

function validateLargeSheet(checks, document) {
  const file = "large_sheet.xlsx";
  checks.push(documentExists(file, document));
  if (!document) {
    return;
  }

  checks.push(parserCheck(file, document, "openpyxl_command-structured-parser"));
  checks.push(metadataCheck(file, "sheet_count", document.metadata?.["sheetCount"] === 1));
  checks.push(bodyContainsCheck(file, document, "Transactions"));
  checks.push(bodyContainsCheck(file, document, "Account 2 | Entity 3"));
  const table = document.layout?.tables?.[0];
  checks.push(
    check(
      "large_sheet_row_count",
      file,
      table?.metadata?.["maxRow"] === 751,
      "Large worksheet preserves expected 751 source rows.",
      `Expected maxRow=751, got ${String(table?.metadata?.["maxRow"])}.`
    )
  );
  checks.push(
    check(
      "large_sheet_column_count",
      file,
      table?.metadata?.["maxColumn"] === 6,
      "Large worksheet preserves expected 6 source columns.",
      `Expected maxColumn=6, got ${String(table?.metadata?.["maxColumn"])}.`
    )
  );
  checks.push(sourceCellCoordinateCheck(file, document, 751, 6));
}

function validateMacroExtension(checks, document) {
  const file = "macro_extension.xlsm";
  checks.push(documentExists(file, document));
  if (!document) {
    return;
  }

  checks.push(parserCheck(file, document, "openpyxl_command-structured-parser"));
  checks.push(bodyContainsCheck(file, document, "Refresh model"));
  checks.push(
    check(
      "xlsm_extension_metadata",
      file,
      document.metadata?.["extension"] === ".xlsm" &&
        document.metadata?.["extensionContentType"] ===
          "application/vnd.ms-excel.sheet.macroEnabled.12",
      "Macro-enabled spreadsheet extension metadata is preserved.",
      "Expected .xlsm extensionContentType metadata was missing."
    )
  );
  checks.push(
    warningCheck(
      "xlsm_vba_payload_gap",
      file,
      document.metadata?.["contentType"] !== "application/vnd.ms-excel.sheet.macroEnabled.12",
      "Generated XLSM fixture has no real VBA payload; signature reads like normal OpenXML."
    )
  );
}

function validateDelimitedFile(checks, document, expectation) {
  checks.push(documentExists(expectation.path, document));
  if (!document) {
    return;
  }

  checks.push(parserCheck(expectation.path, document, expectation.parserId));
  checks.push(bodyContainsCheck(expectation.path, document, expectation.requiredText));
  checks.push(layoutTableCountCheck(expectation.path, document, 1));
}

function validateExpectedFailure(checks, documentsByPath, warnings, expectation) {
  const fileWarnings = warningsForFile(warnings, expectation.path);
  checks.push(
    check(
      "expected_fail_closed_no_document",
      expectation.path,
      !documentsByPath.has(expectation.path),
      "Unsupported or empty spreadsheet did not become an accepted document.",
      "Unexpectedly found an accepted document."
    )
  );
  checks.push(
    check(
      "expected_fail_closed_warning",
      expectation.path,
      fileWarnings.some(
        (warning) =>
          warning.code === expectation.expectedWarningCode &&
          warning.message.includes(expectation.expectedMessage)
      ),
      "Unsupported or empty spreadsheet produced the expected warning.",
      `Expected warning ${expectation.expectedWarningCode} containing "${expectation.expectedMessage}".`
    )
  );
}

function documentExists(file, document) {
  return check(
    "document_exists",
    file,
    document !== undefined,
    "Document was accepted by parser and normalization.",
    "Document was missing from normalized results."
  );
}

function parserCheck(file, document, parserId) {
  return check(
    "selected_parser",
    file,
    document.metadata?.["parserRouterSelectedParserId"] === parserId,
    `Selected parser is ${parserId}.`,
    `Expected ${parserId}, got ${String(document.metadata?.["parserRouterSelectedParserId"])}.`
  );
}

function metadataCheck(file, id, passed) {
  return check(id, file, passed, `${id} metadata matched expectation.`, `${id} metadata mismatch.`);
}

function layoutTableCountCheck(file, document, expectedCount) {
  const actualCount = document.layout?.tables?.length ?? 0;
  return check(
    "table_count",
    file,
    actualCount === expectedCount,
    `Document has ${expectedCount} structured table(s).`,
    `Expected ${expectedCount} structured table(s), got ${actualCount}.`
  );
}

function pageNamesCheck(file, document, expectedNames) {
  const names = pageMetadata(document).map((metadata) => metadata?.["sheetName"]);
  return check(
    "sheet_names",
    file,
    expectedNames.every((name) => names.includes(name)),
    `Sheet names include ${expectedNames.join(", ")}.`,
    `Expected sheet names ${expectedNames.join(", ")}, got ${names.join(", ")}.`
  );
}

function bodyContainsCheck(file, document, text) {
  return check(
    "body_contains",
    file,
    document.body.includes(text),
    `Body contains "${text}".`,
    `Body did not contain "${text}".`
  );
}

function sourceCellCheck(file, document, text) {
  const cell = allCells(document).find((candidate) => candidate.text === text);
  return check(
    "source_cell_coordinates",
    file,
    cell !== undefined &&
      typeof cell.sourceRowNumber === "number" &&
      typeof cell.sourceColumnNumber === "number",
    `Cell "${text}" carries source row/column coordinates.`,
    `Cell "${text}" did not carry source row/column coordinates.`
  );
}

function sourceCellCoordinateCheck(file, document, rowNumber, columnNumber) {
  return check(
    "specific_source_cell_coordinate",
    file,
    allCells(document).some(
      (cell) =>
        cell.sourceRowNumber === rowNumber && cell.sourceColumnNumber === columnNumber && cell.text
    ),
    `Found populated cell at source R${rowNumber}C${columnNumber}.`,
    `Did not find populated cell at source R${rowNumber}C${columnNumber}.`
  );
}

function pageMetadata(document) {
  return document.layout?.pages?.map((page) => page.metadata ?? {}) ?? [];
}

function allCells(document) {
  return document.layout?.tables?.flatMap((table) => table.cells) ?? [];
}

function hasMaterializedVisualAsset(document, assetType) {
  return (document.layout?.visualAssets ?? []).some((asset) => {
    if (asset.metadata?.["assetType"] !== assetType || typeof asset.uri !== "string") {
      return false;
    }
    try {
      return asset.uri.startsWith("file://") && existsSync(fileURLToPath(asset.uri));
    } catch {
      return false;
    }
  });
}

function warningsForFile(warnings, file) {
  return warnings.filter((warning) => warning.message.includes(file));
}

function check(id, file, passed, passMessage, failMessage) {
  return {
    id,
    file,
    status: passed ? "passed" : "failed",
    message: passed ? passMessage : failMessage
  };
}

function warningCheck(id, file, condition, message) {
  return {
    id,
    file,
    status: condition ? "warning" : "passed",
    message
  };
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter((candidate) => candidate.status === "passed").length,
    warning: checks.filter((candidate) => candidate.status === "warning").length,
    failed: checks.filter((candidate) => candidate.status === "failed").length
  };
}

async function readLocalFilesSources(configPath) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) {
    throw new Error(`${configPath} must be an array or an object with sources[].`);
  }

  const baseDirectory = path.dirname(resolvedPath);
  return sources.map((source) => ({
    ...source,
    rootDir: path.isAbsolute(source.rootDir)
      ? source.rootDir
      : path.resolve(baseDirectory, source.rootDir)
  }));
}

function renderMarkdown(report) {
  return [
    "# Excel Parser Validation",
    "",
    `- Status: ${report.status}`,
    `- Sources: \`${report.sourcesPath}\``,
    `- Accepted documents: ${report.acceptedDocumentCount}`,
    `- Adapter warnings: ${report.adapterWarningCount}`,
    `- Normalization issues: ${report.normalizationIssueCount}`,
    "",
    "## Summary",
    "",
    "| Result | Count |",
    "| --- | ---: |",
    `| Passed | ${report.summary.passed} |`,
    `| Warning | ${report.summary.warning} |`,
    `| Failed | ${report.summary.failed} |`,
    `| Total | ${report.summary.total} |`,
    "",
    "## Checks",
    "",
    "| Status | File | Check | Message |",
    "| --- | --- | --- | --- |",
    ...report.checks.map(
      (checkResult) =>
        `| ${checkResult.status} | ${checkResult.file} | ${checkResult.id} | ${escapeMarkdownTable(checkResult.message)} |`
    ),
    ""
  ].join("\n");
}

function escapeMarkdownTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(args) {
  const parsed = {
    sourcesPath: DEFAULT_SOURCES_PATH,
    reportDir: DEFAULT_REPORT_DIR,
    sourceId: "curated_docs"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--sources") {
      parsed.sourcesPath = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--report-dir") {
      parsed.reportDir = requiredValue(arg, value);
      index += 1;
    } else if (arg === "--source-id") {
      parsed.sourceId = requiredValue(arg, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
