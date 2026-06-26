import type {
  AnswerGateResult,
  AnswerRefusal,
  AnswerValidationResult,
  SourcedAnswerDraft
} from "../answer/answer-types.js";
import type { GroundingJudgeResult } from "../answer/grounding-judge.js";
import type { ContextBuildResult } from "../context/context-types.js";
import type { ModelAdapter, ModelGenerateResult } from "../model/model-types.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";

export type GenerationRunStatus =
  | "succeeded"
  | "human_review_required"
  | "refused"
  | "model_failed"
  | "validation_failed";

export type GenerationWarningCode =
  | "model_warning"
  | "retrieval_call_budget_exceeded"
  | "model_call_budget_exceeded"
  | "model_latency_budget_exceeded"
  | "model_cost_budget_exceeded"
  | "draft_output_budget_exceeded"
  | "grounding_judge_warning"
  | "grounding_judge_failed";

export interface GenerationWarning {
  readonly code: GenerationWarningCode;
  readonly message: string;
  readonly path: string;
  readonly actual?: number;
  readonly limit?: number;
  readonly source?: string;
}

export interface GenerationRunRequest {
  readonly profile: ValidatedRagProfile;
  readonly context: ContextBuildResult;
  readonly question: string;
  readonly model: ModelAdapter;
  readonly generationId?: string;
  readonly answerId?: string;
  readonly requestedAt?: string;
}

export interface GenerationModelTrace {
  readonly attempted: boolean;
  readonly requestId?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly status?: ModelGenerateResult["status"];
  readonly latencyMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly warningCount?: number;
  readonly errorMessage?: string;
}

export interface GenerationTrace {
  readonly generationId: string;
  readonly answerId: string;
  readonly contextId: string;
  readonly retrievalId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: GenerationRunStatus;
  readonly gateStatus: AnswerGateResult["status"];
  readonly validationValid?: boolean;
  readonly validationErrorCount: number;
  readonly validationWarningCount: number;
  readonly warningCount: number;
  readonly warningCodes: readonly GenerationWarningCode[];
  readonly model: GenerationModelTrace;
  readonly groundingJudge?: {
    readonly judgeId: string;
    readonly verdict: GroundingJudgeResult["verdict"];
    readonly provider: string;
    readonly modelName: string;
    readonly modelTier: string;
    readonly latencyMs: number;
    readonly issueCount: number;
    readonly warningCount: number;
  };
}

export interface GenerationRunResult {
  readonly status: GenerationRunStatus;
  readonly draft?: SourcedAnswerDraft;
  readonly resolvedCitations: ContextBuildResult["citations"];
  readonly refusal?: AnswerRefusal;
  readonly gate: AnswerGateResult;
  readonly validation?: AnswerValidationResult;
  readonly groundingJudge?: GroundingJudgeResult;
  readonly model?: ModelGenerateResult;
  readonly warnings: readonly GenerationWarning[];
  readonly trace: GenerationTrace;
}
