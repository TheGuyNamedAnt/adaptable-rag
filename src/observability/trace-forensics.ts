import type { CitationPointer } from "../documents/provenance.js";
import type { RagRunStatus, RagRunTrace, TraceEventKind } from "./trace.js";

export const TRACE_FORENSICS_SCHEMA_VERSION = 1;

export type TraceReplayStatus = "matched" | "mismatched" | "not_comparable";
export type TraceForensicsSeverity = "info" | "warning" | "high" | "critical";

export interface TraceSummary {
  readonly runId: string;
  readonly traceId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly status: RagRunStatus;
  readonly questionHash: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly queryPlanId?: string;
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly generationId?: string;
  readonly answerId?: string;
  readonly modelRequestId?: string;
  readonly retrievedChunkCount: number;
  readonly rejectedChunkCount: number;
  readonly finalCitationCount: number;
  readonly safetyFlagCount: number;
  readonly eventCount: number;
  readonly eventKinds: readonly TraceEventKind[];
  readonly finalCitationKeys: readonly string[];
  readonly linked: boolean;
}

export interface TraceComparisonDelta {
  readonly field: string;
  readonly baseline: number | string | readonly string[];
  readonly current: number | string | readonly string[];
}

export interface TraceReplayComparison {
  readonly status: TraceReplayStatus;
  readonly severity: TraceForensicsSeverity;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly deltas: readonly TraceComparisonDelta[];
  readonly baseline?: TraceSummary;
  readonly current?: TraceSummary;
}

export interface TraceReplayOptions {
  readonly allowRunIdChange?: boolean;
  readonly allowTraceIdChange?: boolean;
  readonly allowRetrievedChunkDrift?: boolean;
  readonly allowRejectedChunkDrift?: boolean;
  readonly allowCitationDrift?: boolean;
  readonly allowEventSequenceDrift?: boolean;
}

export function summarizeRunTrace(trace: RagRunTrace): TraceSummary {
  return {
    runId: trace.runId,
    traceId: trace.traceId,
    profileId: trace.profileId,
    namespaceId: trace.namespaceId,
    status: trace.status,
    questionHash: trace.questionHash,
    startedAt: trace.startedAt,
    ...(trace.finishedAt === undefined ? {} : { finishedAt: trace.finishedAt }),
    ...(trace.queryPlanId === undefined ? {} : { queryPlanId: trace.queryPlanId }),
    ...(trace.retrievalId === undefined ? {} : { retrievalId: trace.retrievalId }),
    ...(trace.contextId === undefined ? {} : { contextId: trace.contextId }),
    ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
    ...(trace.answerId === undefined ? {} : { answerId: trace.answerId }),
    ...(trace.modelRequestId === undefined ? {} : { modelRequestId: trace.modelRequestId }),
    retrievedChunkCount: trace.retrievedChunkIds.length,
    rejectedChunkCount: trace.rejectedChunkIds.length,
    finalCitationCount: trace.finalCitations.length,
    safetyFlagCount: trace.safetyFlags.length,
    eventCount: trace.events.length,
    eventKinds: trace.events.map((event) => event.kind),
    finalCitationKeys: citationKeys(trace.finalCitations),
    linked: trace.events.every(
      (event) => event.runId === trace.runId && event.traceId === trace.traceId
    )
  };
}

export function compareRunTraces(
  baseline: RagRunTrace | undefined,
  current: RagRunTrace | undefined,
  options: TraceReplayOptions = {}
): TraceReplayComparison {
  if (!baseline || !current) {
    return {
      status: "not_comparable",
      severity: "warning",
      failures: [],
      warnings: [
        !baseline && !current
          ? "Baseline and current traces are missing."
          : !baseline
            ? "Baseline trace is missing."
            : "Current trace is missing."
      ],
      deltas: [],
      ...(baseline === undefined ? {} : { baseline: summarizeRunTrace(baseline) }),
      ...(current === undefined ? {} : { current: summarizeRunTrace(current) })
    };
  }

  const baselineSummary = summarizeRunTrace(baseline);
  const currentSummary = summarizeRunTrace(current);
  const failures: string[] = [];
  const warnings: string[] = [];
  const deltas: TraceComparisonDelta[] = [];

  compareScalar("profileId", baselineSummary.profileId, currentSummary.profileId, failures, deltas);
  compareScalar(
    "namespaceId",
    baselineSummary.namespaceId,
    currentSummary.namespaceId,
    failures,
    deltas
  );
  compareScalar("status", baselineSummary.status, currentSummary.status, failures, deltas);
  compareScalar(
    "questionHash",
    baselineSummary.questionHash,
    currentSummary.questionHash,
    failures,
    deltas
  );

  if (!options.allowRunIdChange) {
    compareScalar("runId", baselineSummary.runId, currentSummary.runId, failures, deltas);
  }

  if (!options.allowTraceIdChange) {
    compareScalar("traceId", baselineSummary.traceId, currentSummary.traceId, failures, deltas);
  }

  compareOptionalScalar(
    "queryPlanId",
    baselineSummary.queryPlanId,
    currentSummary.queryPlanId,
    failures,
    deltas
  );
  compareOptionalScalar(
    "retrievalId",
    baselineSummary.retrievalId,
    currentSummary.retrievalId,
    failures,
    deltas
  );
  compareOptionalScalar(
    "contextId",
    baselineSummary.contextId,
    currentSummary.contextId,
    failures,
    deltas
  );
  compareOptionalScalar(
    "generationId",
    baselineSummary.generationId,
    currentSummary.generationId,
    failures,
    deltas
  );
  compareOptionalScalar(
    "answerId",
    baselineSummary.answerId,
    currentSummary.answerId,
    failures,
    deltas
  );
  compareOptionalScalar(
    "modelRequestId",
    baselineSummary.modelRequestId,
    currentSummary.modelRequestId,
    failures,
    deltas
  );

  compareStringSet(
    "retrievedChunkIds",
    baseline.retrievedChunkIds,
    current.retrievedChunkIds,
    options.allowRetrievedChunkDrift,
    failures,
    warnings,
    deltas
  );
  compareStringSet(
    "rejectedChunkIds",
    baseline.rejectedChunkIds,
    current.rejectedChunkIds,
    options.allowRejectedChunkDrift,
    failures,
    warnings,
    deltas
  );
  compareStringSet(
    "finalCitationKeys",
    baselineSummary.finalCitationKeys,
    currentSummary.finalCitationKeys,
    options.allowCitationDrift,
    failures,
    warnings,
    deltas
  );
  compareStringSet(
    "safetyFlags",
    baseline.safetyFlags,
    current.safetyFlags,
    false,
    failures,
    warnings,
    deltas
  );

  compareStringSequence(
    "eventKinds",
    baselineSummary.eventKinds,
    currentSummary.eventKinds,
    options.allowEventSequenceDrift,
    failures,
    warnings,
    deltas
  );

  if (!baselineSummary.linked) {
    failures.push("Baseline trace events are not linked to one runId and traceId.");
  }
  if (!currentSummary.linked) {
    failures.push("Current trace events are not linked to one runId and traceId.");
  }

  return {
    status: failures.length === 0 ? "matched" : "mismatched",
    severity: severityFor(current.status, failures.length),
    failures,
    warnings,
    deltas,
    baseline: baselineSummary,
    current: currentSummary
  };
}

export function traceStatusSeverity(status: RagRunStatus): TraceForensicsSeverity {
  switch (status) {
    case "query_succeeded":
    case "succeeded":
      return "info";
    case "refused":
    case "human_review_required":
    case "validation_failed":
      return "warning";
    case "retrieval_failed":
    case "context_failed":
    case "model_failed":
      return "high";
    case "generation_failed":
      return "critical";
  }
}

function severityFor(status: RagRunStatus, failureCount: number): TraceForensicsSeverity {
  if (failureCount === 0) {
    return traceStatusSeverity(status);
  }

  const statusSeverity = traceStatusSeverity(status);
  if (statusSeverity === "critical") {
    return "critical";
  }

  return "high";
}

function compareScalar(
  field: string,
  baseline: string,
  current: string,
  failures: string[],
  deltas: TraceComparisonDelta[]
): void {
  if (baseline === current) {
    return;
  }

  failures.push(`Trace field "${field}" changed from "${baseline}" to "${current}".`);
  deltas.push({ field, baseline, current });
}

function compareOptionalScalar(
  field: string,
  baseline: string | undefined,
  current: string | undefined,
  failures: string[],
  deltas: TraceComparisonDelta[]
): void {
  compareScalar(field, baseline ?? "missing", current ?? "missing", failures, deltas);
}

function compareStringSet(
  field: string,
  baseline: readonly string[],
  current: readonly string[],
  allowed: boolean | undefined,
  failures: string[],
  warnings: string[],
  deltas: TraceComparisonDelta[]
): void {
  const baselineSet = uniqueSorted(baseline);
  const currentSet = uniqueSorted(current);
  if (sameStringArray(baselineSet, currentSet)) {
    return;
  }

  const message = `Trace field "${field}" changed.`;
  if (allowed) {
    warnings.push(message);
  } else {
    failures.push(message);
  }
  deltas.push({ field, baseline: baselineSet, current: currentSet });
}

function compareStringSequence(
  field: string,
  baseline: readonly string[],
  current: readonly string[],
  allowed: boolean | undefined,
  failures: string[],
  warnings: string[],
  deltas: TraceComparisonDelta[]
): void {
  if (sameStringArray(baseline, current)) {
    return;
  }

  const message = `Trace sequence "${field}" changed.`;
  if (allowed) {
    warnings.push(message);
  } else {
    failures.push(message);
  }
  deltas.push({ field, baseline, current });
}

function citationKeys(citations: readonly CitationPointer[]): readonly string[] {
  return uniqueSorted(
    citations.map((citation) =>
      [
        citation.sourceId,
        citation.chunkId,
        citation.locator ?? "",
        citation.visualAssetId ?? "",
        citation.visualAsset?.id ?? "",
        citation.pageNumber === undefined ? "" : String(citation.pageNumber),
        ...(citation.layoutRegionIds ?? [])
      ].join(":")
    )
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStringArray(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
