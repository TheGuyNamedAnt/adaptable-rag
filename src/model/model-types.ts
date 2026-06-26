import type { AnswerGenerationInput, SourcedAnswerDraft } from "../answer/answer-types.js";
import type { ModelTier } from "../profiles/profile.js";

export type ModelCallStatus = "succeeded" | "failed";

export interface ModelTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelCostEstimate {
  readonly amountUsd: number;
  readonly currency: "USD";
}

export interface ModelGenerateRequest {
  readonly requestId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly modelTier: ModelTier;
  readonly input: AnswerGenerationInput;
  readonly requestedAt?: string;
}

export interface ModelGenerateResult {
  readonly status: ModelCallStatus;
  readonly draft?: SourcedAnswerDraft;
  readonly provider: string;
  readonly modelName: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly usage: ModelTokenUsage;
  readonly cost: ModelCostEstimate;
  readonly warnings: readonly string[];
  readonly errorMessage?: string;
}

export interface ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  generate(request: ModelGenerateRequest): Promise<ModelGenerateResult>;
}
