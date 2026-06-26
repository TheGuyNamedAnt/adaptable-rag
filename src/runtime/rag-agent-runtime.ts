import type { RagAnswerRuntime } from "./rag-answer-runtime.js";
import type {
  RagAgentRequest,
  RagAgentResult,
  RagAgentStep,
  RagAgentStatus,
  RagAnswerResult
} from "./runtime-types.js";

export interface RagAgentRuntimeOptions {
  readonly answerRuntime: RagAnswerRuntime;
  readonly now?: () => string;
}

const DEFAULT_MAX_STEPS = 3;
const MAX_AGENT_STEPS = 8;

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
    let nextReason: RagAgentStep["reason"] = "initial";
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
      steps.push({
        stepIndex,
        reason: nextReason,
        ...(topK === undefined ? {} : { topK }),
        ...(candidatePoolLimit === undefined ? {} : { candidatePoolLimit }),
        result
      });

      if (!shouldRetry(result, retryWhenEvidenceInsufficient, stepIndex, maxSteps)) {
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

      nextReason = "evidence_retry";
      const expanded = expandRetrievalBudget(request, topK, candidatePoolLimit);
      topK = expanded.topK;
      candidatePoolLimit = expanded.candidatePoolLimit;
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

function shouldRetry(
  result: RagAnswerResult,
  retryWhenEvidenceInsufficient: boolean,
  stepIndex: number,
  maxSteps: number
): boolean {
  if (!retryWhenEvidenceInsufficient || stepIndex >= maxSteps - 1) {
    return false;
  }

  if (!("context" in result)) {
    return false;
  }

  return (
    result.context.evidence.status === "no_evidence" ||
    result.context.evidence.status === "insufficient_citations" ||
    result.context.evidence.status === "insufficient_trusted_citations"
  );
}

function expandRetrievalBudget(
  request: RagAgentRequest,
  topK: number | undefined,
  candidatePoolLimit: number | undefined
): { readonly topK: number; readonly candidatePoolLimit: number } {
  const baseTopK = topK ?? request.topK ?? request.profile.retrieval.maxChunks;
  const nextTopK = Math.min(Math.max(baseTopK + 1, Math.ceil(baseTopK * 1.5)), 100);
  const baseCandidatePool =
    candidatePoolLimit ?? request.candidatePoolLimit ?? Math.max(nextTopK * 4, 20);

  return {
    topK: nextTopK,
    candidatePoolLimit: Math.min(Math.max(baseCandidatePool, nextTopK * 4), 5000)
  };
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
      finalAnswerRunId: input.final.trace.runId
    }
  };
}

function clampStepCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Agent maxSteps must be a positive integer.");
  }

  return Math.min(value, MAX_AGENT_STEPS);
}
