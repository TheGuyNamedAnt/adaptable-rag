import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FIXED_NOW } from "../test-support/fixtures.js";
import {
  checkGraphRecall,
  type ExpectedGraphEntity,
  type ExpectedGraphRelation,
  type ForbiddenGraphRelation,
  type GraphRecallThresholds
} from "./graph-recall.js";
import type {
  GraphEntityKind,
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

interface AdversarialGraphFixture {
  readonly id: string;
  readonly expectedEntities: readonly ExpectedGraphEntity[];
  readonly expectedRelations: readonly ExpectedGraphRelation[];
  readonly forbiddenRelations: readonly ForbiddenGraphRelation[];
  readonly thresholds: GraphRecallThresholds;
}

test("graph recall passes the adversarial ownership fixture", async () => {
  const fixture = await loadFixture();
  const batch = makeBatch(fixture);

  const result = checkGraphRecall({
    batch,
    expectedEntities: fixture.expectedEntities,
    expectedRelations: fixture.expectedRelations,
    forbiddenRelations: fixture.forbiddenRelations,
    thresholds: fixture.thresholds
  });

  assert.equal(result.passed, true);
  assert.equal(result.entityRecall, 1);
  assert.equal(result.relationRecall, 1);
  assert.deepEqual(result.missingRelations, []);
  assert.deepEqual(result.forbiddenRelations, []);
});

test("graph recall fails when an expected nested relationship is missing", async () => {
  const fixture = await loadFixture();
  const batch = {
    ...makeBatch(fixture),
    relations: makeBatch(fixture).relations.filter(
      (relation) => relation.id !== "relation_northwind_holdings_owns_northwind_operating"
    )
  };

  const result = checkGraphRecall({
    batch,
    expectedEntities: fixture.expectedEntities,
    expectedRelations: fixture.expectedRelations,
    forbiddenRelations: fixture.forbiddenRelations,
    thresholds: fixture.thresholds
  });

  assert.equal(result.passed, false);
  assert.equal(result.missingRelations.length, 1);
  assert.equal(
    result.missingRelations[0]?.id,
    "relation_northwind_holdings_owns_northwind_operating"
  );
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["relation_recall_below_threshold"]
  );
});

test("graph recall catches forbidden conflated relationships", async () => {
  const fixture = await loadFixture();
  const batch = makeBatch(fixture);
  const badRelation = makeRelation({
    id: "relation_apple_inc_registered_maryland_bad",
    relationKind: "registered_in",
    sourceEntityId: "entity_apple_inc",
    targetEntityId: "location_maryland"
  });

  const result = checkGraphRecall({
    batch: {
      ...batch,
      relations: [...batch.relations, badRelation]
    },
    expectedEntities: fixture.expectedEntities,
    expectedRelations: fixture.expectedRelations,
    forbiddenRelations: fixture.forbiddenRelations,
    thresholds: {
      ...fixture.thresholds,
      maximumExtraRelations: 1
    }
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.forbiddenRelations.map((relation) => relation.id),
    ["relation_apple_inc_registered_maryland_bad"]
  );
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["forbidden_relations_present"]
  );
});

test("graph recall matches expected relationships by endpoint names when ids drift", async () => {
  const fixture = await loadFixture();
  const batch = makeBatch({
    ...fixture,
    expectedEntities: fixture.expectedEntities.map((entity) => ({
      ...entity,
      id: `actual_${entity.id ?? entity.name.replaceAll(" ", "_").toLowerCase()}`
    })),
    expectedRelations: fixture.expectedRelations.map((relation) => ({
      ...relation,
      id: `actual_${relation.id}`,
      sourceEntityId: `actual_${relation.sourceEntityId}`,
      targetEntityId: `actual_${relation.targetEntityId}`
    }))
  });

  const result = checkGraphRecall({
    batch,
    expectedEntities: fixture.expectedEntities,
    expectedRelations: fixture.expectedRelations,
    thresholds: {
      minimumEntityRecall: 1,
      minimumRelationRecall: 1,
      maximumExtraEntities: 0,
      maximumExtraRelations: 0
    }
  });

  assert.equal(result.passed, true);
  assert.equal(result.relationRecall, 1);
});

async function loadFixture(): Promise<AdversarialGraphFixture> {
  const fixtureUrl = new URL(
    "../../fixtures/graph/adversarial-ownership-recall.json",
    import.meta.url
  );
  const parsed = JSON.parse(await readFile(fixtureUrl, "utf8")) as AdversarialGraphFixture;
  return parsed;
}

function makeBatch(fixture: {
  readonly id: string;
  readonly expectedEntities: readonly ExpectedGraphEntity[];
  readonly expectedRelations: readonly ExpectedGraphRelation[];
}): GraphExtractionBatch {
  return {
    id: `batch_${fixture.id}`,
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: fixture.expectedEntities.map(makeEntity),
    relations: fixture.expectedRelations.map(makeRelation),
    createdAt: FIXED_NOW
  };
}

function makeEntity(expected: ExpectedGraphEntity): GraphEntityProposal {
  const id = expected.id ?? `entity_${expected.name.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`;
  return {
    id,
    namespaceId: "test-namespace",
    kind: expected.kind ?? ("legal_entity" satisfies GraphEntityKind),
    name: expected.name,
    normalizedName: expected.normalizedName ?? expected.name.toLowerCase(),
    ...(expected.aliases === undefined ? {} : { aliases: expected.aliases }),
    confidence: 0.95,
    trustTier: "trusted_internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [],
    status: "approved",
    createdAt: FIXED_NOW
  };
}

function makeRelation(expected: ExpectedGraphRelation): GraphRelationProposal {
  return {
    id:
      expected.id ??
      `relation_${expected.relationKind}_${expected.sourceEntityId}_${expected.targetEntityId}`,
    namespaceId: "test-namespace",
    relationKind: expected.relationKind ?? ("owns" satisfies GraphRelationKind),
    sourceEntityId: expected.sourceEntityId ?? "entity_source",
    targetEntityId: expected.targetEntityId ?? "entity_target",
    factStrength: "explicit_fact",
    confidence: 0.95,
    trustTier: "trusted_internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported",
    status: "approved",
    createdAt: FIXED_NOW
  };
}
