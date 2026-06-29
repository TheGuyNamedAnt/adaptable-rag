import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentLayout } from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser
} from "../parsing/parser.js";
import type { DocumentQaBenchmarkCase } from "./benchmark-types.js";
import { runDocumentQaRagBenchmark } from "./document-qa-rag-benchmark.js";

const requestedAt = "2026-06-24T00:00:00.000Z";

test("document QA RAG benchmark runs parse, chunk, index, retrieve, answer, and citation scoring", async () => {
  const testCase = benchmarkCase({
    id: "invoice-total",
    question: "What is the total due?",
    acceptedAnswers: ["$42.50"],
    expectedCitationPageNumber: 2
  });
  const report = await runDocumentQaRagBenchmark({
    dataset: "docvqa",
    parser: new FixtureParser("Invoice page\nTotal due: $42.50\nThank you.", 2),
    cases: [{ testCase, parseRequest: parseRequest(testCase) }],
    now: () => requestedAt
  });

  assert.equal(report.status, "passed");
  assert.equal(report.ragMetrics?.answerMatchCount, 1);
  assert.equal(report.ragMetrics?.citationCorrectCount, 1);
  const result = report.cases[0]!;
  assert.equal(result.status, "passed");
  assert.equal(result.answerMatch, true);
  assert.equal(result.citationCorrect, true);
  assert.deepEqual(result.citedPageNumbers, [2]);
  assert.ok(result.retrievedAnswerChunkCount >= 1);
});

test("document QA RAG benchmark reports parser failures when parsed text lacks accepted answers", async () => {
  const testCase = benchmarkCase({
    id: "missing-parser-answer",
    question: "What is the total due?",
    acceptedAnswers: ["$42.50"],
    expectedCitationPageNumber: 2
  });
  const report = await runDocumentQaRagBenchmark({
    dataset: "docvqa",
    parser: new FixtureParser("Invoice page\nNo total was extracted.", 2),
    cases: [{ testCase, parseRequest: parseRequest(testCase) }],
    now: () => requestedAt
  });

  assert.equal(report.status, "failed");
  assert.equal(report.ragMetrics?.parserFailureCount, 1);
  assert.equal(report.cases[0]?.failureStage, "parser");
  assert.equal(report.cases[0]?.retrievedChunkCount, 0);
});

test("document QA RAG benchmark reports retrieval failures separately from parser failures", async () => {
  const testCase = benchmarkCase({
    id: "retrieval-miss",
    question: "Which approval code is assigned?",
    acceptedAnswers: ["$42.50"],
    expectedCitationPageNumber: 2
  });
  const report = await runDocumentQaRagBenchmark({
    dataset: "docvqa",
    parser: new FixtureParser("Invoice page\nTotal due: $42.50\nThank you.", 2),
    cases: [{ testCase, parseRequest: parseRequest(testCase) }],
    now: () => requestedAt
  });

  assert.equal(report.status, "failed");
  assert.equal(report.ragMetrics?.retrievalFailureCount, 1);
  assert.equal(report.cases[0]?.failureStage, "retrieval");
  assert.equal(report.cases[0]?.answerFoundInParsedText, true);
});

function benchmarkCase(input: {
  readonly id: string;
  readonly question: string;
  readonly acceptedAnswers: readonly string[];
  readonly expectedCitationPageNumber: number;
}): DocumentQaBenchmarkCase {
  return {
    dataset: "docvqa",
    id: input.id,
    title: `${input.id}.png`,
    sourceId: `docvqa:${input.id}`,
    imagePath: `${input.id}.png`,
    question: input.question,
    acceptedAnswers: input.acceptedAnswers,
    expectedCitationPageNumber: input.expectedCitationPageNumber,
    tags: ["docvqa", "fixture"]
  };
}

function parseRequest(testCase: DocumentQaBenchmarkCase): DocumentParseRequest {
  return {
    sourceId: testCase.sourceId,
    sourceKind: "uploaded_file",
    title: testCase.title,
    contentType: "text/plain",
    text: "",
    requestedAt,
    metadata: {
      benchmarkCaseId: testCase.id
    }
  };
}

class FixtureParser implements DocumentParser {
  readonly id = "fixture-parser";
  readonly description = "Fixture parser with deterministic body and page layout.";
  readonly version = "1.0.0";
  readonly capabilities = {
    inputMode: "text" as const,
    emitsLayout: true,
    emitsTables: false,
    emitsVisualAssets: false
  };

  constructor(
    private readonly body: string,
    private readonly pageNumber: number
  ) {}

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body: this.body,
        layout: layoutForBody(this.body, this.pageNumber)
      },
      warnings: []
    };
  }
}

function layoutForBody(body: string, pageNumber: number): DocumentLayout {
  return {
    parserId: "fixture-parser",
    parserVersion: "1.0.0",
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
  };
}
