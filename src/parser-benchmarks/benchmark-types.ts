import type { DocumentParseRequest, DocumentParseResult } from "../parsing/parser.js";

export type ParserBenchmarkDataset = "omnidocbench" | "tablebank";

export interface ParserBenchmarkEvaluationScope {
  readonly text: boolean;
  readonly layout: boolean;
  readonly tables: boolean;
  readonly formulas: boolean;
  readonly readingOrder: boolean;
}

export interface ParserBenchmarkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ParserBenchmarkPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly imagePath?: string;
  readonly pdfPath?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ParserBenchmarkAnnotation {
  readonly id: string;
  readonly category: string;
  readonly ignored: boolean;
  readonly order?: number;
  readonly box?: ParserBenchmarkBox;
  readonly text?: string;
  readonly latex?: string;
  readonly html?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface ParserBenchmarkCase {
  readonly dataset: ParserBenchmarkDataset;
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly contentType: string;
  readonly page: ParserBenchmarkPage;
  readonly annotations: readonly ParserBenchmarkAnnotation[];
  readonly expectedText: string;
  readonly expectedReadingOrder: readonly string[];
  readonly expectedTableHtml: readonly string[];
  readonly expectedFormulaLatex: readonly string[];
  readonly tags: readonly string[];
  readonly evaluationScope: ParserBenchmarkEvaluationScope;
}

export interface ParserBenchmarkCaseRequest {
  readonly testCase: ParserBenchmarkCase;
  readonly request: DocumentParseRequest;
}

export interface ParserBenchmarkCaseEvaluation {
  readonly caseId: string;
  readonly sourceId: string;
  readonly status: "passed" | "failed";
  readonly textSimilarity: number;
  readonly layoutRecall: number;
  readonly tableRecall: number;
  readonly formulaRecall: number;
  readonly readingOrderScore: number;
  readonly expectedAnnotationCount: number;
  readonly matchedAnnotationCount: number;
  readonly expectedTableCount: number;
  readonly matchedTableCount: number;
  readonly expectedFormulaCount: number;
  readonly matchedFormulaCount: number;
  readonly warnings: readonly string[];
}

export interface ParserBenchmarkThresholds {
  readonly minimumTextSimilarity?: number;
  readonly minimumLayoutRecall?: number;
  readonly minimumTableRecall?: number;
  readonly minimumFormulaRecall?: number;
  readonly minimumReadingOrderScore?: number;
}

export interface ParserBenchmarkReport {
  readonly dataset: ParserBenchmarkDataset;
  readonly status: "passed" | "failed";
  readonly caseCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly averageTextSimilarity: number;
  readonly averageLayoutRecall: number;
  readonly averageTableRecall: number;
  readonly averageFormulaRecall: number;
  readonly averageReadingOrderScore: number;
  readonly cases: readonly ParserBenchmarkCaseEvaluation[];
}

export interface ParserBenchmarkRunResult {
  readonly testCase: ParserBenchmarkCase;
  readonly parseResult?: DocumentParseResult;
  readonly errorMessage?: string;
}

export type DocumentQaBenchmarkDataset = "docvqa" | "chartqa";

export interface DocumentQaBenchmarkCase {
  readonly dataset: DocumentQaBenchmarkDataset;
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly imagePath: string;
  readonly textPath?: string;
  readonly inlineText?: string;
  readonly question: string;
  readonly acceptedAnswers: readonly string[];
  readonly documentId?: string;
  readonly pageNumber?: string;
  readonly expectedCitationPageNumber?: number;
  readonly split?: string;
  readonly tags: readonly string[];
}

export type DocumentQaRagBenchmarkFailureStage =
  | "parser"
  | "ingestion"
  | "retrieval"
  | "citation"
  | "answer_generation";

export interface DocumentQaBenchmarkCaseEvaluation {
  readonly caseId: string;
  readonly sourceId: string;
  readonly status: "passed" | "failed";
  readonly failureStage?: DocumentQaRagBenchmarkFailureStage;
  readonly question: string;
  readonly generatedAnswer?: string;
  readonly matchedAnswer?: string;
  readonly answerFoundInParsedText: boolean;
  readonly answerMatch: boolean;
  readonly citationCorrect: boolean;
  readonly expectedCitationPageNumber?: number;
  readonly citedPageNumbers: readonly number[];
  readonly retrievedChunkCount: number;
  readonly retrievedAnswerChunkCount: number;
  readonly finalCitationChunkIds: readonly string[];
  readonly bestAnswerSimilarity: number;
  readonly bestAnlsScore: number;
  readonly relaxedAccuracyScore: number;
  readonly answerSimilarity: number;
  readonly answerAnlsScore: number;
  readonly answerRelaxedAccuracyScore: number;
  readonly acceptedAnswers: readonly string[];
  readonly warnings: readonly string[];
}

export interface DocumentQaBenchmarkThresholds {
  readonly minimumAnswerSimilarity?: number;
  readonly anlsSimilarityThreshold?: number;
  readonly numericRelativeTolerance?: number;
}

export interface DocumentQaBenchmarkReport {
  readonly dataset: DocumentQaBenchmarkDataset;
  readonly status: "passed" | "failed";
  readonly caseCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly answerFoundCount: number;
  readonly averageBestAnswerSimilarity: number;
  readonly averageBestAnlsScore: number;
  readonly relaxedAccuracy: number;
  readonly ragMetrics?: DocumentQaRagBenchmarkMetrics;
  readonly cases: readonly DocumentQaBenchmarkCaseEvaluation[];
}

export interface DocumentQaBenchmarkRunResult {
  readonly testCase: DocumentQaBenchmarkCase;
  readonly parseResult?: DocumentParseResult;
  readonly errorMessage?: string;
}

export interface DocumentQaRagBenchmarkMetrics {
  readonly parserFailureCount: number;
  readonly ingestionFailureCount: number;
  readonly retrievalFailureCount: number;
  readonly citationFailureCount: number;
  readonly answerGenerationFailureCount: number;
  readonly answerMatchCount: number;
  readonly citationCorrectCount: number;
  readonly averageRetrievedChunkCount: number;
}
