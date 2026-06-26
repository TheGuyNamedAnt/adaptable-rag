import type { SourcedAnswerDraft } from "../answer/answer-types.js";
import type {
  ModelAdapter,
  ModelCostEstimate,
  ModelGenerateRequest,
  ModelGenerateResult,
  ModelTokenUsage
} from "./model-types.js";

export interface FakeModelAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly modelName?: string;
  readonly draft?: SourcedAnswerDraft | ((request: ModelGenerateRequest) => SourcedAnswerDraft);
  readonly failWith?: string;
  readonly latencyMs?: number;
  readonly estimatedCostUsd?: number;
  readonly warnings?: readonly string[];
  readonly now?: () => string;
}

export class FakeModelAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;

  private readonly draft:
    | SourcedAnswerDraft
    | ((request: ModelGenerateRequest) => SourcedAnswerDraft)
    | undefined;
  private readonly failWith: string | undefined;
  private readonly latencyMs: number;
  private readonly estimatedCostUsd: number;
  private readonly warnings: readonly string[];
  private readonly now: () => string;

  constructor(options: FakeModelAdapterOptions = {}) {
    this.id = options.id ?? "fake-model-adapter";
    this.provider = options.provider ?? "fake";
    this.modelName = options.modelName ?? "fake-sourced-answer";
    this.draft = options.draft;
    this.failWith = options.failWith;
    this.latencyMs = options.latencyMs ?? 0;
    this.estimatedCostUsd = options.estimatedCostUsd ?? 0;
    this.warnings = options.warnings ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    const usage = estimateUsage(request);
    const cost: ModelCostEstimate = {
      amountUsd: this.estimatedCostUsd,
      currency: "USD"
    };

    if (this.failWith) {
      return {
        status: "failed",
        provider: this.provider,
        modelName: this.modelName,
        completedAt: this.now(),
        latencyMs: this.latencyMs,
        usage,
        cost,
        warnings: this.warnings,
        errorMessage: this.failWith
      };
    }

    return {
      status: "succeeded",
      draft: this.resolveDraft(request),
      provider: this.provider,
      modelName: this.modelName,
      completedAt: this.now(),
      latencyMs: this.latencyMs,
      usage,
      cost,
      warnings: this.warnings
    };
  }

  private resolveDraft(request: ModelGenerateRequest): SourcedAnswerDraft {
    if (typeof this.draft === "function") {
      return this.draft(request);
    }

    if (this.draft) {
      return this.draft;
    }

    const citationChunkIds = request.input.contract.allowedCitationChunkIds.slice(
      0,
      Math.max(1, request.input.contract.minimumCitations)
    );

    return {
      answer: "Generated answer from approved context.",
      citationChunkIds,
      ...(request.input.contract.requireEvidenceSummary
        ? { evidenceSummary: "The answer is based on the approved context blocks." }
        : {}),
      confidence: "medium"
    };
  }
}

function estimateUsage(request: ModelGenerateRequest): ModelTokenUsage {
  const promptTokens = estimateTokens(
    `${request.input.question}\n${request.input.contextText}\n${request.input.groundingRules.join("\n")}`
  );
  const completionTokens = Math.max(1, Math.ceil(request.input.contract.maxOutputTokens * 0.05));

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
