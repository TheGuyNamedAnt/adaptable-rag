import type { ContextBuildResult } from "../context/context-types.js";
import type { CitationPointer } from "../documents/provenance.js";
import type { GenerationRunResult } from "../generation/generation-types.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { ModelAdapter } from "../model/model-types.js";
import type { RagRunStatus, RagRunTrace } from "../observability/trace.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RetrievalResult } from "../retrieval/retrieval-types.js";

export interface RagAnswerRequest {
  readonly profile: ValidatedRagProfile;
  readonly question: string;
  readonly filter: IndexFilter;
  readonly model: ModelAdapter;
  readonly topK?: number;
  readonly candidatePoolLimit?: number;
  readonly includeRejected?: boolean;
  readonly runId?: string;
  readonly traceId?: string;
  readonly retrievalId?: string;
  readonly contextId?: string;
  readonly answerId?: string;
  readonly generationId?: string;
  readonly requestedAt?: string;
}

export type RagQueryRequest = Omit<RagAnswerRequest, "model">;

export interface RagAgentRequest extends Omit<
  RagAnswerRequest,
  "retrievalId" | "contextId" | "answerId" | "generationId"
> {
  readonly maxSteps?: number;
  readonly retryWhenEvidenceInsufficient?: boolean;
}

export type RagAnswerFailureStage = "retrieval" | "context" | "generation";

export interface RagAnswerFailure {
  readonly stage: RagAnswerFailureStage;
  readonly errorName: string;
  readonly message: string;
}

export type RagAnswerResult =
  | {
      readonly status: Exclude<
        RagRunStatus,
        "retrieval_failed" | "context_failed" | "generation_failed"
      >;
      readonly retrieval: RetrievalResult;
      readonly context: ContextBuildResult;
      readonly generation: GenerationRunResult;
      readonly answerCitations: readonly CitationPointer[];
      readonly trace: RagRunTrace;
    }
  | {
      readonly status: "retrieval_failed";
      readonly failure: RagAnswerFailure;
      readonly trace: RagRunTrace;
    }
  | {
      readonly status: "context_failed";
      readonly retrieval: RetrievalResult;
      readonly failure: RagAnswerFailure;
      readonly trace: RagRunTrace;
    }
  | {
      readonly status: "generation_failed";
      readonly retrieval: RetrievalResult;
      readonly context: ContextBuildResult;
      readonly failure: RagAnswerFailure;
      readonly trace: RagRunTrace;
    };

export type RagQueryResult =
  | {
      readonly status: "query_succeeded";
      readonly retrieval: RetrievalResult;
      readonly context: ContextBuildResult;
      readonly trace: RagRunTrace;
    }
  | {
      readonly status: "retrieval_failed";
      readonly failure: RagAnswerFailure;
      readonly trace: RagRunTrace;
    }
  | {
      readonly status: "context_failed";
      readonly retrieval: RetrievalResult;
      readonly failure: RagAnswerFailure;
      readonly trace: RagRunTrace;
    };

export type RagAgentStatus = RagAnswerResult["status"] | "max_steps_exceeded";

export interface RagAgentStep {
  readonly stepIndex: number;
  readonly reason: "initial" | "evidence_retry";
  readonly topK?: number;
  readonly candidatePoolLimit?: number;
  readonly result: RagAnswerResult;
}

export interface RagAgentTrace {
  readonly agentRunId: string;
  readonly traceId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RagAgentStatus;
  readonly stepCount: number;
  readonly answerRunIds: readonly string[];
  readonly finalAnswerRunId?: string;
}

export interface RagAgentResult {
  readonly status: RagAgentStatus;
  readonly steps: readonly RagAgentStep[];
  readonly final: RagAnswerResult;
  readonly trace: RagAgentTrace;
}
