import type { AnswerValidationResult, SourcedAnswerDraft } from "../answer/answer-types.js";
import type { ContextBlock, ContextBuildResult } from "../context/context-types.js";
import type { ModelTier } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";

export type GroundingJudgeVerdict = "grounded" | "unsupported" | "needs_review" | "failed";

export type GroundingJudgeIssueCode =
  | "unsupported_claim"
  | "missing_citation_support"
  | "contradicted_by_context"
  | "unsafe_context_instruction_followed"
  | "judge_failed";

export interface GroundingJudgeIssue {
  readonly code: GroundingJudgeIssueCode;
  readonly message: string;
  readonly chunkId?: string;
}

export interface GroundingJudgeRequest {
  readonly profile: ValidatedRagProfile;
  readonly context: ContextBuildResult;
  readonly question: string;
  readonly draft: SourcedAnswerDraft;
  readonly validation: AnswerValidationResult;
  readonly judgeId?: string;
  readonly requestedAt?: string;
}

export interface GroundingJudgeTrace {
  readonly judgeId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly contextId: string;
  readonly verdict: GroundingJudgeVerdict;
  readonly issueCount: number;
  readonly citedChunkIds: readonly string[];
  readonly provider: string;
  readonly modelName: string;
  readonly modelTier: ModelTier;
  readonly latencyMs: number;
  readonly warningCodes: readonly string[];
}

export interface GroundingJudgeResult {
  readonly verdict: GroundingJudgeVerdict;
  readonly issues: readonly GroundingJudgeIssue[];
  readonly provider: string;
  readonly modelName: string;
  readonly modelTier: ModelTier;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly cost: {
    readonly amountUsd: number;
    readonly currency: "USD";
  };
  readonly warnings: readonly string[];
  readonly trace: GroundingJudgeTrace;
}

export interface GroundingJudge {
  judge(request: GroundingJudgeRequest): Promise<GroundingJudgeResult>;
}

export interface GroundingJudgeModelContextBlock {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly trustTier: string;
  readonly text: string;
  readonly graphEvidence?: ContextBlock["graphEvidence"];
}

export interface GroundingJudgeModelRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly modelTier: ModelTier;
  readonly question: string;
  readonly answer: string;
  readonly citationChunkIds: readonly string[];
  readonly contextBlocks: readonly GroundingJudgeModelContextBlock[];
  readonly requestedAt?: string;
}

export interface GroundingJudgeModelResult {
  readonly verdict: GroundingJudgeVerdict;
  readonly issues: readonly GroundingJudgeIssue[];
  readonly provider: string;
  readonly modelName: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly cost: {
    readonly amountUsd: number;
    readonly currency: "USD";
  };
  readonly warnings: readonly string[];
}

export interface GroundingJudgeModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  judge(request: GroundingJudgeModelRequest): Promise<GroundingJudgeModelResult>;
}

export interface ModelBackedGroundingJudgeOptions {
  readonly adapter: GroundingJudgeModelAdapter;
  readonly now?: () => string;
}

export class ModelBackedGroundingJudge implements GroundingJudge {
  private readonly adapter: GroundingJudgeModelAdapter;
  private readonly now: () => string;

  constructor(options: ModelBackedGroundingJudgeOptions) {
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async judge(request: GroundingJudgeRequest): Promise<GroundingJudgeResult> {
    const startedAt = request.requestedAt ?? this.now();
    const judgeId = request.judgeId ?? `judge_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const modelTier = request.profile.modelPolicy.defaultTierByRole.grounding_judge;
    const modelRequest: GroundingJudgeModelRequest = {
      requestId: `model_${judgeId}`,
      profileId: request.profile.id,
      namespaceId: request.profile.namespaceId,
      modelTier,
      question: request.question,
      answer: request.draft.answer,
      citationChunkIds: request.draft.citationChunkIds,
      contextBlocks: request.context.blocks.map((block) => ({
        chunkId: block.chunkId,
        documentId: block.documentId,
        sourceId: block.provenance.sourceId,
        sourceKind: block.provenance.sourceKind,
        trustTier: block.provenance.trustTier,
        text: block.text,
        ...(block.graphEvidence === undefined ? {} : { graphEvidence: block.graphEvidence })
      })),
      requestedAt: startedAt
    };

    try {
      const model = await this.adapter.judge(modelRequest);
      const issues = sanitizeIssues(model.issues, request.context);
      const verdict = sanitizeVerdict(model.verdict, issues);
      return buildResult({
        request,
        judgeId,
        startedAt,
        finishedAt: this.now(),
        verdict,
        issues,
        provider: model.provider,
        modelName: model.modelName,
        modelTier,
        completedAt: model.completedAt,
        latencyMs: model.latencyMs,
        cost: model.cost,
        warnings: model.warnings
      });
    } catch (error) {
      return buildResult({
        request,
        judgeId,
        startedAt,
        finishedAt: this.now(),
        verdict: "failed",
        issues: [
          {
            code: "judge_failed",
            message:
              error instanceof Error
                ? "Grounding judge failed before returning a safe verdict."
                : "Grounding judge failed with an unknown error."
          }
        ],
        provider: this.adapter.provider,
        modelName: this.adapter.modelName,
        modelTier,
        completedAt: this.now(),
        latencyMs: 0,
        cost: {
          amountUsd: 0,
          currency: "USD"
        },
        warnings: ["grounding_judge_failed"]
      });
    }
  }
}

function sanitizeIssues(
  issues: readonly GroundingJudgeIssue[],
  context: ContextBuildResult
): readonly GroundingJudgeIssue[] {
  const allowedChunkIds = new Set(context.blocks.map((block) => block.chunkId));
  return issues
    .filter((issue) => isKnownIssueCode(issue.code))
    .map((issue) => ({
      code: issue.code,
      message: issue.message.trim() || "Grounding judge reported an issue.",
      ...(issue.chunkId && allowedChunkIds.has(issue.chunkId) ? { chunkId: issue.chunkId } : {})
    }));
}

function sanitizeVerdict(
  verdict: GroundingJudgeVerdict,
  issues: readonly GroundingJudgeIssue[]
): GroundingJudgeVerdict {
  if (
    verdict === "grounded" ||
    verdict === "unsupported" ||
    verdict === "needs_review" ||
    verdict === "failed"
  ) {
    if (verdict === "grounded" && issues.length > 0) {
      return "needs_review";
    }

    return verdict;
  }

  return "failed";
}

function buildResult(input: {
  readonly request: GroundingJudgeRequest;
  readonly judgeId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly verdict: GroundingJudgeVerdict;
  readonly issues: readonly GroundingJudgeIssue[];
  readonly provider: string;
  readonly modelName: string;
  readonly modelTier: ModelTier;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly cost: GroundingJudgeResult["cost"];
  readonly warnings: readonly string[];
}): GroundingJudgeResult {
  return {
    verdict: input.verdict,
    issues: input.issues,
    provider: input.provider,
    modelName: input.modelName,
    modelTier: input.modelTier,
    completedAt: input.completedAt,
    latencyMs: input.latencyMs,
    cost: input.cost,
    warnings: input.warnings,
    trace: {
      judgeId: input.judgeId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      profileId: input.request.profile.id,
      namespaceId: input.request.profile.namespaceId,
      contextId: input.request.context.trace.contextId,
      verdict: input.verdict,
      issueCount: input.issues.length,
      citedChunkIds: input.request.draft.citationChunkIds,
      provider: input.provider,
      modelName: input.modelName,
      modelTier: input.modelTier,
      latencyMs: input.latencyMs,
      warningCodes: uniqueSorted(input.warnings)
    }
  };
}

function isKnownIssueCode(code: string): code is GroundingJudgeIssueCode {
  return (
    code === "unsupported_claim" ||
    code === "missing_citation_support" ||
    code === "contradicted_by_context" ||
    code === "unsafe_context_instruction_followed" ||
    code === "judge_failed"
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
