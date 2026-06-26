import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import { ModelAssistedQueryPlanner } from "./model-assisted-query-planner.js";
import type { QueryPlanningModelAdapter } from "./query-types.js";

const profile = assertValidProfile({
  ...genericDocsProfile,
  retrieval: {
    ...genericDocsProfile.retrieval,
    allowQueryRewrite: true,
    allowParallelQueries: true
  }
});

test("uses sanitized model-assisted low-level and high-level planned queries", async () => {
  const adapter: QueryPlanningModelAdapter = {
    id: "fixture-query-planner",
    provider: "fixture",
    modelName: "fixture-query-model",
    async plan() {
      return {
        lowLevelKeywords: ["Acme Corp", "Acme Corp", "  "],
        highLevelKeywords: ["customer concentration", "revenue exposure"],
        plannedQueries: [
          {
            query: "Acme Corp 2024 acquisition",
            kind: "low_level",
            weight: 0.9
          },
          {
            query: "customer concentration revenue exposure",
            kind: "high_level",
            weight: 0.8
          }
        ]
      };
    }
  };
  const planner = new ModelAssistedQueryPlanner({ adapter, now: () => FIXED_NOW });

  const plan = await planner.plan({
    profile,
    question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
    queryPlanId: "query_plan_model",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(plan.trace.strategy, "model_assisted");
  assert.deepEqual(plan.lowLevelKeywords, ["Acme Corp"]);
  assert.deepEqual(plan.highLevelKeywords, ["customer concentration", "revenue exposure"]);
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original", "low_level", "high_level"]
  );
  assert.equal(JSON.stringify(plan.trace).includes("Acme Corp"), false);
});

test("model-assisted planner adds heuristic graph intent to model query plans", async () => {
  const adapter: QueryPlanningModelAdapter = {
    id: "fixture-query-planner",
    provider: "fixture",
    modelName: "fixture-query-model",
    async plan() {
      return {
        lowLevelKeywords: ["Child LLC", "Parent LLC"],
        highLevelKeywords: ["ownership"],
        plannedQueries: [
          {
            query: "Child LLC Parent LLC ownership",
            kind: "low_level",
            weight: 0.9
          }
        ]
      };
    }
  };
  const planner = new ModelAssistedQueryPlanner({ adapter, now: () => FIXED_NOW });

  const plan = await planner.plan({
    profile,
    question: "Who owns Child LLC in the Parent LLC ownership structure?",
    queryPlanId: "query_plan_model_graph",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(plan.trace.strategy, "model_assisted");
  assert.equal(plan.graphIntent.route, "graph_required");
  assert.equal(plan.graphIntent.relationKinds.includes("owns"), true);
  assert.equal(plan.trace.graphRoute, "graph_required");
  assert.equal(plan.trace.graphEntityHintHashes.length, 2);
});

test("falls back to the heuristic planner when the model planner fails", async () => {
  const adapter: QueryPlanningModelAdapter = {
    id: "failing-query-planner",
    provider: "fixture",
    modelName: "fixture-query-model",
    async plan() {
      throw new Error("planner unavailable");
    }
  };
  const planner = new ModelAssistedQueryPlanner({ adapter, now: () => FIXED_NOW });

  const plan = await planner.plan({
    profile,
    question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(plan.trace.strategy, "default_heuristic");
  assert.equal(plan.queries.length, 3);
});
