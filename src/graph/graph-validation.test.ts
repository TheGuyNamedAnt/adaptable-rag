import assert from "node:assert/strict";
import test from "node:test";

import { FIXED_NOW, makeIndexFilter } from "../test-support/fixtures.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphOntology,
  GraphRelationProposal
} from "./graph-types.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import {
  assertValidGraphExtractionBatch,
  validateGraphExtractionBatch
} from "./graph-validation.js";

const ontology: GraphOntology = {
  id: "ownership-ontology",
  entityKinds: ["legal_entity", "person"],
  relationKinds: ["owns", "controls"],
  requiredEvidenceForRelations: true,
  allowInferredRelations: false
};

test("validates evidence-linked typed entity and ownership relation proposals", () => {
  const batch = makeBatch();
  const result = validateGraphExtractionBatch(batch);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validates owner-defined ontology kinds for non-legal domains", () => {
  const customOntology: GraphOntology = {
    id: "product-support-ontology",
    entityKinds: ["ticket", "feature", "customer"],
    relationKinds: ["reported_by", "blocked_by", "renews_on"],
    requiredEvidenceForRelations: true,
    allowInferredRelations: false
  };
  const batch = makeBatch({
    ontology: customOntology,
    entities: [
      makeEntity("ticket_123", {
        kind: "ticket",
        name: "Ticket 123",
        normalizedName: "ticket 123"
      }),
      makeEntity("feature_billing_sync", {
        kind: "feature",
        name: "Billing Sync",
        normalizedName: "billing sync"
      })
    ],
    relations: [
      makeRelation("rel_ticket_blocked_by_feature", {
        relationKind: "blocked_by",
        sourceEntityId: "ticket_123",
        targetEntityId: "feature_billing_sync"
      })
    ]
  });
  const result = validateGraphExtractionBatch(batch);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("rejects unsupported kinds, unknown relation endpoints, missing evidence, and inferred facts", () => {
  const batch = makeBatch({
    entities: [
      makeEntity("entity_parent"),
      makeEntity("entity_child", {
        kind: "organization"
      })
    ],
    relations: [
      makeRelation("rel_owns", {
        relationKind: "partner_of",
        targetEntityId: "missing_entity",
        evidence: [],
        factStrength: "inferred_fact"
      })
    ]
  });
  const result = validateGraphExtractionBatch(batch);
  const codes = result.errors.map((issue) => issue.code);

  assert.equal(result.valid, false);
  assert.equal(codes.includes("unsupported_entity_kind"), true);
  assert.equal(codes.includes("unsupported_relation_kind"), true);
  assert.equal(codes.includes("unknown_relation_entity"), true);
  assert.equal(codes.includes("missing_evidence"), true);
  assert.equal(codes.includes("inferred_relation_disallowed"), true);
});

test("rejects namespace mismatches, invalid confidence, and invalid temporal values", () => {
  const batch = makeBatch({
    id: "",
    namespaceId: "",
    entities: [
      makeEntity("entity_parent", {
        namespaceId: "other-namespace",
        confidence: Number.NaN
      }),
      makeEntity("entity_child", {
        confidence: -0.1
      })
    ],
    relations: [
      makeRelation("rel_bad_temporal", {
        namespaceId: "other-namespace",
        confidence: 1.1,
        temporal: {
          observedAt: "not-a-date",
          validFrom: "2026-06-26T00:00:00.000Z",
          validTo: "2026-06-25T00:00:00.000Z"
        }
      })
    ]
  });
  const result = validateGraphExtractionBatch(batch);
  const codes = result.errors.map((issue) => issue.code);

  assert.equal(result.valid, false);
  assert.equal(codes.includes("missing_batch_field"), true);
  assert.equal(codes.includes("namespace_mismatch"), true);
  assert.equal(codes.includes("invalid_confidence"), true);
  assert.equal(codes.includes("invalid_temporal_validity"), true);
});

test("allows configured inferred and evidence-free superseded graph facts", () => {
  const permissiveOntology: GraphOntology = {
    ...ontology,
    requiredEvidenceForRelations: false,
    allowInferredRelations: true
  };
  const batch = makeBatch({
    ontology: permissiveOntology,
    entities: [
      makeEntity("entity_parent", {
        evidence: [],
        status: "superseded"
      }),
      makeEntity("entity_child")
    ],
    relations: [
      makeRelation("rel_inferred_without_evidence", {
        factStrength: "inferred_fact",
        evidence: []
      })
    ]
  });
  const result = validateGraphExtractionBatch(batch);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.doesNotThrow(() => assertValidGraphExtractionBatch(batch));
});

test("assertValidGraphExtractionBatch throws with validation details", () => {
  assert.throws(
    () =>
      assertValidGraphExtractionBatch(
        makeBatch({
          relations: [
            makeRelation("rel_invalid", {
              targetEntityId: "missing_entity"
            })
          ]
        })
      ),
    /relations\[0\]\.targetEntityId/u
  );
});

test("in-memory graph store only returns access-allowed approved relations by default", () => {
  const store = new InMemoryGraphStore();
  store.addExtractionBatch(
    makeBatch({
      relations: [
        makeRelation("rel_approved", { status: "approved" }),
        makeRelation("rel_proposed", { status: "proposed" })
      ]
    })
  );

  assert.deepEqual(
    store.findRelations({ filter: makeIndexFilter() }).map((relation) => relation.id),
    ["rel_approved"]
  );
  assert.deepEqual(
    store
      .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
      .map((relation) => relation.id),
    ["rel_approved", "rel_proposed"]
  );
  assert.deepEqual(
    store.findRelations({
      filter: makeIndexFilter({
        principal: {
          userId: "user_2",
          tenantId: "tenant_1",
          namespaceIds: ["test-namespace"],
          teamIds: [],
          roles: [],
          tags: ["external"]
        }
      })
    }),
    []
  );
});

test("in-memory graph store uses indexed entity, adjacency, and relation-kind lookups", () => {
  const store = new InMemoryGraphStore();
  store.addExtractionBatch(
    makeBatch({
      entities: [
        makeEntity("entity_parent", {
          name: "Parent Holdings LLC",
          normalizedName: "parent holdings",
          aliases: ["ParentCo"]
        }),
        makeEntity("entity_child", {
          name: "Child Operating LLC",
          normalizedName: "child operating"
        }),
        makeEntity("entity_manager", {
          name: "Manager LLC",
          normalizedName: "manager"
        })
      ],
      relations: [
        makeRelation("rel_owns", {
          sourceEntityId: "entity_parent",
          targetEntityId: "entity_child",
          relationKind: "owns",
          status: "approved"
        }),
        makeRelation("rel_controls", {
          sourceEntityId: "entity_manager",
          targetEntityId: "entity_child",
          relationKind: "controls",
          status: "approved"
        })
      ]
    })
  );

  assert.deepEqual(
    store
      .queryEntities({ filter: makeIndexFilter(), entityName: "Parent" })
      .map((entity) => entity.id),
    ["entity_parent"]
  );
  assert.deepEqual(
    store
      .findRelations({
        filter: makeIndexFilter(),
        entityId: "entity_child",
        relationKinds: ["owns"]
      })
      .map((relation) => relation.id),
    ["rel_owns"]
  );

  store.updateRelationEndpoints("rel_owns", { sourceEntityId: "entity_manager" });

  assert.deepEqual(
    store
      .findRelations({
        filter: makeIndexFilter(),
        entityId: "entity_parent",
        relationKinds: ["owns"]
      })
      .map((relation) => relation.id),
    []
  );
  assert.deepEqual(
    store
      .findRelations({
        filter: makeIndexFilter(),
        entityId: "entity_manager",
        relationKinds: ["owns"]
      })
      .map((relation) => relation.id),
    ["rel_owns"]
  );
});

test("in-memory graph store exposes stable cursor pages", () => {
  const store = new InMemoryGraphStore();
  store.addExtractionBatch(
    makeBatch({
      entities: [
        makeEntity("entity_1", { createdAt: "2026-06-23T00:00:00.001Z" }),
        makeEntity("entity_2", { createdAt: "2026-06-23T00:00:00.002Z" }),
        makeEntity("entity_3", { createdAt: "2026-06-23T00:00:00.003Z" })
      ],
      relations: [
        makeRelation("rel_1", {
          sourceEntityId: "entity_1",
          targetEntityId: "entity_2",
          createdAt: "2026-06-23T00:00:00.001Z",
          status: "approved"
        }),
        makeRelation("rel_2", {
          sourceEntityId: "entity_2",
          targetEntityId: "entity_3",
          createdAt: "2026-06-23T00:00:00.002Z",
          status: "approved"
        })
      ]
    })
  );

  const firstEntityPage = store.pageEntities({ filter: makeIndexFilter(), limit: 2 });
  assert.deepEqual(
    firstEntityPage.entities.map((entity) => entity.id),
    ["entity_1", "entity_2"]
  );
  assert.equal(typeof firstEntityPage.nextCursor, "string");
  const nextEntityCursor = firstEntityPage.nextCursor;
  assert.ok(nextEntityCursor);

  const secondEntityPage = store.pageEntities({
    filter: makeIndexFilter(),
    limit: 2,
    cursor: nextEntityCursor
  });
  assert.deepEqual(
    secondEntityPage.entities.map((entity) => entity.id),
    ["entity_3"]
  );
  assert.equal(secondEntityPage.nextCursor, undefined);

  const firstRelationPage = store.pageRelations({ filter: makeIndexFilter(), limit: 1 });
  assert.deepEqual(
    firstRelationPage.relations.map((relation) => relation.id),
    ["rel_1"]
  );
  assert.equal(typeof firstRelationPage.nextCursor, "string");
});

function makeBatch(
  overrides: Partial<Omit<GraphExtractionBatch, "ontology">> & { ontology?: GraphOntology } = {}
): GraphExtractionBatch {
  const entities = overrides.entities ?? [makeEntity("entity_parent"), makeEntity("entity_child")];
  return {
    id: overrides.id ?? "batch_1",
    namespaceId: overrides.namespaceId ?? "test-namespace",
    ontology: overrides.ontology ?? ontology,
    entities,
    relations: overrides.relations ?? [
      makeRelation("rel_owns", {
        sourceEntityId: entities[0]?.id ?? "entity_parent",
        targetEntityId: entities[1]?.id ?? "entity_child"
      })
    ],
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
}

function makeEntity(id: string, overrides: Partial<GraphEntityProposal> = {}): GraphEntityProposal {
  return {
    id,
    namespaceId: overrides.namespaceId ?? "test-namespace",
    kind: overrides.kind ?? "legal_entity",
    name: overrides.name ?? id.replace(/_/g, " "),
    normalizedName: overrides.normalizedName ?? id.replace(/^entity_/, ""),
    confidence: overrides.confidence ?? 0.91,
    trustTier: overrides.trustTier ?? "trusted_internal",
    accessScope: overrides.accessScope ?? {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: overrides.evidence ?? [evidenceAnchor()],
    status: overrides.status ?? "proposed",
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
}

function makeRelation(
  id: string,
  overrides: Partial<GraphRelationProposal> = {}
): GraphRelationProposal {
  return {
    id,
    namespaceId: overrides.namespaceId ?? "test-namespace",
    relationKind: overrides.relationKind ?? "owns",
    sourceEntityId: overrides.sourceEntityId ?? "entity_parent",
    targetEntityId: overrides.targetEntityId ?? "entity_child",
    factStrength: overrides.factStrength ?? "explicit_fact",
    confidence: overrides.confidence ?? 0.88,
    trustTier: overrides.trustTier ?? "trusted_internal",
    accessScope: overrides.accessScope ?? {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: overrides.evidence ?? [evidenceAnchor()],
    temporal: overrides.temporal ?? {
      observedAt: FIXED_NOW
    },
    verificationStatus: overrides.verificationStatus ?? "supported",
    status: overrides.status ?? "verified",
    createdAt: overrides.createdAt ?? FIXED_NOW
  };
}

function evidenceAnchor(): GraphEntityProposal["evidence"][number] {
  return {
    chunkId: "chunk_1",
    documentId: "doc_1",
    sourceId: "source_1",
    citation: {
      sourceId: "source_1",
      chunkId: "chunk_1",
      title: "Ownership schedule",
      locator: "page 1"
    },
    quoteHash: "hash_1"
  };
}
