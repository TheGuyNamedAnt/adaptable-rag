import type {
  DocumentQaBenchmarkCase,
  DocumentQaBenchmarkCaseEvaluation,
  DocumentQaBenchmarkReport,
  DocumentQaBenchmarkRunResult,
  DocumentQaBenchmarkThresholds
} from "./benchmark-types.js";
import type { DocumentParseResult } from "../parsing/parser.js";

const DEFAULT_THRESHOLDS: Required<DocumentQaBenchmarkThresholds> = {
  minimumAnswerSimilarity: 0.85,
  anlsSimilarityThreshold: 0.5,
  numericRelativeTolerance: 0.05
};

export function evaluateDocumentQaBenchmarkResult(
  testCase: DocumentQaBenchmarkCase,
  parseResult: DocumentParseResult,
  thresholds: DocumentQaBenchmarkThresholds = {}
): DocumentQaBenchmarkCaseEvaluation {
  const normalizedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const score = scoreDocumentQaAnswerText(
    parseResult.document.body,
    testCase.acceptedAnswers,
    normalizedThresholds
  );
  const passed =
    score.answerFound || score.bestSimilarity >= normalizedThresholds.minimumAnswerSimilarity;
  return {
    caseId: testCase.id,
    sourceId: testCase.sourceId,
    status: passed ? "passed" : "failed",
    ...(passed ? {} : { failureStage: "parser" }),
    question: testCase.question,
    ...(score.matchedAnswer === undefined ? {} : { matchedAnswer: score.matchedAnswer }),
    answerFoundInParsedText: score.answerFound,
    answerMatch: false,
    citationCorrect: false,
    ...(testCase.expectedCitationPageNumber === undefined
      ? {}
      : { expectedCitationPageNumber: testCase.expectedCitationPageNumber }),
    citedPageNumbers: [],
    retrievedChunkCount: 0,
    retrievedAnswerChunkCount: 0,
    finalCitationChunkIds: [],
    bestAnswerSimilarity: score.bestSimilarity,
    bestAnlsScore: score.bestAnlsScore,
    relaxedAccuracyScore: score.relaxedAccuracyScore,
    answerSimilarity: 0,
    answerAnlsScore: 0,
    answerRelaxedAccuracyScore: 0,
    acceptedAnswers: testCase.acceptedAnswers,
    warnings: passed
      ? []
      : [
          `No accepted answer found in parsed text; best similarity ${score.bestSimilarity} below ${normalizedThresholds.minimumAnswerSimilarity}, relaxed accuracy ${score.relaxedAccuracyScore}.`
        ]
  };
}

export function buildDocumentQaBenchmarkReport(
  dataset: DocumentQaBenchmarkCase["dataset"],
  results: readonly DocumentQaBenchmarkRunResult[],
  thresholds: DocumentQaBenchmarkThresholds = {}
): DocumentQaBenchmarkReport {
  const cases = results.map((result): DocumentQaBenchmarkCaseEvaluation => {
    if (!result.parseResult) {
      return failedEvaluation(
        result.testCase,
        result.errorMessage ?? "Parser did not return a result."
      );
    }
    return evaluateDocumentQaBenchmarkResult(result.testCase, result.parseResult, thresholds);
  });
  const passedCount = cases.filter((testCase) => testCase.status === "passed").length;
  return {
    dataset,
    status: cases.length > 0 && passedCount === cases.length ? "passed" : "failed",
    caseCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    answerFoundCount: cases.filter((testCase) => testCase.answerFoundInParsedText).length,
    averageBestAnswerSimilarity: average(cases.map((testCase) => testCase.bestAnswerSimilarity)),
    averageBestAnlsScore: average(cases.map((testCase) => testCase.bestAnlsScore)),
    relaxedAccuracy: average(cases.map((testCase) => testCase.relaxedAccuracyScore)),
    cases
  };
}

function failedEvaluation(
  testCase: DocumentQaBenchmarkCase,
  warning: string
): DocumentQaBenchmarkCaseEvaluation {
  return {
    caseId: testCase.id,
    sourceId: testCase.sourceId,
    status: "failed",
    failureStage: "parser",
    question: testCase.question,
    answerFoundInParsedText: false,
    answerMatch: false,
    citationCorrect: false,
    ...(testCase.expectedCitationPageNumber === undefined
      ? {}
      : { expectedCitationPageNumber: testCase.expectedCitationPageNumber }),
    citedPageNumbers: [],
    retrievedChunkCount: 0,
    retrievedAnswerChunkCount: 0,
    finalCitationChunkIds: [],
    bestAnswerSimilarity: 0,
    bestAnlsScore: 0,
    relaxedAccuracyScore: 0,
    answerSimilarity: 0,
    answerAnlsScore: 0,
    answerRelaxedAccuracyScore: 0,
    acceptedAnswers: testCase.acceptedAnswers,
    warnings: [warning]
  };
}

export interface DocumentQaAnswerTextScore {
  readonly answerFound: boolean;
  readonly matchedAnswer?: string;
  readonly bestSimilarity: number;
  readonly bestAnlsScore: number;
  readonly relaxedAccuracyScore: number;
}

export function scoreDocumentQaAnswerText(
  text: string,
  acceptedAnswers: readonly string[],
  thresholds: Required<DocumentQaBenchmarkThresholds> | DocumentQaBenchmarkThresholds = {}
): DocumentQaAnswerTextScore {
  const normalizedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const body = normalizeAnswerText(text);
  const answerScores = acceptedAnswers.map((answer) => ({
    answer,
    normalizedAnswer: normalizeAnswerText(answer),
    similarity: normalizedAnswerSimilarity(answer, text),
    relaxedAccuracyScore: relaxedAccuracyScore(
      answer,
      text,
      normalizedThresholds.numericRelativeTolerance
    )
  }));
  const exactMatch = answerScores.find(
    (score) => score.normalizedAnswer.length > 0 && body.includes(score.normalizedAnswer)
  );
  const best = [...answerScores].sort((first, second) => second.similarity - first.similarity)[0];
  const bestSimilarity = best?.similarity ?? 0;
  const bestAnlsScore = anlsScore(bestSimilarity, normalizedThresholds.anlsSimilarityThreshold);
  const relaxedMatch = answerScores.find((score) => score.relaxedAccuracyScore === 1);

  return {
    answerFound: exactMatch !== undefined,
    ...(exactMatch === undefined ? {} : { matchedAnswer: exactMatch.answer }),
    bestSimilarity,
    bestAnlsScore,
    relaxedAccuracyScore: relaxedMatch === undefined ? 0 : 1
  };
}

function anlsScore(similarity: number, threshold: number): number {
  return similarity >= threshold ? similarity : 0;
}

function relaxedAccuracyScore(answer: string, parsedText: string, tolerance: number): number {
  const expected = numericAnswerValue(answer);
  if (expected === undefined) {
    return normalizeAnswerText(parsedText).includes(normalizeAnswerText(answer)) ? 1 : 0;
  }
  const actualValues = numericValuesFromText(parsedText);
  return actualValues.some((actual) => withinRelativeTolerance(expected, actual, tolerance))
    ? 1
    : 0;
}

function numericAnswerValue(value: string): number | undefined {
  const cleaned = value.trim().replace(/,/gu, "");
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)%?$/u.test(cleaned)) {
    return undefined;
  }
  const parsed = Number(cleaned.replace(/%$/u, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numericValuesFromText(value: string): readonly number[] {
  const matches = value.matchAll(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/gu);
  return [...matches].flatMap((match) => {
    const parsed = Number(match[0].replace(/,/gu, "").replace(/%$/u, ""));
    return Number.isFinite(parsed) ? [parsed] : [];
  });
}

function withinRelativeTolerance(expected: number, actual: number, tolerance: number): boolean {
  if (expected === 0) {
    return Math.abs(actual) <= tolerance;
  }
  return Math.abs(actual - expected) / Math.abs(expected) <= tolerance;
}

function normalizedAnswerSimilarity(answer: string, parsedText: string): number {
  const normalizedAnswer = normalizeAnswerText(answer);
  const normalizedParsedText = normalizeAnswerText(parsedText);
  if (!normalizedAnswer || !normalizedParsedText) {
    return 0;
  }
  if (normalizedParsedText.includes(normalizedAnswer)) {
    return 1;
  }
  const windowLength = normalizedAnswer.length;
  const candidates = textWindows(normalizedParsedText, windowLength);
  return Math.max(
    0,
    ...candidates.map((candidate) => normalizedEditSimilarity(normalizedAnswer, candidate))
  );
}

function textWindows(value: string, targetLength: number): readonly string[] {
  if (value.length <= targetLength) {
    return [value];
  }
  const windows: string[] = [];
  for (let index = 0; index <= value.length - targetLength; index += 1) {
    windows.push(value.slice(index, index + targetLength));
  }
  return windows;
}

function normalizedEditSimilarity(expected: string, actual: string): number {
  if (!expected && !actual) {
    return 1;
  }
  if (!expected || !actual) {
    return 0;
  }
  const distance = levenshteinDistance(expected, actual);
  return roundScore(1 - distance / Math.max(expected.length, actual.length));
}

function levenshteinDistance(first: string, second: string): number {
  const previous = Array.from({ length: second.length + 1 }, (_unused, index) => index);
  const current = Array.from({ length: second.length + 1 }, () => 0);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    current[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const substitutionCost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
      current[secondIndex] = Math.min(
        previous[secondIndex]! + 1,
        current[secondIndex - 1]! + 1,
        previous[secondIndex - 1]! + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[second.length]!;
}

function normalizeAnswerText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : roundScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
