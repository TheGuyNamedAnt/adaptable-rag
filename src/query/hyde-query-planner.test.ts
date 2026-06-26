import assert from "node:assert/strict";
import test from "node:test";

import { genericDocsProfile } from "../profiles/examples/generic-docs.profile.js";
import { assertValidProfile } from "../profiles/profile-validation.js";
import { FIXED_NOW } from "../test-support/fixtures.js";
import {
  HydeQueryPlanner,
  type HydeGenerationRequest,
  type HydeGenerationResult,
  type HydeGenerator
} from "./hyde-query-planner.js";

const parallelProfile = assertValidProfile({
  ...genericDocsProfile,
  retrieval: {
    ...genericDocsProfile.retrieval,
    allowQueryRewrite: true,
    allowParallelQueries: true
  }
});

test("adds a hypothetical document planned query when rewrite and parallel policy allow it", async () => {
  const generator = new StaticHydeGenerator(
    "Acme Corp acquisition risk includes customer concentration and revenue exposure."
  );
  const planner = new HydeQueryPlanner({
    generator,
    now: () => FIXED_NOW
  });

  const plan = await planner.plan({
    profile: parallelProfile,
    question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
    queryPlanId: "query_plan_hyde",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(generator.requests.length, 1);
  assert.equal(generator.requests[0]?.requestId, "hyde_query_plan_hyde");
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original", "low_level", "hyde"]
  );
  assert.equal(plan.queries.at(-1)?.query.includes("customer concentration"), true);
  assert.equal(plan.trace.strategy, "hyde_augmented");
  assert.equal(plan.trace.queryCount, 3);
  assert.equal(plan.trace.plannedQueryHashes.length, 3);
  assert.equal(JSON.stringify(plan.trace).includes("Acme Corp"), false);
  assert.equal(JSON.stringify(plan.trace).includes("customer concentration"), false);
});

test("does not call the HyDE generator when rewrite or parallel policy forbids expansion", async () => {
  const generator = new StaticHydeGenerator("Hypothetical support policy.");
  const planner = new HydeQueryPlanner({
    generator,
    now: () => FIXED_NOW
  });
  const profile = assertValidProfile({
    ...genericDocsProfile,
    retrieval: {
      ...genericDocsProfile.retrieval,
      allowQueryRewrite: true,
      allowParallelQueries: false
    }
  });

  const plan = await planner.plan({
    profile,
    question: "What does Acme Corp say about refund policy?",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(generator.requests.length, 0);
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original"]
  );
  assert.equal(plan.trace.strategy, "default_heuristic");
});

test("falls back to the base query plan when HyDE generation fails by default", async () => {
  const generator = new StaticHydeGenerator("unused", "hyde provider unavailable");
  const planner = new HydeQueryPlanner({
    generator,
    now: () => FIXED_NOW
  });

  const plan = await planner.plan({
    profile: parallelProfile,
    question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
    requestedAt: FIXED_NOW,
    maxQueries: 3
  });

  assert.equal(generator.requests.length, 1);
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    ["original", "low_level", "high_level"]
  );
  assert.equal(plan.trace.strategy, "default_heuristic");
});

test("can fail closed when HyDE generation is required by the caller", async () => {
  const generator = new StaticHydeGenerator("unused", "hyde provider unavailable");
  const planner = new HydeQueryPlanner({
    generator,
    failOpen: false,
    now: () => FIXED_NOW
  });

  await assert.rejects(
    () =>
      planner.plan({
        profile: parallelProfile,
        question: "How does Acme Corp 2024 acquisition affect customer concentration risk?",
        requestedAt: FIXED_NOW,
        maxQueries: 3
      }),
    /hyde provider unavailable/
  );
});

class StaticHydeGenerator implements HydeGenerator {
  readonly id = "static-hyde-generator";
  readonly provider = "fixture";
  readonly modelName = "fixture-hyde-model";
  readonly requests: HydeGenerationRequest[] = [];

  constructor(
    private readonly document: string,
    private readonly failureMessage?: string
  ) {}

  async generate(request: HydeGenerationRequest): Promise<HydeGenerationResult> {
    this.requests.push(request);
    if (this.failureMessage) {
      throw new Error(this.failureMessage);
    }

    return {
      document: this.document
    };
  }
}
