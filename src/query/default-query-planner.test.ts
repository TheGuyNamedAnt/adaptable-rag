import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import { DefaultQueryPlanner } from "./default-query-planner.js";

test("plans original, low-level, and high-level queries when profile allows parallel rewriting", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
    queryPlanId: "query_plan_test",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original", "low_level", "high_level"]
  );
  assert.equal(plan.lowLevelKeywords.includes("Acme Corp"), true);
  assert.equal(plan.highLevelKeywords.includes("acquisition"), true);
  assert.equal(plan.highLevelKeywords.includes("risk"), true);
  assert.equal(plan.trace.queryPlanId, "query_plan_test");
  assert.equal(plan.trace.queryCount, 3);
  assert.equal(plan.intent.primary, "general");
  assert.equal(plan.trace.primaryIntent, "general");
  assert.equal(plan.trace.plannedQueryHashes.length, 3);
  assert.equal(JSON.stringify(plan.trace).includes("Acme Corp"), false);
  assert.equal(JSON.stringify(plan.trace).includes("customer concentration"), false);
});

test("marks ownership questions as graph-required and adds a graph planned query", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "Who owns Child LLC in the Parent LLC ownership structure?",
    queryPlanId: "query_plan_graph",
    requestedAt: FIXED_NOW,
    maxQueries: 4
  });

  assert.equal(plan.graphIntent.route, "graph_required");
  assert.equal(plan.intent.primary, "relationship");
  assert.equal(plan.intent.sourceHints.includes("graph"), true);
  assert.equal(plan.trace.primaryIntent, "relationship");
  assert.equal(plan.trace.sourceHintHashes.length > 0, true);
  assert.equal(plan.graphIntent.direction, "incoming");
  assert.equal(plan.graphIntent.executionMode, "graph_first");
  assert.equal(plan.graphIntent.relationKinds.includes("owns"), true);
  assert.equal(plan.graphIntent.entityHints.includes("Child LLC"), true);
  assert.equal(plan.graphIntent.entityHints.includes("Parent LLC"), true);
  assert.equal(
    plan.queries.some((query) => query.kind === "graph"),
    true
  );
  assert.equal(plan.trace.graphRoute, "graph_required");
  assert.equal(plan.trace.graphDirection, "incoming");
  assert.equal(plan.trace.graphExecutionMode, "graph_first");
  assert.equal(plan.trace.graphRelationKindHashes.length > 0, true);
  assert.equal(JSON.stringify(plan.trace).includes("Child LLC"), false);
});

test("classifies troubleshooting questions and suggests support source hints", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "Why can't customers reset passwords after the latest login update?",
    queryPlanId: "query_plan_troubleshooting",
    requestedAt: FIXED_NOW
  });

  assert.equal(plan.intent.primary, "freshness");
  assert.equal(plan.intent.secondary.includes("troubleshooting"), true);
  assert.equal(plan.intent.sourceHints.includes("support"), true);
  assert.equal(plan.intent.sourceHints.includes("tickets"), true);
  assert.equal(plan.intent.sourceHints.includes("recent"), true);
  assert.equal(plan.trace.primaryIntent, "freshness");
  assert.equal(JSON.stringify(plan.trace).includes("passwords"), false);
});

test("classifies table and visual questions for future source-aware routing", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "Compare the chart and spreadsheet table for Q4 revenue.",
    queryPlanId: "query_plan_visual_table",
    requestedAt: FIXED_NOW
  });

  assert.equal(plan.intent.primary, "comparison");
  assert.equal(plan.intent.secondary.includes("table"), true);
  assert.equal(plan.intent.secondary.includes("visual"), true);
  assert.equal(plan.intent.sourceHints.includes("tables"), true);
  assert.equal(plan.intent.sourceHints.includes("visuals"), true);
  assert.equal(plan.trace.secondaryIntentHashes.length >= 2, true);
  assert.equal(JSON.stringify(plan.trace).includes("Q4 revenue"), false);
});

test("marks subsidiary ownership questions as outgoing graph traversal", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "Which subsidiaries of Parent LLC are listed?",
    queryPlanId: "query_plan_graph_outgoing",
    requestedAt: FIXED_NOW,
    maxQueries: 4
  });

  assert.equal(plan.graphIntent.route, "graph_required");
  assert.equal(plan.graphIntent.direction, "outgoing");
  assert.equal(plan.graphIntent.relationKinds.includes("owns"), true);
  assert.equal(plan.trace.graphDirection, "outgoing");
});

test("marks relationship-term questions as graph-optional without forcing graph for ordinary text questions", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: true
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const optional = planner.plan({
    profile,
    question: "Summarize the management responsibilities for Acme Corp.",
    requestedAt: FIXED_NOW,
    maxQueries: 4
  });
  const ordinary = planner.plan({
    profile,
    question: "What does section 4 say about refund timing?",
    requestedAt: FIXED_NOW,
    maxQueries: 4
  });

  assert.equal(optional.graphIntent.route, "graph_optional");
  assert.equal(optional.graphIntent.relationKinds.includes("manages"), true);
  assert.equal(ordinary.graphIntent.route, "none");
  assert.equal(
    ordinary.queries.some((query) => query.kind === "graph"),
    false
  );
});

test("keeps a single original query when parallel query planning is disabled", () => {
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: false
    }
  });
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  const plan = planner.plan({
    profile,
    question: "What does Acme Corp say about refund policy?",
    requestedAt: FIXED_NOW
  });

  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original"]
  );
  assert.equal(plan.trace.parallelQueriesEnabled, false);
});

test("rejects empty planning questions before retrieval", () => {
  const planner = new DefaultQueryPlanner({ now: () => FIXED_NOW });

  assert.throws(
    () =>
      planner.plan({
        profile: assertValidProfile(genericDocsProfile),
        question: "   ",
        requestedAt: FIXED_NOW
      }),
    /question is required/
  );
});
