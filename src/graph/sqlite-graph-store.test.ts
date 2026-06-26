import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FIXED_NOW, makeIndexFilter } from "../test-support/fixtures.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";

const sqliteSkipReason = nodeSqliteSkipReason();

test(
  "SQLite graph store persists indexed entity and relation lookups",
  { skip: sqliteSkipReason ?? false },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), "adaptable-rag-sqlite-graph-"));
    let store: SqliteGraphStore | undefined;
    let reloaded: SqliteGraphStore | undefined;

    try {
      const filePath = path.join(directory, "graph.sqlite");
      store = new SqliteGraphStore({ filePath });
      store.addExtractionBatch(makeBatch());

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
      assert.deepEqual(
        store.findRelations({ filter: makeIndexFilter() }).map((relation) => relation.id),
        ["rel_owns"]
      );
      assert.deepEqual(
        store
          .findRelations({ filter: makeIndexFilter(), includeUnapproved: true })
          .map((relation) => relation.id),
        ["rel_owns", "rel_controls"]
      );

      store.close();
      store = undefined;
      reloaded = new SqliteGraphStore({ filePath });

      assert.deepEqual(
        reloaded
          .queryEntities({ filter: makeIndexFilter(), entityName: "ParentCo" })
          .map((entity) => entity.id),
        ["entity_parent"]
      );
      assert.deepEqual(
        reloaded
          .findRelations({
            filter: makeIndexFilter(),
            entityId: "entity_child",
            relationKinds: ["controls"],
            includeUnapproved: true
          })
          .map((relation) => relation.id),
        ["rel_controls"]
      );
    } finally {
      store?.close();
      reloaded?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  "SQLite graph store keeps adjacency indexes correct after status and endpoint updates",
  { skip: sqliteSkipReason ?? false },
  () => {
    const store = new SqliteGraphStore({ filePath: ":memory:" });
    try {
      store.addExtractionBatch(makeBatch());
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

      store.updateRelationStatus("rel_owns", "proposed");

      assert.deepEqual(
        store
          .findRelations({
            filter: makeIndexFilter(),
            entityId: "entity_manager",
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
            relationKinds: ["owns"],
            includeUnapproved: true
          })
          .map((relation) => relation.id),
        ["rel_owns"]
      );
    } finally {
      store.close();
    }
  }
);

test(
  "SQLite graph store enforces graph fact access scopes",
  { skip: sqliteSkipReason ?? false },
  () => {
    const store = new SqliteGraphStore({ filePath: ":memory:" });
    try {
      store.addExtractionBatch(makeBatch());

      const deniedFilter = makeIndexFilter({
        principal: {
          userId: "user_2",
          tenantId: "tenant_1",
          namespaceIds: ["test-namespace"],
          teamIds: [],
          roles: [],
          tags: ["external"]
        }
      });

      assert.deepEqual(store.queryEntities({ filter: deniedFilter, entityName: "Parent" }), []);
      assert.deepEqual(
        store.findRelations({
          filter: deniedFilter,
          entityId: "entity_child",
          includeUnapproved: true
        }),
        []
      );
    } finally {
      store.close();
    }
  }
);

test(
  "SQLite graph store applies access predicates before limiting rows",
  { skip: sqliteSkipReason ?? false },
  () => {
    const store = new SqliteGraphStore({ filePath: ":memory:" });
    try {
      const batch = makeBatch();
      store.addExtractionBatch({
        ...batch,
        entities: [
          ...Array.from({ length: 30 }, (_, index) => makeDeniedEntity(index)),
          ...batch.entities
        ],
        relations: [
          ...Array.from({ length: 30 }, (_, index) => makeDeniedRelation(index)),
          ...batch.relations
        ]
      });

      assert.deepEqual(
        store.queryEntities({ filter: makeIndexFilter(), limit: 1 }).map((entity) => entity.id),
        ["entity_parent"]
      );
      assert.deepEqual(
        store
          .findRelations({
            filter: makeIndexFilter(),
            includeUnapproved: true,
            limit: 1
          })
          .map((relation) => relation.id),
        ["rel_owns"]
      );
    } finally {
      store.close();
    }
  }
);

test(
  "SQLite graph store prunes evidence for deleted documents through the evidence index",
  { skip: sqliteSkipReason ?? false },
  () => {
    const store = new SqliteGraphStore({ filePath: ":memory:" });
    try {
      store.addExtractionBatch(makeBatch());

      const result = store.pruneEvidence({
        filter: makeIndexFilter(),
        documentIds: ["doc_1"]
      });

      assert.equal(result.removedEvidenceAnchorCount, 5);
      assert.deepEqual(
        store
          .snapshot()
          .entities.map((entity) => [entity.id, entity.status, entity.evidence.length]),
        [
          ["entity_child", "superseded", 0],
          ["entity_manager", "superseded", 0],
          ["entity_parent", "superseded", 0]
        ]
      );
      assert.deepEqual(
        store
          .findRelations({ filter: makeIndexFilter(), entityId: "entity_child" })
          .map((relation) => relation.id),
        []
      );
      assert.deepEqual(
        store
          .findRelations({
            filter: makeIndexFilter(),
            entityId: "entity_child",
            includeUnapproved: true
          })
          .map((relation) => [relation.id, relation.status, relation.evidence.length]),
        [
          ["rel_controls", "superseded", 0],
          ["rel_owns", "superseded", 0]
        ]
      );
    } finally {
      store.close();
    }
  }
);

test(
  "SQLite graph store pages large graph neighborhoods with stable cursors",
  { skip: sqliteSkipReason ?? false },
  () => {
    const store = new SqliteGraphStore({ filePath: ":memory:" });
    try {
      const relationCount = 1000;
      store.addExtractionBatch(makeLargeBatch(relationCount));

      const entityIds: string[] = [];
      let entityCursor: string | undefined;
      do {
        const page = store.pageEntities({
          filter: makeIndexFilter(),
          limit: 175,
          ...(entityCursor === undefined ? {} : { cursor: entityCursor })
        });
        entityIds.push(...page.entities.map((entity) => entity.id));
        entityCursor = page.nextCursor;
      } while (entityCursor !== undefined);

      const relationIds: string[] = [];
      let relationCursor: string | undefined;
      do {
        const page = store.pageRelations({
          filter: makeIndexFilter(),
          entityId: "entity_parent",
          relationKinds: ["owns"],
          limit: 128,
          ...(relationCursor === undefined ? {} : { cursor: relationCursor })
        });
        relationIds.push(...page.relations.map((relation) => relation.id));
        relationCursor = page.nextCursor;
      } while (relationCursor !== undefined);

      assert.equal(entityIds.length, relationCount + 1);
      assert.equal(new Set(entityIds).size, relationCount + 1);
      assert.equal(entityIds[0], "entity_parent");
      assert.equal(entityIds.at(-1), "entity_child_0999");
      assert.equal(relationIds.length, relationCount);
      assert.equal(new Set(relationIds).size, relationCount);
      assert.equal(relationIds[0], "rel_parent_owns_child_0000");
      assert.equal(relationIds.at(-1), "rel_parent_owns_child_0999");
    } finally {
      store.close();
    }
  }
);

function makeBatch(): GraphExtractionBatch {
  const baseEntity = {
    namespaceId: "test-namespace",
    kind: "legal_entity" as const,
    confidence: 0.92,
    trustTier: "trusted_internal" as const,
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [evidenceAnchor()],
    status: "approved" as const,
    createdAt: FIXED_NOW
  };
  const baseRelation = {
    namespaceId: "test-namespace",
    targetEntityId: "entity_child",
    factStrength: "explicit_fact" as const,
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [evidenceAnchor()],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_sqlite_graph_store",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        ...baseEntity,
        id: "entity_parent",
        name: "Parent Holdings LLC",
        normalizedName: "parent holdings",
        aliases: ["ParentCo"]
      },
      {
        ...baseEntity,
        id: "entity_child",
        name: "Child Operating LLC",
        normalizedName: "child operating"
      },
      {
        ...baseEntity,
        id: "entity_manager",
        name: "Manager LLC",
        normalizedName: "manager"
      }
    ],
    relations: [
      {
        ...baseRelation,
        id: "rel_owns",
        relationKind: "owns",
        sourceEntityId: "entity_parent",
        targetEntityId: "entity_child",
        status: "approved"
      },
      {
        ...baseRelation,
        id: "rel_controls",
        relationKind: "controls",
        sourceEntityId: "entity_manager",
        targetEntityId: "entity_child",
        status: "proposed"
      }
    ],
    createdAt: FIXED_NOW
  };
}

function makeLargeBatch(relationCount: number): GraphExtractionBatch {
  const baseEntity = {
    namespaceId: "test-namespace",
    kind: "legal_entity" as const,
    confidence: 0.92,
    trustTier: "trusted_internal" as const,
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [evidenceAnchor()],
    status: "approved" as const
  };
  const baseRelation = {
    namespaceId: "test-namespace",
    sourceEntityId: "entity_parent",
    relationKind: "owns" as const,
    factStrength: "explicit_fact" as const,
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["support"]
    },
    evidence: [evidenceAnchor()],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported" as const,
    status: "approved" as const
  };
  const parent = {
    ...baseEntity,
    id: "entity_parent",
    name: "Parent Holdings LLC",
    normalizedName: "parent holdings",
    createdAt: timestampForIndex(0)
  };
  const children = Array.from({ length: relationCount }, (_, index) => ({
    ...baseEntity,
    id: `entity_child_${paddedIndex(index)}`,
    name: `Child ${paddedIndex(index)} LLC`,
    normalizedName: `child ${paddedIndex(index)}`,
    createdAt: timestampForIndex(index + 1)
  }));
  const relations = children.map((child, index) => ({
    ...baseRelation,
    id: `rel_parent_owns_child_${paddedIndex(index)}`,
    targetEntityId: child.id,
    createdAt: timestampForIndex(index + 1)
  }));

  return {
    id: "batch_sqlite_graph_store_large",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [parent, ...children],
    relations,
    createdAt: FIXED_NOW
  };
}

function makeDeniedEntity(index: number): GraphEntityProposal {
  return {
    id: `entity_denied_${index}`,
    namespaceId: "test-namespace",
    kind: "legal_entity",
    name: `Denied Entity ${index}`,
    normalizedName: `denied entity ${index}`,
    confidence: 0.92,
    trustTier: "trusted_internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["private"]
    },
    evidence: [evidenceAnchor()],
    status: "approved",
    createdAt: FIXED_NOW
  };
}

function makeDeniedRelation(index: number): GraphRelationProposal {
  return {
    id: `rel_denied_${index}`,
    namespaceId: "test-namespace",
    relationKind: "owns",
    sourceEntityId: "entity_parent",
    targetEntityId: "entity_child",
    factStrength: "explicit_fact",
    confidence: 0.9,
    trustTier: "trusted_internal",
    accessScope: {
      tenantId: "tenant_1",
      namespaceId: "test-namespace",
      tags: ["private"]
    },
    evidence: [evidenceAnchor()],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported",
    status: "approved",
    createdAt: FIXED_NOW
  };
}

function paddedIndex(index: number): string {
  return String(index).padStart(4, "0");
}

function timestampForIndex(index: number): string {
  return new Date(Date.parse(FIXED_NOW) + index).toISOString();
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
    quoteHash: "hash_1",
    characterStart: 0,
    characterEnd: 20
  };
}

function nodeSqliteSkipReason(): string | undefined {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return undefined;
  } catch {
    return "node:sqlite is not available in this Node.js runtime";
  }
}
