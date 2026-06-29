import type { RagAnswerRuntime } from "./rag-answer-runtime.js";
import type {
  RagAgentRequest,
  RagAgentResult,
  RagAgentRetryPlan,
  RagAgentStep,
  RagAgentStepReason,
  RagAgentStatus,
  RagAnswerResult
} from "./runtime-types.js";

export interface RagAgentRuntimeOptions {
  readonly answerRuntime: RagAnswerRuntime;
  readonly now?: () => string;
}

const DEFAULT_MAX_STEPS = 3;
const MAX_AGENT_STEPS = 8;
const MAX_TOP_K = 100;
const MAX_CANDIDATE_POOL_LIMIT = 5000;

export class RagAgentRuntime {
  private readonly answerRuntime: RagAnswerRuntime;
  private readonly now: () => string;

  constructor(options: RagAgentRuntimeOptions) {
    this.answerRuntime = options.answerRuntime;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(request: RagAgentRequest): Promise<RagAgentResult> {
    const startedAt = request.requestedAt ?? this.now();
    const agentRunId = request.runId ?? `agent_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const traceId = request.traceId ?? `trace_${agentRunId}`;
    const maxSteps = clampStepCount(request.maxSteps ?? DEFAULT_MAX_STEPS);
    const retryWhenEvidenceInsufficient = request.retryWhenEvidenceInsufficient ?? true;
    const steps: RagAgentStep[] = [];
    let nextReason: RagAgentStepReason = "initial";
    let topK = request.topK;
    let candidatePoolLimit = request.candidatePoolLimit;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const result = await this.answerRuntime.answer({
        ...request,
        ...(topK === undefined ? {} : { topK }),
        ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
        runId: `${agentRunId}_step_${stepIndex + 1}`,
        traceId,
        retrievalId: `${agentRunId}_step_${stepIndex + 1}_retrieval`,
        contextId: `${agentRunId}_step_${stepIndex + 1}_context`,
        generationId: `${agentRunId}_step_${stepIndex + 1}_generation`,
        answerId: `${agentRunId}_step_${stepIndex + 1}_answer`,
        requestedAt: stepIndex === 0 ? startedAt : this.now()
      });
      const retryPlan = planRetry({
        request,
        result,
        retryWhenEvidenceInsufficient,
        stepIndex,
        maxSteps,
        topK,
        candidatePoolLimit
      });
      steps.push({
        stepIndex,
        reason: nextReason,
        ...(topK === undefined ? {} : { topK }),
        ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
        retryPlan,
        result
      });

      if (!retryPlan.planned) {
        return buildAgentResult({
          status: result.status,
          steps,
          final: result,
          agentRunId,
          traceId,
          startedAt,
          finishedAt: this.now()
        });
      }

      if (!retryPlan.reason || !retryPlan.nextTopK || !retryPlan.nextCandidatePoolLimit) {
        throw new Error("Agent retry plan is missing the next retrieval attempt.");
      }

      nextReason = retryPlan.reason;
      topK = retryPlan.nextTopK;
      candidatePoolLimit = retryPlan.nextCandidatePoolLimit;
    }

    const final = steps[steps.length - 1]?.result;
    if (!final) {
      throw new Error("Agent runtime did not execute any answer steps.");
    }

    return buildAgentResult({
      status: "max_steps_exceeded",
      steps,
      final,
      agentRunId,
      traceId,
      startedAt,
      finishedAt: this.now()
    });
  }
}

function planRetry(input: {
  readonly request: RagAgentRequest;
  readonly result: RagAnswerResult;
  readonly retryWhenEvidenceInsufficient: boolean;
  readonly stepIndex: number;
  readonly maxSteps: number;
  readonly topK: number | undefined;
  readonly candidatePoolLimit: number | undefined;
}): RagAgentRetryPlan {
  const evidenceStatus =
    "context" in input.result ? input.result.context.evidence.status : undefined;
  const adaptiveRetryStrategy =
    "retrieval" in input.result
      ? input.result.retrieval.trace.adaptiveStrategy?.retryStrategy
      : undefined;

  if (!input.retryWhenEvidenceInsufficient) {
    return {
      planned: false,
      ...(evidenceStatus === undefined ? {} : { evidenceStatus }),
      ...(adaptiveRetryStrategy === undefined ? {} : { adaptiveRetryStrategy }),
      stoppedBecause: "retry_disabled"
    };
  }

  if (input.result.status === "retrieval_failed") {
    return { planned: false, stoppedBecause: "retrieval_failed" };
  }

  if (input.result.status === "context_failed") {
    return {
      planned: false,
      ...(adaptiveRetryStrategy === undefined ? {} : { adaptiveRetryStrategy }),
      stoppedBecause: "context_failed"
    };
  }

  if (
    !("context" in input.result) ||
    !isRetryableEvidenceStatus(input.result.context.evidence.status)
  ) {
    return {
      planned: false,
      ...(evidenceStatus === undefined ? {} : { evidenceStatus }),
      ...(adaptiveRetryStrategy === undefined ? {} : { adaptiveRetryStrategy }),
      stoppedBecause: "not_retryable"
    };
  }

  if (input.stepIndex >= input.maxSteps - 1) {
    return {
      planned: false,
      evidenceStatus: input.result.context.evidence.status,
      ...(adaptiveRetryStrategy === undefined ? {} : { adaptiveRetryStrategy }),
      stoppedBecause: "max_steps_reached"
    };
  }

  const reason = retryReasonForResult(input.result);
  const expanded = expandRetrievalBudget(
    input.request,
    input.topK,
    input.candidatePoolLimit,
    reason
  );

  return {
    planned: true,
    reason,
    evidenceStatus: input.result.context.evidence.status,
    ...(adaptiveRetryStrategy === undefined ? {} : { adaptiveRetryStrategy }),
    nextTopK: expanded.topK,
    nextCandidatePoolLimit: expanded.candidatePoolLimit
  };
}

function expandRetrievalBudget(
  request: RagAgentRequest,
  topK: number | undefined,
  candidatePoolLimit: number | undefined,
  reason: RagAgentStepReason
): { readonly topK: number; readonly candidatePoolLimit: number } {
  const baseTopK = topK ?? request.topK ?? request.profile.retrieval.maxChunks;
  const multiplier = retrievalExpansionMultiplier(reason);
  const nextTopK = Math.min(Math.max(baseTopK + 1, Math.ceil(baseTopK * multiplier)), MAX_TOP_K);
  const baseCandidatePool =
    candidatePoolLimit ?? request.candidatePoolLimit ?? Math.max(nextTopK * 4, 20);
  const candidatePoolMultiplier = candidatePoolExpansionMultiplier(reason);

  return {
    topK: nextTopK,
    candidatePoolLimit: Math.min(
      Math.max(baseCandidatePool * 2, nextTopK * candidatePoolMultiplier, 20),
      MAX_CANDIDATE_POOL_LIMIT
    )
  };
}

function retryReasonForResult(result: RagAnswerResult): Exclude<RagAgentStepReason, "initial"> {
  if (!("context" in result)) {
    return "evidence_retry";
  }

  const strategy = result.retrieval.trace.adaptiveStrategy;
  if (strategy?.retryStrategy) {
    switch (strategy.retryStrategy) {
      case "graph_deepening":
      case "visual_retrieval":
      case "freshness_expansion":
      case "expanded_candidate_pool":
        return strategy.retryStrategy;
      case "hybrid":
      case "keyword_only":
      case "vector_only":
      case "graph_augmented":
      case "refuse_missing_or_denied":
        break;
    }
  }

  switch (result.context.evidence.status) {
    case "insufficient_trusted_citations":
      return "trusted_evidence_retry";
    case "insufficient_citations":
      return "citation_retry";
    case "no_evidence":
      return "expanded_candidate_pool";
    case "answerable":
      return "evidence_retry";
  }
}

function isRetryableEvidenceStatus(status: RagAgentRetryPlan["evidenceStatus"]): boolean {
  return (
    status === "no_evidence" ||
    status === "insufficient_citations" ||
    status === "insufficient_trusted_citations"
  );
}

function retrievalExpansionMultiplier(reason: RagAgentStepReason): number {
  switch (reason) {
    case "graph_deepening":
    case "visual_retrieval":
      return 2;
    case "freshness_expansion":
    case "trusted_evidence_retry":
      return 1.75;
    case "citation_retry":
    case "expanded_candidate_pool":
    case "evidence_retry":
    case "initial":
      return 1.5;
  }
}

function candidatePoolExpansionMultiplier(reason: RagAgentStepReason): number {
  switch (reason) {
    case "graph_deepening":
      return 6;
    case "visual_retrieval":
    case "freshness_expansion":
      return 5;
    case "trusted_evidence_retry":
    case "citation_retry":
    case "expanded_candidate_pool":
    case "evidence_retry":
    case "initial":
      return 4;
  }
}

function buildAgentResult(input: {
  readonly status: RagAgentStatus;
  readonly steps: readonly RagAgentStep[];
  readonly final: RagAnswerResult;
  readonly agentRunId: string;
  readonly traceId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}): RagAgentResult {
  return {
    status: input.status,
    steps: input.steps,
    final: input.final,
    trace: {
      agentRunId: input.agentRunId,
      traceId: input.traceId,
      profileId: input.final.trace.profileId,
      namespaceId: input.final.trace.namespaceId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: input.status,
      stepCount: input.steps.length,
      answerRunIds: input.steps.map((step) => step.result.trace.runId),
      finalAnswerRunId: input.final.trace.runId,
      retryReasons: input.steps.flatMap((step) =>
        step.retryPlan.reason === undefined ? [] : [step.retryPlan.reason]
      ),
      evidenceStatuses: input.steps.flatMap((step) =>
        step.retryPlan.evidenceStatus === undefined ? [] : [step.retryPlan.evidenceStatus]
      )
    }
  };
}

function clampStepCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Agent maxSteps must be a positive integer.");
  }

  return Math.min(value, MAX_AGENT_STEPS);
}
