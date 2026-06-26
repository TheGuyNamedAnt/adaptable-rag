import assert from "node:assert/strict";
import test from "node:test";

import { BudgetMeter } from "./budget-meter.js";

const budget = {
  maxRetrievalCalls: 1,
  maxModelCalls: 1,
  maxRuntimeMs: 1000,
  maxEstimatedCostUsd: 0.1
};

test("tracks retrieval call budgets", () => {
  const meter = new BudgetMeter(budget);

  assert.deepEqual(meter.recordRetrievalCall(), []);
  assert.equal(meter.recordRetrievalCall()[0]?.code, "retrieval_call_budget_exceeded");
});

test("tracks model call, latency, and cumulative cost budgets", () => {
  const meter = new BudgetMeter(budget);

  const first = meter.recordModelCall({
    provider: "test",
    modelName: "fast",
    latencyMs: 1200,
    cost: { amountUsd: 0.06 }
  });
  const second = meter.recordModelCall({
    provider: "test",
    modelName: "fast",
    latencyMs: 100,
    cost: { amountUsd: 0.06 }
  });

  assert.equal(
    first.some((issue) => issue.code === "model_latency_budget_exceeded"),
    true
  );
  assert.equal(
    second.some((issue) => issue.code === "model_call_budget_exceeded"),
    true
  );
  assert.equal(
    second.some((issue) => issue.code === "model_cost_budget_exceeded"),
    true
  );
});

test("checks draft output token budgets", () => {
  const meter = new BudgetMeter(budget);

  assert.deepEqual(meter.checkDraftOutput(10, 10), []);
  assert.equal(meter.checkDraftOutput(11, 10)[0]?.code, "draft_output_budget_exceeded");
});
