import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import type { GraphQueryRoute, PlannedQuery, QueryPlan } from "../query/query-types.js";
import { hashText } from "../shared/hash.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import { DefaultRetrievalBudgetPolicy } from "./retrieval-budget-policy.js";

const parallelProfile = assertValidProfile({
  ...genericDocsProfile,
  namespaceId: "test-namespace",
  retrieval: {
    ...genericDocsProfile.retrieval,
    allowQueryRewrite: true,
    allowParallelQueries: true
  },
  costLatencyBudget: {
    ...genericDocsProfile.costLatencyBudget,
    maxRetrievalCalls: 4
  }
});

test("default retrieval budget gives graph-required branches larger graph fanout and controlled candidate pools", () => {
  const policy = new DefaultRetrievalBudgetPolicy();
  const budget = policy.plan({
    profile: parallelProfile,
    queryPlan: makeQueryPlan({
      route: "graph_required",
      queries: [
        {
          id: "q_original",
          query: "Who owns Child LLC?",
          kind: "original",
          weight: 1
        },
        {
          id: "q_graph",
          query: "Child LLC owns",
          kind: "graph",
          weight: 0.95
        },
        {
          id: "q_hyde",
          query: "The answer likely identifies the parent entity.",
          kind: "hyde",
          weight: 0.8
        }
      ]
    }),
    requestedTopK: 8,
    retrieverSupportsGraphSearch: true
  });

  const original = budget.branches[0];
  const graph = budget.branches[1];
  const hyde = budget.branches[2];

  assert.equal(budget.strategy, "default_retrieval_budget");
  assert.equal(budget.enabledQueryCount, 3);
  assert.equal(original?.candidatePoolLimit, 32);
  assert.deepEqual(original?.graph, {
    enabled: true,
    entityLimit: 8,
    neighborLimit: 24,
    maxDepth: 2,
    maxVisitedEntities: 256,
    entityHints: ["Child LLC"],
    relationKinds: ["owns"],
    direction: "incoming",
    executionMode: "expand"
  });
  assert.equal(graph?.topK, 10);
  assert.equal(graph?.candidatePoolLimit, 40);
  assert.equal(graph?.fusionWeight, 1.05);
  assert.deepEqual(graph?.graph, {
    enabled: true,
    entityLimit: 8,
    neighborLimit: 24,
    maxDepth: 2,
    maxVisitedEntities: 256,
    entityHints: ["Child LLC"],
    relationKinds: ["owns"],
    direction: "incoming",
    executionMode: "graph_first"
  });
  assert.equal(hyde?.topK, 6);
  assert.equal(hyde?.candidatePoolLimit, 24);
  assert.equal(hyde?.graph?.enabled, false);
});

test("default retrieval budget disables graph expansion when the query plan has no graph intent", () => {
  const policy = new DefaultRetrievalBudgetPolicy();
  const budget = policy.plan({
    profile: parallelProfile,
    queryPlan: makeQueryPlan({
      route: "none",
      queries: [
        {
          id: "q_original",
          query: "Summarize the refund policy.",
          kind: "original",
          weight: 1
        },
        {
          id: "q_hyde",
          query: "A likely answer summarizes refund requirements.",
          kind: "hyde",
          weight: 0.8
        }
      ]
    }),
    requestedTopK: 8,
    retrieverSupportsGraphSearch: true
  });

  assert.deepEqual(
    budget.branches.map((branch) => branch.graph),
    [{ enabled: false }, { enabled: false }]
  );
});

test("default retrieval budget rejects plans that exceed the profile retrieval-call budget", () => {
  const policy = new DefaultRetrievalBudgetPolicy();
  const budgetedProfile = assertValidProfile({
    ...parallelProfile,
    costLatencyBudget: {
      ...parallelProfile.costLatencyBudget,
      maxRetrievalCalls: 1
    }
  });

  assert.throws(
    () =>
      policy.plan({
        profile: budgetedProfile,
        queryPlan: makeQueryPlan({
          route: "none",
          queries: [
            {
              id: "q_original",
              query: "What does the policy require?",
              kind: "original",
              weight: 1
            },
            {
              id: "q_high_level",
              query: "policy requirement",
              kind: "high_level",
              weight: 0.75
            }
          ]
        }),
        requestedTopK: 8,
        retrieverSupportsGraphSearch: false
      }),
    /exceeding profile maxRetrievalCalls=1/
  );
});

function makeQueryPlan(input: {
  readonly route: GraphQueryRoute;
  readonly queries: readonly PlannedQuery[];
}): QueryPlan {
  return {
    originalQuestion: input.queries[0]?.query ?? "What does the policy require?",
    lowLevelKeywords: [],
    highLevelKeywords: [],
    graphIntent: {
      route: input.route,
      relationKinds: input.route === "none" ? [] : ["owns"],
      entityHints: input.route === "none" ? [] : ["Child LLC"],
      direction: input.route === "none" ? "any" : "incoming",
      executionMode: input.route === "graph_required" ? "graph_first" : "expand",
      reason: "test graph intent"
    },
    queries: input.queries,
    trace: {
      queryPlanId: "query_plan_budget_test",
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      strategy: "default_heuristic",
      originalQuestionHash: hashText(input.queries[0]?.query ?? "question"),
      plannedQueryHashes: input.queries.map((query) => hashText(query.query)),
      lowLevelKeywordHashes: [],
      highLevelKeywordHashes: [],
      graphRoute: input.route,
      graphDirection: input.route === "none" ? "any" : "incoming",
      graphExecutionMode: input.route === "graph_required" ? "graph_first" : "expand",
      graphRelationKindHashes: [],
      graphEntityHintHashes: [],
      queryCount: input.queries.length,
      rewriteEnabled: true,
      parallelQueriesEnabled: true
    }
  };
}
