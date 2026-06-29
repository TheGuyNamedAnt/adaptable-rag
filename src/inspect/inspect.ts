import type {
  ContextBlock,
  ContextBuildResult,
  ContextRejection
} from "../context/context-types.js";
import type { CitationPointer } from "../documents/provenance.js";
import type { RagEvalCaseResult, RagEvalRunSummary } from "../evals/eval-types.js";
import type { RagRunTrace, TraceEvent } from "../observability/trace.js";
import type {
  IngestionCheckpointRecord,
  IngestionCheckpointStore,
  IngestionDocumentStatus,
  IngestionDocumentProgressRecord,
  IngestionJobRecord,
  IngestionJobStore,
  IngestionProgressStore,
  IngestionSourceProgressRecord
} from "../runtime/ingestion-job.js";
import type {
  RetrievalCandidate,
  RetrievalRejection,
  RetrievalResult
} from "../retrieval/retrieval-types.js";

export type InspectSourceHealthStatus = "healthy" | "warning" | "failed" | "unknown";

export interface InspectIngestionRunRequest {
  readonly jobId: string;
  readonly jobStore: IngestionJobStore;
  readonly checkpointStore?: IngestionCheckpointStore;
  readonly progressStore?: IngestionProgressStore;
  readonly sourceId?: string;
  readonly documentStatuses?: readonly IngestionDocumentStatus[];
  readonly checkpointLimit?: number;
  readonly checkpointOffset?: number;
  readonly documentLimit?: number;
  readonly documentOffset?: number;
}

export interface InspectIngestionRunResult {
  readonly job: IngestionJobRecord;
  readonly summary: InspectIngestionRunSummary;
  readonly checkpoints: readonly IngestionCheckpointRecord[];
  readonly latestCheckpoint?: IngestionCheckpointRecord;
  readonly sources: readonly IngestionSourceProgressRecord[];
  readonly documents: readonly IngestionDocumentProgressRecord[];
  readonly failedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly skippedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly acceptedDocuments: readonly IngestionDocumentProgressRecord[];
  readonly counts: InspectIngestionCounts;
  readonly page: InspectIngestionPage;
}

export interface InspectIngestionRunSummary {
  readonly jobId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly sourceIds: readonly string[];
  readonly status: IngestionJobRecord["status"];
  readonly stage: IngestionJobRecord["stage"];
  readonly attempt: number;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly updatedAt: string;
  readonly currentCheckpointPhase?: string;
  readonly failed: boolean;
  readonly counts?: IngestionJobRecord["counts"];
  readonly errorName?: string;
  readonly errorMessage?: string;
}

export interface InspectIngestionCounts {
  readonly checkpointCount: number;
  readonly sourceCount: number;
  readonly documentCount: number;
  readonly failedDocumentCount: number;
  readonly skippedDocumentCount: number;
  readonly acceptedDocumentCount: number;
  readonly retryableFailureCount: number;
}

export interface InspectIngestionPage {
  readonly checkpointLimit: number;
  readonly checkpointOffset: number;
  readonly checkpointHasMore: boolean;
  readonly documentLimit: number;
  readonly documentOffset: number;
  readonly documentHasMore: boolean;
  readonly sourceId?: string;
  readonly documentStatuses?: readonly IngestionDocumentStatus[];
}

export interface InspectSourceHealthRequest {
  readonly progressStore: IngestionProgressStore;
  readonly jobId: string;
  readonly sourceId?: string;
}

export interface InspectSourceHealthResult {
  readonly jobId: string;
  readonly sources: readonly InspectSourceHealth[];
}

export interface InspectSourceHealth {
  readonly jobId: string;
  readonly sourceId: string;
  readonly status: IngestionSourceProgressRecord["status"];
  readonly health: InspectSourceHealthStatus;
  readonly loadedDocumentCount: number;
  readonly acceptedDocumentCount: number;
  readonly failedDocumentCount: number;
  readonly skippedDocumentCount: number;
  readonly updatedAt: string;
  readonly errorMessage?: string;
}

export interface InspectTraceResult {
  readonly runId: string;
  readonly traceId: string;
  readonly status: RagRunTrace["status"];
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly queryPlanId?: string;
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly generationId?: string;
  readonly answerId?: string;
  readonly modelRequestId?: string;
  readonly plannedQueryHashCount: number;
  readonly retrievedChunkIds: readonly string[];
  readonly rejectedChunkIds: readonly string[];
  readonly finalCitationChunkIds: readonly string[];
  readonly safetyFlags: readonly string[];
  readonly eventCount: number;
  readonly eventKinds: readonly TraceEvent["kind"][];
  readonly events: readonly InspectTraceEvent[];
}

export interface InspectTraceEvent {
  readonly kind: TraceEvent["kind"];
  readonly at: string;
  readonly message: string;
  readonly dataKeys: readonly string[];
}

export interface InspectRetrievalResult {
  readonly queryHash: string;
  readonly retrievalId: string;
  readonly mode: RetrievalResult["trace"]["mode"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidatePoolSize: number;
  readonly returnedCount: number;
  readonly rejectedCount: number;
  readonly candidates: readonly InspectRetrievalCandidate[];
  readonly rejected: readonly InspectRetrievalRejection[];
  readonly adaptiveStrategy?: RetrievalResult["trace"]["adaptiveStrategy"];
}

export interface InspectRetrievalCandidate {
  readonly rank: number;
  readonly score: number;
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly trustTier: string;
  readonly textHash: string;
  readonly citation: CitationPointer;
  readonly matchedTermCount: number;
  readonly reasons: readonly string[];
  readonly graphEvidenceDepth?: number;
}

export interface InspectRetrievalRejection {
  readonly chunkId?: string;
  readonly code: RetrievalRejection["code"];
  readonly reason: string;
}

export interface InspectCitationRequest {
  readonly trace?: RagRunTrace;
  readonly retrieval?: RetrievalResult;
  readonly context?: ContextBuildResult;
  readonly chunkId?: string;
}

export interface InspectCitationResult {
  readonly citations: readonly InspectCitationChain[];
  readonly rejected: readonly InspectContextRejection[];
}

export interface InspectCitationChain {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly documentId?: string;
  readonly title: string;
  readonly locator?: string;
  readonly finalCitation: boolean;
  readonly contextBlockIndex?: number;
  readonly retrievalRank?: number;
  readonly retrievalScore?: number;
  readonly textHash?: string;
  readonly trustTier?: string;
  readonly sourceKind?: string;
  readonly graphEvidenceDepth?: number;
}

export interface InspectContextRejection {
  readonly chunkId?: string;
  readonly documentId?: string;
  readonly code: ContextRejection["code"];
  readonly reason: string;
}

export interface InspectEvalFailureRequest {
  readonly summary: RagEvalRunSummary;
  readonly caseId?: string;
}

export interface InspectEvalFailureResult {
  readonly passed: boolean;
  readonly failureCount: number;
  readonly failures: readonly string[];
  readonly cases: readonly InspectEvalFailureCase[];
}

export interface InspectEvalFailureCase {
  readonly suiteProfileId: string;
  readonly namespaceId: string;
  readonly caseId: string;
  readonly setKind: RagEvalCaseResult["setKind"];
  readonly checks: readonly string[];
  readonly failures: readonly string[];
  readonly status?: RagEvalCaseResult["status"];
  readonly contextStatus?: RagEvalCaseResult["contextStatus"];
  readonly retrievalMode?: RagEvalCaseResult["retrievalMode"];
  readonly retrievedDocumentIds: readonly string[];
  readonly finalCitationCount: number;
  readonly traceId?: string;
  readonly metrics?: RagEvalCaseResult["metrics"];
}

export const inspect = {
  ingestionRun: inspectIngestionRun,
  sourceHealth: inspectSourceHealth,
  trace: inspectTrace,
  retrieval: inspectRetrieval,
  citation: inspectCitation,
  evalFailure: inspectEvalFailure
} as const;

export async function inspectIngestionRun(
  request: InspectIngestionRunRequest
): Promise<InspectIngestionRunResult> {
  const job = await request.jobStore.get(request.jobId);
  if (!job) {
    throw new Error(`Ingestion job "${request.jobId}" was not found.`);
  }

  const checkpointLimit = inspectLimit(request.checkpointLimit);
  const checkpointOffset = inspectOffset(request.checkpointOffset);
  const documentLimit = inspectLimit(request.documentLimit);
  const documentOffset = inspectOffset(request.documentOffset);
  const checkpointsPage = request.checkpointStore
    ? await request.checkpointStore.list(request.jobId, {
        limit: checkpointLimit + 1,
        offset: checkpointOffset
      })
    : [];
  const checkpoints = checkpointsPage.slice(0, checkpointLimit);
  const latestCheckpoint = request.checkpointStore
    ? await request.checkpointStore.latest(request.jobId)
    : undefined;
  const sources = request.progressStore
    ? await request.progressStore.listSources(request.jobId, {
        ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId })
      })
    : [];
  const documentsPage = request.progressStore
    ? await request.progressStore.listDocuments(request.jobId, {
        ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
        ...(request.documentStatuses === undefined ? {} : { statuses: request.documentStatuses }),
        limit: documentLimit + 1,
        offset: documentOffset
      })
    : [];
  const documents = documentsPage.slice(0, documentLimit);
  const failedDocuments = documents.filter((document) => document.status === "failed");
  const skippedDocuments = documents.filter((document) => document.status === "skipped");
  const acceptedDocuments = documents.filter((document) => document.status === "accepted");

  return {
    job,
    summary: inspectIngestionSummary(job, latestCheckpoint),
    checkpoints,
    ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
    sources,
    documents,
    failedDocuments,
    skippedDocuments,
    acceptedDocuments,
    counts: {
      checkpointCount: checkpoints.length,
      sourceCount: sources.length,
      documentCount: documents.length,
      failedDocumentCount: failedDocuments.length,
      skippedDocumentCount: skippedDocuments.length,
      acceptedDocumentCount: acceptedDocuments.length,
      retryableFailureCount: failedDocuments.filter((document) => document.retryable).length
    },
    page: {
      checkpointLimit,
      checkpointOffset,
      checkpointHasMore: checkpointsPage.length > checkpointLimit,
      documentLimit,
      documentOffset,
      documentHasMore: documentsPage.length > documentLimit,
      ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
      ...(request.documentStatuses === undefined
        ? {}
        : { documentStatuses: request.documentStatuses })
    }
  };
}

export async function inspectSourceHealth(
  request: InspectSourceHealthRequest
): Promise<InspectSourceHealthResult> {
  const allSources = await request.progressStore.listSources(request.jobId);
  const sources = request.sourceId
    ? allSources.filter((source) => source.sourceId === request.sourceId)
    : allSources;

  return {
    jobId: request.jobId,
    sources: sources.map((source) => ({
      jobId: source.jobId,
      sourceId: source.sourceId,
      status: source.status,
      health: sourceHealth(source),
      loadedDocumentCount: source.loadedDocumentCount,
      acceptedDocumentCount: source.acceptedDocumentCount,
      failedDocumentCount: source.failedDocumentCount,
      skippedDocumentCount: source.skippedDocumentCount,
      updatedAt: source.updatedAt,
      ...(source.errorMessage === undefined ? {} : { errorMessage: source.errorMessage })
    }))
  };
}

export function inspectTrace(trace: RagRunTrace): InspectTraceResult {
  return {
    runId: trace.runId,
    traceId: trace.traceId,
    status: trace.status,
    profileId: trace.profileId,
    namespaceId: trace.namespaceId,
    startedAt: trace.startedAt,
    ...(trace.finishedAt === undefined ? {} : { finishedAt: trace.finishedAt }),
    ...(trace.queryPlanId === undefined ? {} : { queryPlanId: trace.queryPlanId }),
    ...(trace.retrievalId === undefined ? {} : { retrievalId: trace.retrievalId }),
    ...(trace.contextId === undefined ? {} : { contextId: trace.contextId }),
    ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
    ...(trace.answerId === undefined ? {} : { answerId: trace.answerId }),
    ...(trace.modelRequestId === undefined ? {} : { modelRequestId: trace.modelRequestId }),
    plannedQueryHashCount: trace.plannedQueryHashes.length,
    retrievedChunkIds: trace.retrievedChunkIds,
    rejectedChunkIds: trace.rejectedChunkIds,
    finalCitationChunkIds: trace.finalCitations.map((citation) => citation.chunkId),
    safetyFlags: trace.safetyFlags,
    eventCount: trace.events.length,
    eventKinds: trace.events.map((event) => event.kind),
    events: trace.events.map((event) => ({
      kind: event.kind,
      at: event.at,
      message: event.message,
      dataKeys: Object.keys(event.data ?? {}).sort()
    }))
  };
}

export function inspectRetrieval(retrieval: RetrievalResult): InspectRetrievalResult {
  return {
    queryHash: retrieval.trace.queryHash,
    retrievalId: retrieval.trace.retrievalId,
    mode: retrieval.trace.mode,
    startedAt: retrieval.trace.startedAt,
    finishedAt: retrieval.trace.finishedAt,
    candidatePoolSize: retrieval.trace.candidatePoolSize,
    returnedCount: retrieval.trace.returnedCount,
    rejectedCount: retrieval.trace.rejectedCount,
    candidates: retrieval.candidates.map(inspectCandidate),
    rejected: retrieval.rejected.map((rejection) => ({
      ...(rejection.chunkId === undefined ? {} : { chunkId: rejection.chunkId }),
      code: rejection.code,
      reason: rejection.reason
    })),
    ...(retrieval.trace.adaptiveStrategy === undefined
      ? {}
      : { adaptiveStrategy: retrieval.trace.adaptiveStrategy })
  };
}

export function inspectCitation(request: InspectCitationRequest): InspectCitationResult {
  const retrievalByChunk = new Map<string, RetrievalCandidate>();
  for (const candidate of request.retrieval?.candidates ?? []) {
    retrievalByChunk.set(candidate.chunk.id, candidate);
  }

  const contextByChunk = new Map<string, ContextBlock>();
  for (const block of request.context?.blocks ?? []) {
    contextByChunk.set(block.chunkId, block);
  }

  const finalCitationIds = new Set(
    (request.trace?.finalCitations ?? []).map((citation) => citation.chunkId)
  );
  const citations = new Map<string, CitationPointer>();
  for (const citation of request.trace?.finalCitations ?? []) {
    citations.set(citation.chunkId, citation);
  }
  for (const block of request.context?.blocks ?? []) {
    citations.set(block.chunkId, block.citation);
  }
  for (const candidate of request.retrieval?.candidates ?? []) {
    citations.set(candidate.chunk.id, candidate.citation);
  }

  const chains = [...citations.values()]
    .filter((citation) => request.chunkId === undefined || citation.chunkId === request.chunkId)
    .map((citation) =>
      inspectCitationChain(
        citation,
        finalCitationIds.has(citation.chunkId),
        contextByChunk.get(citation.chunkId),
        retrievalByChunk.get(citation.chunkId)
      )
    )
    .sort((first, second) => {
      const firstRank = first.retrievalRank ?? Number.MAX_SAFE_INTEGER;
      const secondRank = second.retrievalRank ?? Number.MAX_SAFE_INTEGER;
      return firstRank === secondRank
        ? first.chunkId.localeCompare(second.chunkId)
        : firstRank - secondRank;
    });

  const rejected = (request.context?.rejected ?? [])
    .filter((rejection) => request.chunkId === undefined || rejection.chunkId === request.chunkId)
    .map((rejection) => ({
      ...(rejection.chunkId === undefined ? {} : { chunkId: rejection.chunkId }),
      ...(rejection.documentId === undefined ? {} : { documentId: rejection.documentId }),
      code: rejection.code,
      reason: rejection.reason
    }));

  return { citations: chains, rejected };
}

export function inspectEvalFailure(request: InspectEvalFailureRequest): InspectEvalFailureResult {
  const cases = request.summary.suites.flatMap((suite) =>
    suite.cases
      .filter((evalCase) => request.caseId === undefined || evalCase.id === request.caseId)
      .filter((evalCase) => !evalCase.passed || request.caseId !== undefined)
      .map((evalCase) => inspectEvalCase(suite.profileId, suite.namespaceId, evalCase))
  );

  return {
    passed: request.summary.passed,
    failureCount: cases.filter((evalCase) => evalCase.failures.length > 0).length,
    failures: request.summary.failures,
    cases
  };
}

function inspectCandidate(candidate: RetrievalCandidate): InspectRetrievalCandidate {
  return {
    rank: candidate.rank,
    score: candidate.score,
    chunkId: candidate.chunk.id,
    documentId: candidate.chunk.documentId,
    sourceId: candidate.chunk.provenance.sourceId,
    sourceKind: candidate.chunk.provenance.sourceKind,
    trustTier: candidate.chunk.provenance.trustTier,
    textHash: candidate.chunk.textHash,
    citation: candidate.citation,
    matchedTermCount: candidate.matchedTerms.length,
    reasons: candidate.reasons,
    ...(candidate.graphEvidence?.depth === undefined
      ? {}
      : { graphEvidenceDepth: candidate.graphEvidence.depth })
  };
}

function inspectCitationChain(
  citation: CitationPointer,
  finalCitation: boolean,
  contextBlock: ContextBlock | undefined,
  retrievalCandidate: RetrievalCandidate | undefined
): InspectCitationChain {
  return {
    chunkId: citation.chunkId,
    sourceId: citation.sourceId,
    ...(contextBlock?.documentId === undefined ? {} : { documentId: contextBlock.documentId }),
    title: citation.title,
    ...(citation.locator === undefined ? {} : { locator: citation.locator }),
    finalCitation,
    ...(contextBlock?.index === undefined ? {} : { contextBlockIndex: contextBlock.index }),
    ...(retrievalCandidate?.rank === undefined ? {} : { retrievalRank: retrievalCandidate.rank }),
    ...(retrievalCandidate?.score === undefined
      ? {}
      : { retrievalScore: retrievalCandidate.score }),
    ...(contextBlock?.textHash === undefined ? {} : { textHash: contextBlock.textHash }),
    ...(contextBlock?.provenance.trustTier === undefined
      ? {}
      : { trustTier: contextBlock.provenance.trustTier }),
    ...(contextBlock?.provenance.sourceKind === undefined
      ? {}
      : { sourceKind: contextBlock.provenance.sourceKind }),
    ...(retrievalCandidate?.graphEvidence?.depth === undefined
      ? {}
      : { graphEvidenceDepth: retrievalCandidate.graphEvidence.depth })
  };
}

function inspectEvalCase(
  suiteProfileId: string,
  namespaceId: string,
  evalCase: RagEvalCaseResult
): InspectEvalFailureCase {
  return {
    suiteProfileId,
    namespaceId,
    caseId: evalCase.id,
    setKind: evalCase.setKind,
    checks: evalCase.checks,
    failures: evalCase.failures,
    ...(evalCase.status === undefined ? {} : { status: evalCase.status }),
    ...(evalCase.contextStatus === undefined ? {} : { contextStatus: evalCase.contextStatus }),
    ...(evalCase.retrievalMode === undefined ? {} : { retrievalMode: evalCase.retrievalMode }),
    retrievedDocumentIds: evalCase.retrievedDocumentIds,
    finalCitationCount: evalCase.finalCitationCount,
    ...(evalCase.traceId === undefined ? {} : { traceId: evalCase.traceId }),
    ...(evalCase.metrics === undefined ? {} : { metrics: evalCase.metrics })
  };
}

function sourceHealth(source: IngestionSourceProgressRecord): InspectSourceHealthStatus {
  if (source.status === "failed" || source.failedDocumentCount > 0) {
    return "failed";
  }
  if (source.status === "completed" && source.skippedDocumentCount === 0) {
    return "healthy";
  }
  if (source.status === "queued") {
    return "unknown";
  }
  return "warning";
}

const DEFAULT_INSPECT_PAGE_SIZE = 100;
const MAX_INSPECT_PAGE_SIZE = 500;

function inspectIngestionSummary(
  job: IngestionJobRecord,
  latestCheckpoint: IngestionCheckpointRecord | undefined
): InspectIngestionRunSummary {
  const durationMs = inspectDurationMs(job.startedAt, job.finishedAt);
  const currentCheckpointPhase =
    checkpointPhase(job.checkpoint) ?? checkpointPhase(latestCheckpoint?.checkpoint);
  return {
    jobId: job.jobId,
    runId: job.runId,
    tenantId: job.tenantId,
    namespaceId: job.namespaceId,
    sourceIds: job.sourceIds,
    status: job.status,
    stage: job.stage,
    attempt: job.attempt,
    requestedAt: job.requestedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    updatedAt: job.updatedAt,
    ...(currentCheckpointPhase === undefined ? {} : { currentCheckpointPhase }),
    failed: job.status === "failed" || job.errorMessage !== undefined,
    ...(job.counts === undefined ? {} : { counts: job.counts }),
    ...(job.errorName === undefined ? {} : { errorName: job.errorName }),
    ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage })
  };
}

function inspectLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_INSPECT_PAGE_SIZE;
  }
  return Math.min(MAX_INSPECT_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}

function inspectOffset(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.trunc(value));
}

function inspectDurationMs(
  startedAt: string | undefined,
  finishedAt: string | undefined
): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }

  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return undefined;
  }

  return Math.max(0, finished - started);
}

function checkpointPhase(
  checkpoint: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  return typeof checkpoint?.["phase"] === "string" ? checkpoint["phase"] : undefined;
}
