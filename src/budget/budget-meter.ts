import type { CostLatencyBudget } from "../profiles/profile.js";

export type BudgetIssueCode =
  | "retrieval_call_budget_exceeded"
  | "model_call_budget_exceeded"
  | "model_latency_budget_exceeded"
  | "model_cost_budget_exceeded"
  | "draft_output_budget_exceeded";

export interface BudgetIssue {
  readonly code: BudgetIssueCode;
  readonly message: string;
  readonly path: string;
  readonly actual: number;
  readonly limit: number;
  readonly source?: string;
}

export interface BudgetedModelResult {
  readonly provider: string;
  readonly modelName: string;
  readonly latencyMs: number;
  readonly cost: {
    readonly amountUsd: number;
  };
}

export class BudgetMeter {
  private readonly budget: CostLatencyBudget;
  private retrievalCalls = 0;
  private modelCalls = 0;
  private estimatedCostUsd = 0;

  constructor(budget: CostLatencyBudget) {
    this.budget = budget;
  }

  recordRetrievalCall(): readonly BudgetIssue[] {
    this.retrievalCalls += 1;

    if (this.retrievalCalls <= this.budget.maxRetrievalCalls) {
      return [];
    }

    return [
      issue({
        code: "retrieval_call_budget_exceeded",
        message: "Retrieval call count exceeded the profile retrieval-call budget.",
        path: "costLatencyBudget.maxRetrievalCalls",
        actual: this.retrievalCalls,
        limit: this.budget.maxRetrievalCalls
      })
    ];
  }

  recordModelCall(model: BudgetedModelResult): readonly BudgetIssue[] {
    this.modelCalls += 1;
    this.estimatedCostUsd += model.cost.amountUsd;

    const issues: BudgetIssue[] = [];
    const source = `${model.provider}:${model.modelName}`;

    if (this.modelCalls > this.budget.maxModelCalls) {
      issues.push(
        issue({
          code: "model_call_budget_exceeded",
          message: "Model call count exceeded the profile model-call budget.",
          path: "costLatencyBudget.maxModelCalls",
          actual: this.modelCalls,
          limit: this.budget.maxModelCalls,
          source
        })
      );
    }

    if (model.latencyMs > this.budget.maxRuntimeMs) {
      issues.push(
        issue({
          code: "model_latency_budget_exceeded",
          message: "Model latency exceeded the profile runtime budget.",
          path: "costLatencyBudget.maxRuntimeMs",
          actual: model.latencyMs,
          limit: this.budget.maxRuntimeMs,
          source
        })
      );
    }

    if (this.estimatedCostUsd > this.budget.maxEstimatedCostUsd) {
      issues.push(
        issue({
          code: "model_cost_budget_exceeded",
          message: "Model estimated cost exceeded the profile cost budget.",
          path: "costLatencyBudget.maxEstimatedCostUsd",
          actual: this.estimatedCostUsd,
          limit: this.budget.maxEstimatedCostUsd,
          source
        })
      );
    }

    return issues;
  }

  checkDraftOutput(estimatedTokens: number, maxOutputTokens: number): readonly BudgetIssue[] {
    if (estimatedTokens <= maxOutputTokens) {
      return [];
    }

    return [
      issue({
        code: "draft_output_budget_exceeded",
        message: "Draft output exceeded the generation output token budget.",
        path: "draft",
        actual: estimatedTokens,
        limit: maxOutputTokens
      })
    ];
  }
}

function issue(input: BudgetIssue): BudgetIssue {
  return input;
}
