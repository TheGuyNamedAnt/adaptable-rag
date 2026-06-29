import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentParseResult } from "../parsing/parser.js";
import type { DocumentQaBenchmarkCase } from "./benchmark-types.js";
import {
  buildDocumentQaBenchmarkReport,
  evaluateDocumentQaBenchmarkResult
} from "./document-qa-evaluators.js";

const docVqaCase: DocumentQaBenchmarkCase = {
  dataset: "docvqa",
  id: "42",
  title: "txpn0095_1.png",
  sourceId: "docvqa:42",
  imagePath: "documents/txpn0095_1.png",
  question: "Who signed the letter?",
  acceptedAnswers: ["Edward R. Shannon", "Edward Shannon"],
  tags: ["docvqa"]
};

const chartQaCase: DocumentQaBenchmarkCase = {
  dataset: "chartqa",
  id: "10095_1",
  title: "10095.png",
  sourceId: "chartqa:10095_1",
  imagePath: "10095.png",
  question: "What is the value?",
  acceptedAnswers: ["100"],
  tags: ["chartqa"]
};

test("document QA evaluator passes when accepted answer appears in parsed text", () => {
  const result = evaluateDocumentQaBenchmarkResult(
    docVqaCase,
    parseResult("Signed by Edward Shannon.")
  );

  assert.equal(result.status, "passed");
  assert.equal(result.answerFoundInParsedText, true);
  assert.equal(result.matchedAnswer, "Edward Shannon");
  assert.equal(result.bestAnswerSimilarity, 1);
  assert.equal(result.bestAnlsScore, 1);
  assert.equal(result.relaxedAccuracyScore, 1);
});

test("document QA evaluator reports ANLS with a threshold", () => {
  const result = evaluateDocumentQaBenchmarkResult(
    docVqaCase,
    parseResult("Signed by Edward Shanon."),
    { minimumAnswerSimilarity: 0.95 }
  );

  assert.equal(result.status, "failed");
  assert.ok(result.bestAnswerSimilarity > 0.5);
  assert.equal(result.bestAnlsScore, result.bestAnswerSimilarity);
});

test("document QA evaluator supports ChartQA-style numeric relaxed accuracy", () => {
  const result = evaluateDocumentQaBenchmarkResult(
    chartQaCase,
    parseResult("The extracted chart labels include 104.8.")
  );

  assert.equal(result.status, "failed");
  assert.equal(result.answerFoundInParsedText, false);
  assert.equal(result.matchedAnswer, undefined);
  assert.equal(result.relaxedAccuracyScore, 1);
});

test("document QA evaluator reports failed parses in the benchmark report", () => {
  const report = buildDocumentQaBenchmarkReport("docvqa", [
    { testCase: docVqaCase, parseResult: parseResult("Signed by Edward Shannon.") },
    { testCase: docVqaCase, errorMessage: "parser failed" }
  ]);

  assert.equal(report.status, "failed");
  assert.equal(report.caseCount, 2);
  assert.equal(report.passedCount, 1);
  assert.equal(report.answerFoundCount, 1);
  assert.equal(report.averageBestAnlsScore, 0.5);
  assert.equal(report.relaxedAccuracy, 0.5);
});

test("document QA benchmark report fails empty runs", () => {
  const report = buildDocumentQaBenchmarkReport("docvqa", []);

  assert.equal(report.status, "failed");
  assert.equal(report.caseCount, 0);
  assert.equal(report.passedCount, 0);
});

function parseResult(body: string): DocumentParseResult {
  return {
    sourceId: "docvqa:42",
    parserId: "test-parser",
    document: { body },
    warnings: []
  };
}
