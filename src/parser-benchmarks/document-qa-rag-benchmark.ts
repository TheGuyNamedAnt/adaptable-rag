import { ContextBuilder } from "../context/context-builder.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import type { RagChunk } from "../documents/chunk.js";
import type { CitationPointer } from "../documents/provenance.js";
import { InMemoryRagIndex } from "../indexing/in-memory-index.js";
import type { IndexFilter } from "../indexing/index-types.js";
import { IngestPipeline } from "../ingestion/ingest-pipeline.js";
import type {
  ModelAdapter,
  ModelGenerateRequest,
  ModelGenerateResult
} from "../model/model-types.js";
import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import type { RagProfile } from "../profiles/profile.js";
import { assertValidProfile, type ValidatedRagProfile } from "../profiles/profile-validation.js";
import { KeywordRetriever } from "../retrieval/keyword-retriever.js";
import { RagAnswerRuntime } from "../runtime/rag-answer-runtime.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser
} from "../parsing/parser.js";
import type {
  DocumentQaBenchmarkCase,
  DocumentQaBenchmarkCaseEvaluation,
  DocumentQaBenchmarkReport,
  DocumentQaBenchmarkThresholds,
  DocumentQaRagBenchmarkFailureStage,
  DocumentQaRagBenchmarkMetrics
} from "./benchmark-types.js";
import { scoreDocumentQaAnswerText } from "./document-qa-evaluators.js";

const BENCHMARK_NOW = "2026-06-24T00:00:00.000Z";
const BENCHMARK_NAMESPACE = "document-qa-benchmark";
const BENCHMARK_TENANT = "tenant_document_qa";
const BENCHMARK_ADAPTER_ID = "document-qa-benchmark-adapter";

export interface DocumentQaRagBenchmarkCaseRequest {
  readonly testCase: DocumentQaBenchmarkCase;
  readonly parseRequest: DocumentParseRequest;
}

export interface RunDocumentQaRagBenchmarkRequest {
  readonly dataset: DocumentQaBenchmarkCase["dataset"];
  readonly cases: readonly DocumentQaRagBenchmarkCaseRequest[];
  readonly parser: DocumentParser;
  readonly thresholds?: DocumentQaBenchmarkThresholds;
  readonly topK?: number;
  readonly now?: () => string;
}

export async function runDocumentQaRagBenchmark(
  request: RunDocumentQaRagBenchmarkRequest
): Promise<DocumentQaBenchmarkReport> {
  const now = request.now ?? (() => BENCHMARK_NOW);
  const cases: DocumentQaBenchmarkCaseEvaluation[] = [];

  for (const testCase of request.cases) {
    cases.push(
      await runDocumentQaRagBenchmarkCase({
        testCase: testCase.testCase,
        parseRequest: testCase.parseRequest,
        parser: request.parser,
        thresholds: request.thresholds ?? {},
        ...(request.topK === undefined ? {} : { topK: request.topK }),
        now
      })
    );
  }

  const passedCount = cases.filter((testCase) => testCase.status === "passed").length;
  return {
    dataset: request.dataset,
    status: cases.length > 0 && passedCount === cases.length ? "passed" : "failed",
    caseCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    answerFoundCount: cases.filter((testCase) => testCase.answerFoundInParsedText).length,
    averageBestAnswerSimilarity: average(cases.map((testCase) => testCase.bestAnswerSimilarity)),
    averageBestAnlsScore: average(cases.map((testCase) => testCase.bestAnlsScore)),
    relaxedAccuracy: average(cases.map((testCase) => testCase.relaxedAccuracyScore)),
    ragMetrics: ragMetrics(cases),
    cases
  };
}

async function runDocumentQaRagBenchmarkCase(input: {
  readonly testCase: DocumentQaBenchmarkCase;
  readonly parseRequest: DocumentParseRequest;
  readonly parser: DocumentParser;
  readonly thresholds: DocumentQaBenchmarkThresholds;
  readonly topK?: number;
  readonly now: () => string;
}): Promise<DocumentQaBenchmarkCaseEvaluation> {
  let parseResult: DocumentParseResult;
  try {
    parseResult = await input.parser.parse(input.parseRequest);
  } catch (error) {
    return failedCase(input.testCase, "parser", [
      `Parser failed: ${error instanceof Error ? error.message : String(error)}`
    ]);
  }

  const parsedScore = scoreDocumentQaAnswerText(
    parseResult.document.body,
    input.testCase.acceptedAnswers,
    input.thresholds
  );
  if (
    !parsedScore.answerFound &&
    parsedScore.bestSimilarity < minimumAnswerSimilarity(input.thresholds)
  ) {
    return failedCase(
      input.testCase,
      "parser",
      [
        `Parsed text did not contain an accepted answer; best similarity ${parsedScore.bestSimilarity}.`
      ],
      {
        parseResult,
        parsedScore
      }
    );
  }

  const profile = benchmarkProfile(input.testCase.sourceId);
  const principal = benchmarkPrincipal(profile.namespaceId);
  const index = new InMemoryRagIndex({ now: input.now });
  const pipeline = new IngestPipeline({
    adapterRegistry: new CorpusAdapterRegistry([
      new ParsedDocumentBenchmarkAdapter(input.testCase, parseResult, input.parseRequest)
    ]),
    documentStore: index,
    chunkStore: index,
    now: input.now
  });
  const ingest = await pipeline.ingest({
    profile,
    requestedBy: principal,
    runId: `document_qa_ingest_${safeId(input.testCase.id)}`,
    requestedAt: input.now(),
    overwriteMode: "replace"
  });

  const ingestionErrors = [
    ...ingest.rejectedRecords.map((record) => `${record.recordId}: ${record.reason}`),
    ...ingest.normalizationIssues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.recordId}:${issue.code}`)
  ];
  if (ingestionErrors.length > 0 || ingest.chunks.length === 0) {
    return failedCase(
      input.testCase,
      "ingestion",
      [
        ...ingestionErrors,
        ...(ingest.chunks.length === 0 ? ["Ingestion produced no chunks."] : [])
      ],
      {
        parseResult,
        parsedScore
      }
    );
  }

  const filter = benchmarkFilter(profile.namespaceId);
  const runtime = new RagAnswerRuntime({
    retriever: new KeywordRetriever({ chunkStore: index, now: input.now }),
    contextBuilder: new ContextBuilder({ now: input.now }),
    now: input.now
  });
  const answer = await runtime.answer({
    profile,
    question: input.testCase.question,
    filter,
    model: new ExtractiveDocumentQaModelAdapter({
      acceptedAnswers: input.testCase.acceptedAnswers,
      thresholds: input.thresholds,
      now: input.now
    }),
    topK: input.topK ?? profile.retrieval.maxChunks,
    includeRejected: true,
    runId: `document_qa_run_${safeId(input.testCase.id)}`,
    traceId: `document_qa_trace_${safeId(input.testCase.id)}`,
    retrievalId: `document_qa_retrieval_${safeId(input.testCase.id)}`,
    contextId: `document_qa_context_${safeId(input.testCase.id)}`,
    generationId: `document_qa_generation_${safeId(input.testCase.id)}`,
    answerId: `document_qa_answer_${safeId(input.testCase.id)}`,
    requestedAt: input.now()
  });

  if (answer.status === "retrieval_failed") {
    return failedCase(input.testCase, "retrieval", [answer.failure.message], {
      parseResult,
      parsedScore
    });
  }
  if (answer.status === "context_failed") {
    return failedCase(input.testCase, "retrieval", [answer.failure.message], {
      parseResult,
      parsedScore,
      retrievedChunks: answer.retrieval.candidates.map((candidate) => candidate.chunk)
    });
  }
  if (answer.status === "generation_failed") {
    return failedCase(input.testCase, "answer_generation", [answer.failure.message], {
      parseResult,
      parsedScore,
      retrievedChunks: answer.retrieval.candidates.map((candidate) => candidate.chunk),
      finalCitations: []
    });
  }

  const retrievedChunks = answer.retrieval.candidates.map((candidate) => candidate.chunk);
  const retrievedAnswerChunks = retrievedChunks.filter((chunk) =>
    answerTextMatches(chunk.text, input.testCase.acceptedAnswers, input.thresholds)
  );
  if (retrievedAnswerChunks.length === 0) {
    return failedCase(
      input.testCase,
      "retrieval",
      ["Retrieval did not return a chunk containing an accepted answer."],
      {
        parseResult,
        parsedScore,
        retrievedChunks,
        finalCitations: answer.answerCitations
      }
    );
  }

  const generatedAnswer = answer.generation.draft?.answer ?? "";
  const answerScore = scoreDocumentQaAnswerText(
    generatedAnswer,
    input.testCase.acceptedAnswers,
    input.thresholds
  );
  const answerMatch =
    answerScore.answerFound ||
    answerScore.bestSimilarity >= minimumAnswerSimilarity(input.thresholds) ||
    answerScore.relaxedAccuracyScore === 1;
  const citationCorrect = citationMatchesExpectation(
    input.testCase,
    answer.answerCitations,
    retrievedChunks
  );
  const failureStage: DocumentQaRagBenchmarkFailureStage | undefined = !citationCorrect
    ? "citation"
    : !answerMatch
      ? "answer_generation"
      : undefined;

  return {
    caseId: input.testCase.id,
    sourceId: input.testCase.sourceId,
    status: failureStage === undefined ? "passed" : "failed",
    ...(failureStage === undefined ? {} : { failureStage }),
    question: input.testCase.question,
    generatedAnswer,
    ...(parsedScore.matchedAnswer === undefined
      ? {}
      : { matchedAnswer: parsedScore.matchedAnswer }),
    answerFoundInParsedText: parsedScore.answerFound,
    answerMatch,
    citationCorrect,
    ...(input.testCase.expectedCitationPageNumber === undefined
      ? {}
      : { expectedCitationPageNumber: input.testCase.expectedCitationPageNumber }),
    citedPageNumbers: citedPageNumbers(answer.answerCitations),
    retrievedChunkCount: retrievedChunks.length,
    retrievedAnswerChunkCount: retrievedAnswerChunks.length,
    finalCitationChunkIds: answer.answerCitations.map((citation) => citation.chunkId),
    bestAnswerSimilarity: parsedScore.bestSimilarity,
    bestAnlsScore: parsedScore.bestAnlsScore,
    relaxedAccuracyScore: parsedScore.relaxedAccuracyScore,
    answerSimilarity: answerScore.bestSimilarity,
    answerAnlsScore: answerScore.bestAnlsScore,
    answerRelaxedAccuracyScore: answerScore.relaxedAccuracyScore,
    acceptedAnswers: input.testCase.acceptedAnswers,
    warnings:
      failureStage === undefined
        ? []
        : [
            failureStage === "citation"
              ? "Generated answer matched, but final citation did not match the expected source/page."
              : "Retrieved evidence was available, but generated answer did not match accepted answers."
          ]
  };
}

function failedCase(
  testCase: DocumentQaBenchmarkCase,
  failureStage: DocumentQaRagBenchmarkFailureStage,
  warnings: readonly string[],
  partial: {
    readonly parseResult?: DocumentParseResult;
    readonly parsedScore?: ReturnType<typeof scoreDocumentQaAnswerText>;
    readonly retrievedChunks?: readonly RagChunk[];
    readonly finalCitations?: readonly CitationPointer[];
  } = {}
): DocumentQaBenchmarkCaseEvaluation {
  const parsedScore =
    partial.parsedScore ??
    scoreDocumentQaAnswerText(partial.parseResult?.document.body ?? "", testCase.acceptedAnswers);
  const finalCitations = partial.finalCitations ?? [];
  const retrievedChunks = partial.retrievedChunks ?? [];
  return {
    caseId: testCase.id,
    sourceId: testCase.sourceId,
    status: "failed",
    failureStage,
    question: testCase.question,
    ...(parsedScore.matchedAnswer === undefined
      ? {}
      : { matchedAnswer: parsedScore.matchedAnswer }),
    answerFoundInParsedText: parsedScore.answerFound,
    answerMatch: false,
    citationCorrect: false,
    ...(testCase.expectedCitationPageNumber === undefined
      ? {}
      : { expectedCitationPageNumber: testCase.expectedCitationPageNumber }),
    citedPageNumbers: citedPageNumbers(finalCitations),
    retrievedChunkCount: retrievedChunks.length,
    retrievedAnswerChunkCount: retrievedChunks.filter((chunk) =>
      answerTextMatches(chunk.text, testCase.acceptedAnswers)
    ).length,
    finalCitationChunkIds: finalCitations.map((citation) => citation.chunkId),
    bestAnswerSimilarity: parsedScore.bestSimilarity,
    bestAnlsScore: parsedScore.bestAnlsScore,
    relaxedAccuracyScore: parsedScore.relaxedAccuracyScore,
    answerSimilarity: 0,
    answerAnlsScore: 0,
    answerRelaxedAccuracyScore: 0,
    acceptedAnswers: testCase.acceptedAnswers,
    warnings
  };
}

class ParsedDocumentBenchmarkAdapter implements CorpusAdapter {
  readonly id = BENCHMARK_ADAPTER_ID;
  readonly description = "In-memory adapter for parsed document QA benchmark cases.";

  constructor(
    private readonly testCase: DocumentQaBenchmarkCase,
    private readonly parseResult: DocumentParseResult,
    private readonly parseRequest: DocumentParseRequest
  ) {}

  async load(request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    const record: CorpusRecord = {
      id: this.testCase.documentId ?? `document_qa_${safeId(this.testCase.id)}`,
      sourceId: request.source.id,
      sourceKind: this.parseRequest.sourceKind,
      title: this.testCase.title,
      body: this.parseResult.document.body,
      trustTier: "trusted_internal",
      sensitivity: "internal",
      accessScope: {
        tenantId: BENCHMARK_TENANT,
        namespaceId: request.profile.namespaceId,
        roles: ["reader"],
        tags: ["document-qa-benchmark"]
      },
      ...(this.parseRequest.path === undefined ? {} : { path: this.parseRequest.path }),
      capturedAt: request.requestedAt,
      ...(this.parseResult.document.layout === undefined
        ? {}
        : { layout: this.parseResult.document.layout }),
      metadata: {
        benchmarkDataset: this.testCase.dataset,
        benchmarkCaseId: this.testCase.id
      }
    };
    return {
      sourceId: request.source.id,
      records: [record],
      warnings: []
    };
  }
}

class ExtractiveDocumentQaModelAdapter implements ModelAdapter {
  readonly id = "document-qa-extractive-oracle";
  readonly provider = "local";
  readonly modelName = "document-qa-extractive-oracle";

  constructor(
    private readonly options: {
      readonly acceptedAnswers: readonly string[];
      readonly thresholds: DocumentQaBenchmarkThresholds;
      readonly now: () => string;
    }
  ) {}

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    const answer = extractAnswerFromContext(
      request.input.contextText,
      this.options.acceptedAnswers,
      this.options.thresholds
    );
    const citationChunkIds = request.input.contract.allowedCitationChunkIds.slice(
      0,
      Math.max(1, request.input.contract.minimumCitations)
    );
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      completedAt: this.options.now(),
      latencyMs: 0,
      usage: {
        promptTokens: Math.max(1, Math.ceil(request.input.contextText.length / 4)),
        completionTokens: Math.max(1, Math.ceil(answer.length / 4)),
        totalTokens:
          Math.max(1, Math.ceil(request.input.contextText.length / 4)) +
          Math.max(1, Math.ceil(answer.length / 4))
      },
      cost: {
        amountUsd: 0,
        currency: "USD"
      },
      warnings: [],
      draft: {
        answer,
        citationChunkIds,
        ...(request.input.contract.requireEvidenceSummary
          ? { evidenceSummary: "The answer was extracted from the retrieved benchmark context." }
          : {}),
        confidence: "high"
      }
    };
  }
}

function benchmarkProfile(sourceId: string): ValidatedRagProfile {
  const profile: RagProfile = {
    ...genericDocsProfile,
    id: "document-qa-benchmark",
    namespaceId: BENCHMARK_NAMESPACE,
    name: "Document QA Benchmark",
    purpose: "Answer benchmark questions from parsed documents.",
    corpusSources: [
      {
        id: sourceId,
        adapter: BENCHMARK_ADAPTER_ID,
        description: "Parsed benchmark document.",
        enabled: true,
        trustTierFloor: "trusted_internal",
        tags: ["document-qa-benchmark"]
      }
    ],
    retrieval: {
      ...genericDocsProfile.retrieval,
      mode: "keyword",
      rerankMode: "none",
      maxChunks: 4,
      preferSourceTags: ["document-qa-benchmark"]
    },
    contextBudget: {
      ...genericDocsProfile.contextBudget,
      maxContextChunks: 4
    },
    citationPolicy: {
      ...genericDocsProfile.citationPolicy,
      allowedSourceKindsForCitations: ["uploaded_file", "local_file", "repo_file", "api_response"]
    }
  };
  return assertValidProfile(profile);
}

function benchmarkPrincipal(namespaceId: string): RequestPrincipal {
  return {
    userId: "document_qa_benchmark",
    tenantId: BENCHMARK_TENANT,
    namespaceIds: [namespaceId],
    teamIds: [],
    roles: ["reader"],
    tags: ["document-qa-benchmark"]
  };
}

function benchmarkFilter(namespaceId: string): IndexFilter {
  return {
    tenantId: BENCHMARK_TENANT,
    namespaceId,
    principal: benchmarkPrincipal(namespaceId),
    limit: 10
  };
}

function citationMatchesExpectation(
  testCase: DocumentQaBenchmarkCase,
  citations: readonly CitationPointer[],
  retrievedChunks: readonly RagChunk[]
): boolean {
  const chunksById = new Map(retrievedChunks.map((chunk) => [chunk.id, chunk]));
  return citations.some((citation) => {
    if (citation.sourceId !== testCase.sourceId) {
      return false;
    }
    if (
      testCase.expectedCitationPageNumber !== undefined &&
      citation.pageNumber !== testCase.expectedCitationPageNumber
    ) {
      return false;
    }
    const chunk = chunksById.get(citation.chunkId);
    return chunk === undefined
      ? testCase.expectedCitationPageNumber !== undefined
      : answerTextMatches(chunk.text, testCase.acceptedAnswers);
  });
}

function extractAnswerFromContext(
  contextText: string,
  acceptedAnswers: readonly string[],
  thresholds: DocumentQaBenchmarkThresholds
): string {
  const exact = acceptedAnswers.find(
    (answer) => scoreDocumentQaAnswerText(contextText, [answer], thresholds).answerFound
  );
  if (exact !== undefined) {
    return exact;
  }
  const best = [...acceptedAnswers].sort(
    (first, second) =>
      scoreDocumentQaAnswerText(contextText, [second], thresholds).bestSimilarity -
      scoreDocumentQaAnswerText(contextText, [first], thresholds).bestSimilarity
  )[0];
  return best ?? "No accepted answer found in retrieved context.";
}

function answerTextMatches(
  text: string,
  acceptedAnswers: readonly string[],
  thresholds: DocumentQaBenchmarkThresholds = {}
): boolean {
  const score = scoreDocumentQaAnswerText(text, acceptedAnswers, thresholds);
  return (
    score.answerFound ||
    score.bestSimilarity >= minimumAnswerSimilarity(thresholds) ||
    score.relaxedAccuracyScore === 1
  );
}

function minimumAnswerSimilarity(thresholds: DocumentQaBenchmarkThresholds): number {
  return thresholds.minimumAnswerSimilarity ?? 0.85;
}

function citedPageNumbers(citations: readonly CitationPointer[]): readonly number[] {
  return [...new Set(citations.flatMap((citation) => citation.pageNumber ?? []))].sort(
    (first, second) => first - second
  );
}

function ragMetrics(
  cases: readonly DocumentQaBenchmarkCaseEvaluation[]
): DocumentQaRagBenchmarkMetrics {
  return {
    parserFailureCount: countStage(cases, "parser"),
    ingestionFailureCount: countStage(cases, "ingestion"),
    retrievalFailureCount: countStage(cases, "retrieval"),
    citationFailureCount: countStage(cases, "citation"),
    answerGenerationFailureCount: countStage(cases, "answer_generation"),
    answerMatchCount: cases.filter((testCase) => testCase.answerMatch).length,
    citationCorrectCount: cases.filter((testCase) => testCase.citationCorrect).length,
    averageRetrievedChunkCount: average(cases.map((testCase) => testCase.retrievedChunkCount))
  };
}

function countStage(
  cases: readonly DocumentQaBenchmarkCaseEvaluation[],
  stage: DocumentQaRagBenchmarkFailureStage
): number {
  return cases.filter((testCase) => testCase.failureStage === stage).length;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function safeId(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "") || "case";
}
