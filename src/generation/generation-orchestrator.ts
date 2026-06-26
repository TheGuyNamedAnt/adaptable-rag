import { GroundingGate } from "../answer/grounding-gate.js";
import type { AnswerGateResult, AnswerValidationResult } from "../answer/answer-types.js";
import type { GroundingJudge, GroundingJudgeResult } from "../answer/grounding-judge.js";
import { BudgetMeter, type BudgetIssue } from "../budget/budget-meter.js";
import type {
  ModelAdapter,
  ModelGenerateRequest,
  ModelGenerateResult
} from "../model/model-types.js";
import type {
  GenerationModelTrace,
  GenerationRunRequest,
  GenerationRunResult,
  GenerationRunStatus,
  GenerationTrace,
  GenerationWarning,
  GenerationWarningCode
} from "./generation-types.js";

export interface GenerationOrchestratorOptions {
  readonly gate?: GroundingGate;
  readonly groundingJudge?: GroundingJudge;
  readonly now?: () => string;
}

const EMPTY_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0
} as const;

export class GenerationOrchestrator {
  private readonly gate: GroundingGate;
  private readonly groundingJudge: GroundingJudge | undefined;
  private readonly now: () => string;

  constructor(options: GenerationOrchestratorOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.gate = options.gate ?? new GroundingGate({ now: this.now });
    this.groundingJudge = options.groundingJudge;
  }

  async run(request: GenerationRunRequest): Promise<GenerationRunResult> {
    const startedAt = request.requestedAt ?? this.now();
    const generationId =
      request.generationId ?? `generation_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const answerId = request.answerId ?? `answer_${generationId}`;
    const budget = new BudgetMeter(request.profile.costLatencyBudget);
    const gate = this.gate.prepare({
      profile: request.profile,
      context: request.context,
      question: request.question,
      answerId,
      requestedAt: startedAt
    });

    if (!gate.canGenerate || !gate.generation) {
      const status: GenerationRunStatus = "refused";
      return {
        status,
        resolvedCitations: [],
        ...(gate.refusal ? { refusal: gate.refusal } : {}),
        gate,
        warnings: [],
        trace: buildTrace({
          request,
          generationId,
          answerId,
          startedAt,
          finishedAt: this.now(),
          status,
          gate,
          modelTrace: { attempted: false },
          warnings: []
        })
      };
    }

    const modelRequest: ModelGenerateRequest = {
      requestId: `model_${generationId}`,
      profileId: request.profile.id,
      namespaceId: request.profile.namespaceId,
      modelTier: request.profile.modelPolicy.defaultTierByRole.answer_generation,
      input: gate.generation,
      requestedAt: startedAt
    };
    const model = await callModel(request.model, modelRequest, this.now);
    const modelBudgetWarnings = budgetWarnings(budget.recordModelCall(model));

    if (model.status === "failed" || !model.draft) {
      const status: GenerationRunStatus = "model_failed";
      const warnings = [...modelWarnings(model), ...modelBudgetWarnings];
      return {
        status,
        gate,
        model,
        resolvedCitations: [],
        warnings,
        trace: buildTrace({
          request,
          generationId,
          answerId,
          startedAt,
          finishedAt: this.now(),
          status,
          gate,
          modelTrace: modelTrace(model, modelRequest.requestId),
          warnings
        })
      };
    }

    const warnings = [
      ...modelWarnings(model),
      ...modelBudgetWarnings,
      ...budgetWarnings(
        budget.checkDraftOutput(
          estimateDraftTokens(model.draft),
          gate.generation.contract.maxOutputTokens
        )
      )
    ];
    const validation = this.gate.validateDraft({
      profile: request.profile,
      context: request.context,
      draft: model.draft,
      requestedAt: this.now()
    });
    const groundingJudge =
      validation.valid && this.groundingJudge
        ? await this.groundingJudge.judge({
            profile: request.profile,
            context: request.context,
            question: request.question,
            draft: model.draft,
            validation,
            judgeId: `${generationId}_judge`,
            requestedAt: this.now()
          })
        : undefined;
    const judgeWarningsValue = groundingJudge ? judgeWarnings(groundingJudge) : [];
    const judgeBudgetWarnings = groundingJudge
      ? budgetWarnings(budget.recordModelCall(groundingJudge))
      : [];
    const allWarnings = [...warnings, ...judgeWarningsValue, ...judgeBudgetWarnings];
    const status = runStatus(gate, validation, allWarnings, groundingJudge);
    const resolvedCitations = validation.valid
      ? resolveDraftCitations(model.draft, request.context)
      : [];

    return {
      status,
      draft: model.draft,
      resolvedCitations,
      gate,
      validation,
      ...(groundingJudge ? { groundingJudge } : {}),
      model,
      warnings: allWarnings,
      trace: buildTrace({
        request,
        generationId,
        answerId,
        startedAt,
        finishedAt: this.now(),
        status,
        gate,
        validation,
        ...(groundingJudge ? { groundingJudge } : {}),
        modelTrace: modelTrace(model, modelRequest.requestId),
        warnings: allWarnings
      })
    };
  }
}

async function callModel(
  adapter: ModelAdapter,
  request: ModelGenerateRequest,
  now: () => string
): Promise<ModelGenerateResult> {
  try {
    return await adapter.generate(request);
  } catch (error) {
    return {
      status: "failed",
      provider: adapter.provider,
      modelName: adapter.modelName,
      completedAt: now(),
      latencyMs: 0,
      usage: EMPTY_USAGE,
      cost: {
        amountUsd: 0,
        currency: "USD"
      },
      warnings: [],
      errorMessage: error instanceof Error ? error.message : "Unknown model adapter error."
    };
  }
}

function runStatus(
  gate: AnswerGateResult,
  validation: AnswerValidationResult,
  warnings: readonly GenerationWarning[],
  groundingJudge: GroundingJudgeResult | undefined
): GenerationRunStatus {
  if (!validation.valid) {
    return "validation_failed";
  }

  if (groundingJudge?.verdict === "unsupported") {
    return "validation_failed";
  }

  if (gate.requiresHumanReview || validation.warnings.length > 0 || warnings.length > 0) {
    return "human_review_required";
  }

  return "succeeded";
}

function modelTrace(model: ModelGenerateResult, requestId: string): GenerationModelTrace {
  return {
    attempted: true,
    requestId,
    provider: model.provider,
    modelName: model.modelName,
    status: model.status,
    latencyMs: model.latencyMs,
    promptTokens: model.usage.promptTokens,
    completionTokens: model.usage.completionTokens,
    totalTokens: model.usage.totalTokens,
    estimatedCostUsd: model.cost.amountUsd,
    warningCount: model.warnings.length,
    ...(model.errorMessage ? { errorMessage: model.errorMessage } : {})
  };
}

function modelWarnings(model: ModelGenerateResult): readonly GenerationWarning[] {
  return model.warnings.map((message) => ({
    code: "model_warning",
    message,
    path: "model.warnings",
    source: `${model.provider}:${model.modelName}`
  }));
}

function budgetWarnings(issues: readonly BudgetIssue[]): readonly GenerationWarning[] {
  return issues.map((budgetIssue) => ({
    code: budgetIssue.code,
    message: budgetIssue.message,
    path: budgetIssue.path,
    actual: budgetIssue.actual,
    limit: budgetIssue.limit,
    ...(budgetIssue.source ? { source: budgetIssue.source } : {})
  }));
}

function judgeWarnings(judge: GroundingJudgeResult): readonly GenerationWarning[] {
  const warnings: GenerationWarning[] = judge.warnings.map((message) => ({
    code: "grounding_judge_warning",
    message,
    path: "groundingJudge.warnings",
    source: `${judge.provider}:${judge.modelName}`
  }));

  if (judge.verdict === "needs_review") {
    warnings.push({
      code: "grounding_judge_warning",
      message: "Grounding judge requested human review.",
      path: "groundingJudge.verdict",
      source: `${judge.provider}:${judge.modelName}`
    });
  }

  if (judge.verdict === "failed") {
    warnings.push({
      code: "grounding_judge_failed",
      message: "Grounding judge failed before confirming groundedness.",
      path: "groundingJudge.verdict",
      source: `${judge.provider}:${judge.modelName}`
    });
  }

  return warnings;
}

function estimateDraftTokens(draft: NonNullable<ModelGenerateResult["draft"]>): number {
  const serialized = [
    draft.answer,
    draft.evidenceSummary ?? "",
    draft.citationChunkIds.join(" "),
    draft.actions?.join(" ") ?? ""
  ].join("\n");

  return Math.max(1, Math.ceil(serialized.length / 4));
}

function resolveDraftCitations(
  draft: NonNullable<ModelGenerateResult["draft"]>,
  context: GenerationRunRequest["context"]
): GenerationRunRequest["context"]["citations"] {
  const citationsByChunkId = new Map(
    context.citations.map((citation) => [citation.chunkId, citation])
  );

  return uniqueStrings([
    ...draft.citationChunkIds,
    ...(draft.citations?.map((citation) => citation.chunkId) ?? [])
  ]).flatMap((chunkId) => {
    const citation = citationsByChunkId.get(chunkId);
    return citation === undefined ? [] : [citation];
  });
}

function buildTrace(input: {
  readonly request: GenerationRunRequest;
  readonly generationId: string;
  readonly answerId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: GenerationRunStatus;
  readonly gate: AnswerGateResult;
  readonly validation?: AnswerValidationResult;
  readonly groundingJudge?: GroundingJudgeResult;
  readonly modelTrace: GenerationModelTrace;
  readonly warnings: readonly GenerationWarning[];
}): GenerationTrace {
  return {
    generationId: input.generationId,
    answerId: input.answerId,
    contextId: input.request.context.trace.contextId,
    retrievalId: input.request.context.trace.retrievalId,
    profileId: input.request.profile.id,
    namespaceId: input.request.profile.namespaceId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    gateStatus: input.gate.status,
    ...(input.validation ? { validationValid: input.validation.valid } : {}),
    validationErrorCount: input.validation?.errors.length ?? 0,
    validationWarningCount: input.validation?.warnings.length ?? 0,
    warningCount: input.warnings.length,
    warningCodes: uniqueWarningCodes(input.warnings.map((warning) => warning.code)),
    model: input.modelTrace,
    ...(input.groundingJudge
      ? {
          groundingJudge: {
            judgeId: input.groundingJudge.trace.judgeId,
            verdict: input.groundingJudge.verdict,
            provider: input.groundingJudge.provider,
            modelName: input.groundingJudge.modelName,
            modelTier: input.groundingJudge.modelTier,
            latencyMs: input.groundingJudge.latencyMs,
            issueCount: input.groundingJudge.issues.length,
            warningCount: input.groundingJudge.warnings.length
          }
        }
      : {})
  };
}

function uniqueWarningCodes(
  values: readonly GenerationWarningCode[]
): readonly GenerationWarningCode[] {
  return [...new Set(values)].sort();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
