import type { CitationPointer } from "../documents/provenance.js";

export type TraceEventKind =
  | "run_started"
  | "query_planned"
  | "retrieval_started"
  | "retrieval_finished"
  | "retrieval_reranked"
  | "chunk_retrieved"
  | "chunk_rejected"
  | "context_built"
  | "generation_started"
  | "answer_generated"
  | "grounding_checked"
  | "grounding_judged"
  | "run_failed"
  | "run_finished";

export type RagRunStatus =
  | "query_succeeded"
  | "succeeded"
  | "human_review_required"
  | "refused"
  | "model_failed"
  | "validation_failed"
  | "retrieval_failed"
  | "context_failed"
  | "generation_failed";

export interface TraceEvent {
  readonly runId: string;
  readonly traceId: string;
  readonly kind: TraceEventKind;
  readonly at: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RagRunTrace {
  readonly runId: string;
  readonly traceId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: RagRunStatus;
  readonly questionHash: string;
  readonly queryPlanId?: string;
  readonly plannedQueryHashes: readonly string[];
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly answerId?: string;
  readonly generationId?: string;
  readonly modelRequestId?: string;
  readonly retrievedChunkIds: readonly string[];
  readonly rejectedChunkIds: readonly string[];
  readonly finalCitations: readonly CitationPointer[];
  readonly safetyFlags: readonly string[];
  readonly events: readonly TraceEvent[];
}
