#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDocumentQaBenchmarkReport,
  createBestCombinedLocalParserRouter,
  createChartQaParseRequest,
  createDocVqaParseRequest,
  loadChartQaCasesFromFile,
  loadDocVqaCasesFromFile,
  runDocumentQaRagBenchmark
} from "../dist/index.js";

class FixtureTextPageParser {
  id = "document-qa-fixture-text-parser";
  description = "Fixture parser that turns annotation text into one page-level layout region.";
  version = "1.0.0";
  capabilities = {
    inputMode: "text",
    emitsLayout: true,
    emitsTables: false,
    emitsVisualAssets: false,
    supportedContentTypes: ["text/plain"]
  };

  async parse(request) {
    const body = request.text ?? "";
    const pageNumber = numericMetadata(request.metadata?.expectedCitationPageNumber) ?? 1;
    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body,
        layout: {
          parserId: this.id,
          parserVersion: this.version,
          strategy: "text_extraction",
          pages: [
            {
              pageNumber,
              width: 1,
              height: 1,
              unit: "normalized"
            }
          ],
          regions: [
            {
              id: `page_${pageNumber}_body`,
              kind: "paragraph",
              pageNumber,
              box: {
                pageNumber,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                unit: "normalized"
              },
              text: body,
              characterStart: 0,
              characterEnd: body.length,
              confidence: 1
            }
          ]
        },
        ...(request.metadata === undefined ? {} : { metadata: request.metadata })
      },
      warnings: []
    };
  }
}

const options = parseArgs(process.argv.slice(2));

if (!["docvqa", "chartqa"].includes(options.dataset)) {
  throw new Error(`Unsupported document QA benchmark dataset "${options.dataset}".`);
}

const { cases, createParseRequest } = await loadBenchmarkCases(options);
if (cases.length === 0) {
  throw new Error(
    `No ${options.dataset} document QA benchmark cases were loaded from --annotations.`
  );
}

const parser =
  options.parser === "fixture-text"
    ? new FixtureTextPageParser()
    : createBestCombinedLocalParserRouter({
        parserId: "benchmark-local-parser",
        requireLayout: true,
        preferVisualAssets: true
      });
const caseRequests = [];
for (const testCase of cases) {
  caseRequests.push({
    testCase,
    parseRequest: await createParseRequest(testCase, {
      requestedAt: options.requestedAt,
      imagesRoot: options.imagesRoot
    })
  });
}

const thresholds = {
  ...(options.minimumAnswerSimilarity === undefined
    ? {}
    : { minimumAnswerSimilarity: options.minimumAnswerSimilarity }),
  ...(options.anlsThreshold === undefined
    ? {}
    : { anlsSimilarityThreshold: options.anlsThreshold }),
  ...(options.numericRelativeTolerance === undefined
    ? {}
    : { numericRelativeTolerance: options.numericRelativeTolerance })
};

const report =
  options.mode === "rag"
    ? await runDocumentQaRagBenchmark({
        dataset: options.dataset,
        cases: caseRequests,
        parser,
        ...(options.topK === undefined ? {} : { topK: options.topK }),
        thresholds,
        now: () => options.requestedAt
      })
    : buildDocumentQaBenchmarkReport(
        options.dataset,
        await runParserOnlyCases(caseRequests, parser),
        thresholds
      );
const outputReport = { benchmarkMode: options.mode, ...report };

await mkdir(options.reportDir, { recursive: true });
await writeFile(
  path.join(options.reportDir, "document-qa-benchmark.json"),
  JSON.stringify(outputReport, null, 2)
);
await writeFile(
  path.join(options.reportDir, "document-qa-benchmark.md"),
  renderMarkdown(report, options.mode)
);
console.log(JSON.stringify(outputReport, null, 2));

if (report.status !== "passed") {
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {
    dataset: "docvqa",
    mode: "parser-only",
    parser: "local",
    reportDir: path.join(".rag", "document-qa-benchmarks", "latest"),
    requestedAt: new Date().toISOString()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dataset":
        options.dataset = requiredValue(args, ++index, arg);
        break;
      case "--mode":
        options.mode = modeValue(requiredValue(args, ++index, arg), arg);
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
      case "--limit":
        options.limit = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--top-k":
        options.topK = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--minimum-answer-similarity":
        options.minimumAnswerSimilarity = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--anls-threshold":
        options.anlsThreshold = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--numeric-relative-tolerance":
        options.numericRelativeTolerance = scoreValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--split":
        options.split = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown document QA benchmark argument "${arg}".`);
    }
  }

  if (!options.annotationsPath) {
    throw new Error("--annotations is required.");
  }
  if (!options.imagesRoot) {
    throw new Error("--images-root is required.");
  }
  return options;
}

async function loadBenchmarkCases(options) {
  if (options.dataset === "docvqa") {
    return {
      cases: await loadDocVqaCasesFromFile(options.annotationsPath, {
        maxCases: options.limit,
        tags: ["document-qa-benchmark"]
      }),
      createParseRequest: createDocVqaParseRequest
    };
  }
  return {
    cases: await loadChartQaCasesFromFile(options.annotationsPath, {
      maxCases: options.limit,
      split: options.split,
      tags: ["document-qa-benchmark"]
    }),
    createParseRequest: createChartQaParseRequest
  };
}

async function runParserOnlyCases(caseRequests, parser) {
  const results = [];
  for (const { testCase, parseRequest } of caseRequests) {
    try {
      results.push({ testCase, parseResult: await parser.parse(parseRequest) });
    } catch (error) {
      results.push({
        testCase,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function renderMarkdown(report, mode) {
  if (mode === "parser-only") {
    const lines = [
      "# Document QA Parser Benchmark Report",
      "",
      "- Mode: parser-only",
      `- Dataset: ${report.dataset}`,
      `- Status: ${report.status}`,
      `- Cases: ${report.caseCount}`,
      `- Passed: ${report.passedCount}`,
      `- Failed: ${report.failedCount}`,
      `- Answer found in parsed text: ${report.answerFoundCount}`,
      `- Average best answer similarity: ${report.averageBestAnswerSimilarity}`,
      `- Average ANLS score: ${report.averageBestAnlsScore}`,
      `- Relaxed accuracy: ${report.relaxedAccuracy}`,
      "",
      "| Case | Status | Answer found | Matched answer | Similarity | ANLS | Relaxed | Question | Warnings |",
      "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- |",
      ...report.cases.map(
        (testCase) =>
          `| ${escapeMarkdown(testCase.caseId)} | ${testCase.status} | ${testCase.answerFoundInParsedText} | ${escapeMarkdown(testCase.matchedAnswer ?? "")} | ${testCase.bestAnswerSimilarity} | ${testCase.bestAnlsScore} | ${testCase.relaxedAccuracyScore} | ${escapeMarkdown(testCase.question)} | ${escapeMarkdown(testCase.warnings.join("; "))} |`
      )
    ];
    return `${lines.join("\n")}\n`;
  }

  const metrics = report.ragMetrics;
  const lines = [
    "# Document QA RAG Benchmark Report",
    "",
    "- Mode: rag",
    `- Dataset: ${report.dataset}`,
    `- Status: ${report.status}`,
    `- Cases: ${report.caseCount}`,
    `- Passed: ${report.passedCount}`,
    `- Failed: ${report.failedCount}`,
    `- Parser failures: ${metrics?.parserFailureCount ?? 0}`,
    `- Ingestion failures: ${metrics?.ingestionFailureCount ?? 0}`,
    `- Retrieval failures: ${metrics?.retrievalFailureCount ?? 0}`,
    `- Citation failures: ${metrics?.citationFailureCount ?? 0}`,
    `- Answer-generation failures: ${metrics?.answerGenerationFailureCount ?? 0}`,
    `- Answer matches: ${metrics?.answerMatchCount ?? 0}`,
    `- Correct citations: ${metrics?.citationCorrectCount ?? 0}`,
    "",
    "| Case | Status | Stage | Answer | Citation | Retrieved | Page(s) | Question | Warnings |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    ...report.cases.map(
      (testCase) =>
        `| ${escapeMarkdown(testCase.caseId)} | ${testCase.status} | ${testCase.failureStage ?? ""} | ${testCase.answerMatch} | ${testCase.citationCorrect} | ${testCase.retrievedChunkCount} | ${escapeMarkdown(testCase.citedPageNumbers.join(", "))} | ${escapeMarkdown(testCase.question)} | ${escapeMarkdown(testCase.warnings.join("; "))} |`
    )
  ];
  return `${lines.join("\n")}\n`;
}

function modeValue(value, flag) {
  if (value === "parser-only" || value === "rag") {
    return value;
  }
  throw new Error(`${flag} must be parser-only or rag.`);
}

function parserValue(value, flag) {
  if (value === "local" || value === "fixture-text") {
    return value;
  }
  throw new Error(`${flag} must be local or fixture-text.`);
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

function numericMetadata(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}
