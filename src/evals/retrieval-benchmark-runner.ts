import type { RagAnswerResult } from "../runtime/runtime-types.js";
import type { LoadedRagEvalCase, RagEvalCaseMetrics } from "./eval-types.js";

type ResultWithRetrieval = Extract<RagAnswerResult, { readonly retrieval: unknown }>;
type ResultWithContext = Extract<RagAnswerResult, { readonly context: unknown }>;
type ResultWithGeneration = Extract<RagAnswerResult, { readonly generation: unknown }>;

export class RetrievalBenchmarkRunner {
  evaluate(evalCase: LoadedRagEvalCase, answer: RagAnswerResult): RagEvalCaseMetrics {
    const expectedRetrieved = evalCase.expect.retrievedDocumentIds ?? [];
    const retrievedDocumentIds = hasRetrieval(answer)
      ? answer.retrieval.candidates.map((candidate) => candidate.chunk.documentId)
      : [];
    const finalCitationDocumentIds = answer.trace.finalCitations.map((citation) =>
      documentIdFromChunkId(citation.chunkId)
    );
    return {
      ...(expectedRetrieved.length > 0
        ? {
            recallAtK: recallAtK(expectedRetrieved, retrievedDocumentIds),
            mrr: mrr(expectedRetrieved, retrievedDocumentIds),
            citationRecall: recallAtK(expectedRetrieved, finalCitationDocumentIds)
          }
        : {}),
      citationPrecision:
        answer.trace.finalCitations.length === 0
          ? 0
          : precision(expectedRetrieved, finalCitationDocumentIds),
      refusalCorrectness: refusalCorrectness(evalCase, answer),
      accessBoundaryCorrectness: accessBoundaryCorrectness(evalCase, answer),
      ...(evalCase.expect.staleSourceRefusalExpected === undefined
        ? {}
        : { staleSourceRefusal: answer.status === "refused" }),
      ...(hasContext(answer)
        ? { parserQualityImpact: answer.context.trace.optimizer?.tableAwareCandidateCount ?? 0 }
        : {}),
      ...(hasContext(answer) ? { graphPathGrounding: graphPathGrounding(answer) } : {}),
      ...(answer.trace.finishedAt === undefined
        ? {}
        : {
            latencyMs: Math.max(
              0,
              Date.parse(answer.trace.finishedAt) - Date.parse(answer.trace.startedAt)
            )
          }),
      ...(hasGeneration(answer) && answer.generation.model
        ? { estimatedCostUsd: answer.generation.model.cost.amountUsd }
        : {})
    };
  }
}

export interface CitationQualityReport {
  readonly precision: number;
  readonly recall: number;
}

export interface AccessBoundaryEval {
  readonly correct: boolean;
}

export interface RegressionDashboardArtifact {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly citationPrecision: number;
  readonly citationRecall: number;
  readonly refusalCorrectnessRate: number;
  readonly accessBoundaryCorrectnessRate: number;
  readonly staleSourceRefusalRate: number;
  readonly parserQualityImpact: number;
  readonly graphPathGrounding: number;
  readonly latencyMsP50: number;
  readonly estimatedCostUsdTotal: number;
}

function recallAtK(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) {
    return 0;
  }
  const actualSet = new Set(actual);
  return round(expected.filter((documentId) => actualSet.has(documentId)).length / expected.length);
}

function precision(expected: readonly string[], actual: readonly string[]): number {
  if (actual.length === 0) {
    return 0;
  }
  if (expected.length === 0) {
    return 1;
  }
  const expectedSet = new Set(expected);
  return round(actual.filter((documentId) => expectedSet.has(documentId)).length / actual.length);
}

function mrr(expected: readonly string[], actual: readonly string[]): number {
  const expectedSet = new Set(expected);
  const index = actual.findIndex((documentId) => expectedSet.has(documentId));
  return index === -1 ? 0 : round(1 / (index + 1));
}

function refusalCorrectness(evalCase: LoadedRagEvalCase, answer: RagAnswerResult): boolean {
  if (evalCase.expect.status === "refused") {
    return answer.status === "refused";
  }
  if (evalCase.checks.includes("refusal_when_unsupported")) {
    return answer.status === "refused";
  }
  return answer.status !== "refused";
}

function accessBoundaryCorrectness(evalCase: LoadedRagEvalCase, answer: RagAnswerResult): boolean {
  const forbidden = evalCase.expect.notRetrievedDocumentIds ?? [];
  if (forbidden.length === 0) {
    return true;
  }
  if (!hasRetrieval(answer)) {
    return answer.status === "retrieval_failed";
  }
  const retrieved = new Set(
    answer.retrieval.candidates.map((candidate) => candidate.chunk.documentId)
  );
  return forbidden.every((documentId) => !retrieved.has(documentId));
}

function graphPathGrounding(answer: RagAnswerResult): number {
  if (!hasContext(answer)) {
    return 0;
  }
  const graphBlocks = answer.context.blocks.filter((block) => block.graphEvidence !== undefined);
  if (graphBlocks.length === 0) {
    return 0;
  }
  const cited = new Set(answer.trace.finalCitations.map((citation) => citation.chunkId));
  return round(graphBlocks.filter((block) => cited.has(block.chunkId)).length / graphBlocks.length);
}

function documentIdFromChunkId(chunkId: string): string {
  const match = /^(chunk_)?(?<documentId>.+?)(?:_chunk_\d+|#.*)?$/u.exec(chunkId);
  return match?.groups?.["documentId"] ?? chunkId;
}

function hasRetrieval(answer: RagAnswerResult): answer is ResultWithRetrieval {
  return "retrieval" in answer;
}

function hasContext(answer: RagAnswerResult): answer is ResultWithContext {
  return "context" in answer;
}

function hasGeneration(answer: RagAnswerResult): answer is ResultWithGeneration {
  return "generation" in answer;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
