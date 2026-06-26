import assert from "node:assert/strict";
import test from "node:test";

import { FIXED_NOW, makeIndexFilter } from "../test-support/fixtures.js";
import type {
  HostedGraphAddBatchRequest,
  HostedGraphEntityPageRequest,
  HostedGraphEntityPageResult,
  HostedGraphEntityQueryRequest,
  HostedGraphEntityQueryResult,
  HostedGraphEvidencePruneRequest,
  HostedGraphRelationPageRequest,
  HostedGraphRelationPageResult,
  HostedGraphRelationQueryRequest,
  HostedGraphRelationQueryResult,
  HostedGraphStoreTransport,
  HostedGraphUpdateEntityStatusRequest,
  HostedGraphUpdateRelationEndpointsRequest,
  HostedGraphUpdateRelationStatusRequest
} from "./hosted-graph-store.js";
import { HostedGraphStore } from "./hosted-graph-store.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "./graph-types.js";
import { ownershipGraphOntology } from "./ownership-ontology.js";

test("hosted graph store validates batches and delegates writes to transport", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({ transport });
  const batch = makeBatch();

  assert.deepEqual(store.addExtractionBatch(batch), {
    accepted: true,
    entityCount: 3,
    relationCount: 3
  });

  assert.equal(transport.addRequests.length, 1);
  assert.equal(transport.addRequests[0]?.batch.id, "batch_hosted_graph_store");
});

test("hosted graph entity reads do not send principal claims and still enforce access locally", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({
    transport,
    candidateMultiplier: 3,
    maxCandidateLimit: 50
  });
  store.addExtractionBatch(makeBatch());

  const entities = store.queryEntities({
    filter: makeIndexFilter({ limit: 4 }),
    entityName: "Parent",
    limit: 2
  });

  assert.deepEqual(
    entities.map((entity) => entity.id),
    ["entity_parent"]
  );
  assert.equal(transport.entityQueries.length, 1);
  assert.equal(transport.entityQueries[0]?.limit, 6);

  const requestJson = JSON.stringify(transport.entityQueries[0]);
  assert.equal(Object.hasOwn(transport.entityQueries[0]?.filter ?? {}, "principal"), false);
  assert.equal(requestJson.includes("user_1"), false);
  assert.equal(requestJson.includes("support_team"), false);
  assert.equal(requestJson.includes("internal"), false);
});

test("hosted graph relation reads hide denied and unapproved facts after transport returns them", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({ transport });
  store.addExtractionBatch(makeBatch());

  assert.deepEqual(
    store.findRelations({ filter: makeIndexFilter() }).map((relation) => relation.id),
    ["rel_owns"]
  );
  assert.deepEqual(
    store
      .findRelations({
        filter: makeIndexFilter(),
        includeUnapproved: true
      })
      .map((relation) => relation.id),
    ["rel_owns", "rel_proposed"]
  );
});

test("hosted graph evidence pruning delegates safe selectors without principal claims", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({ transport });

  const result = store.pruneEvidence({
    filter: makeIndexFilter(),
    documentIds: ["doc_1"]
  });

  assert.equal(result.accepted, false);
  assert.equal(transport.evidencePrunes.length, 1);
  assert.deepEqual(transport.evidencePrunes[0]?.documentIds, ["doc_1"]);
  assert.equal(Object.hasOwn(transport.evidencePrunes[0]?.filter ?? {}, "principal"), false);
  assert.equal(JSON.stringify(transport.evidencePrunes[0]).includes("user_1"), false);
});

test("hosted graph pagination filters denied facts and keeps safe cursors", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({ transport });
  store.addExtractionBatch(makeBatch());

  const entityPage = store.pageEntities({
    filter: makeIndexFilter(),
    limit: 1
  });
  assert.deepEqual(
    entityPage.entities.map((entity) => entity.id),
    ["entity_parent"]
  );
  assert.equal(typeof entityPage.nextCursor, "string");

  const relationPage = store.pageRelations({
    filter: makeIndexFilter(),
    includeUnapproved: true,
    limit: 1
  });
  assert.deepEqual(
    relationPage.relations.map((relation) => relation.id),
    ["rel_owns"]
  );
  assert.equal(typeof relationPage.nextCursor, "string");
});

test("hosted graph status and endpoint updates delegate to transport", () => {
  const transport = new RecordingHostedGraphTransport();
  const store = new HostedGraphStore({ transport });
  store.addExtractionBatch(makeBatch());

  assert.equal(store.updateEntityStatus("entity_parent", "approved")?.status, "approved");
  assert.equal(store.updateRelationStatus("rel_proposed", "rejected")?.status, "rejected");
  assert.equal(
    store.updateRelationEndpoints("rel_owns", { sourceEntityId: "entity_child" })?.sourceEntityId,
    "entity_child"
  );

  assert.deepEqual(
    transport.entityStatusUpdates.map((request) => request.id),
    ["entity_parent"]
  );
  assert.deepEqual(
    transport.relationStatusUpdates.map((request) => request.id),
    ["rel_proposed"]
  );
  assert.deepEqual(
    transport.relationEndpointUpdates.map((request) => request.id),
    ["rel_owns"]
  );
});

class RecordingHostedGraphTransport implements HostedGraphStoreTransport {
  readonly addRequests: HostedGraphAddBatchRequest[] = [];
  readonly entityQueries: HostedGraphEntityQueryRequest[] = [];
  readonly entityPages: HostedGraphEntityPageRequest[] = [];
  readonly relationQueries: HostedGraphRelationQueryRequest[] = [];
  readonly relationPages: HostedGraphRelationPageRequest[] = [];
  readonly entityStatusUpdates: HostedGraphUpdateEntityStatusRequest[] = [];
  readonly relationStatusUpdates: HostedGraphUpdateRelationStatusRequest[] = [];
  readonly relationEndpointUpdates: HostedGraphUpdateRelationEndpointsRequest[] = [];
  readonly evidencePrunes: HostedGraphEvidencePruneRequest[] = [];

  private entities: GraphEntityProposal[] = [];
  private relations: GraphRelationProposal[] = [];

  addExtractionBatch(request: HostedGraphAddBatchRequest): {
    readonly accepted: boolean;
    readonly entityCount: number;
    readonly relationCount: number;
  } {
    this.addRequests.push(request);
    this.entities = [...this.entities, ...request.batch.entities];
    this.relations = [...this.relations, ...request.batch.relations];

    return {
      accepted: true,
      entityCount: request.batch.entities.length,
      relationCount: request.batch.relations.length
    };
  }

  queryEntities(request: HostedGraphEntityQueryRequest): HostedGraphEntityQueryResult {
    this.entityQueries.push(request);
    return { entities: this.entities.slice(0, request.limit) };
  }

  pageEntities(request: HostedGraphEntityPageRequest): HostedGraphEntityPageResult {
    this.entityPages.push(request);
    return { entities: this.entities.slice(0, request.limit) };
  }

  queryRelations(request: HostedGraphRelationQueryRequest): HostedGraphRelationQueryResult {
    this.relationQueries.push(request);
    return { relations: this.relations.slice(0, request.limit) };
  }

  pageRelations(request: HostedGraphRelationPageRequest): HostedGraphRelationPageResult {
    this.relationPages.push(request);
    return { relations: this.relations.slice(0, request.limit) };
  }

  updateEntityStatus(request: HostedGraphUpdateEntityStatusRequest): {
    readonly entity?: GraphEntityProposal;
  } {
    this.entityStatusUpdates.push(request);
    const entity = this.entities.find((candidate) => candidate.id === request.id);
    if (entity === undefined) {
      return {};
    }

    const updated = { ...entity, status: request.status };
    this.entities = this.entities.map((candidate) =>
      candidate.id === updated.id ? updated : candidate
    );
    return { entity: updated };
  }

  updateRelationStatus(request: HostedGraphUpdateRelationStatusRequest): {
    readonly relation?: GraphRelationProposal;
  } {
    this.relationStatusUpdates.push(request);
    const relation = this.relations.find((candidate) => candidate.id === request.id);
    if (relation === undefined) {
      return {};
    }

    const updated = { ...relation, status: request.status };
    this.relations = this.relations.map((candidate) =>
      candidate.id === updated.id ? updated : candidate
    );
    return { relation: updated };
  }

  updateRelationEndpoints(request: HostedGraphUpdateRelationEndpointsRequest): {
    readonly relation?: GraphRelationProposal;
  } {
    this.relationEndpointUpdates.push(request);
    const relation = this.relations.find((candidate) => candidate.id === request.id);
    if (relation === undefined) {
      return {};
    }

    const updated = {
      ...relation,
      ...(request.endpoints.sourceEntityId === undefined
        ? {}
        : { sourceEntityId: request.endpoints.sourceEntityId }),
      ...(request.endpoints.targetEntityId === undefined
        ? {}
        : { targetEntityId: request.endpoints.targetEntityId })
    };
    this.relations = this.relations.map((candidate) =>
      candidate.id === updated.id ? updated : candidate
    );
    return { relation: updated };
  }

  pruneEvidence(request: HostedGraphEvidencePruneRequest) {
    this.evidencePrunes.push(request);
    return {
      accepted: false,
      prunedEntityCount: 0,
      prunedRelationCount: 0,
      supersededEntityCount: 0,
      supersededRelationCount: 0,
      removedEvidenceAnchorCount: 0
    };
  }
}

function makeBatch(): GraphExtractionBatch {
  const supportScope = {
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    tags: ["support"]
  };
  const privateScope = {
    tenantId: "tenant_1",
    namespaceId: "test-namespace",
    tags: ["board_only"]
  };
  const baseEntity = {
    namespaceId: "test-namespace",
    kind: "legal_entity" as const,
    confidence: 0.92,
    trustTier: "trusted_internal" as const,
    evidence: [evidenceAnchor()],
    status: "proposed" as const,
    createdAt: FIXED_NOW
  };
  const baseRelation = {
    namespaceId: "test-namespace",
    sourceEntityId: "entity_parent",
    targetEntityId: "entity_child",
    factStrength: "explicit_fact" as const,
    confidence: 0.9,
    trustTier: "trusted_internal" as const,
    evidence: [evidenceAnchor()],
    temporal: { observedAt: FIXED_NOW },
    verificationStatus: "supported" as const,
    createdAt: FIXED_NOW
  };

  return {
    id: "batch_hosted_graph_store",
    namespaceId: "test-namespace",
    ontology: ownershipGraphOntology,
    entities: [
      {
        ...baseEntity,
        id: "entity_parent",
        name: "Parent Holdings LLC",
        normalizedName: "parent holdings",
        accessScope: supportScope
      },
      {
        ...baseEntity,
        id: "entity_child",
        name: "Child Operating LLC",
        normalizedName: "child operating",
        accessScope: supportScope
      },
      {
        ...baseEntity,
        id: "entity_private",
        name: "Board Private LLC",
        normalizedName: "board private",
        accessScope: privateScope
      }
    ],
    relations: [
      {
        ...baseRelation,
        id: "rel_owns",
        relationKind: "owns",
        accessScope: supportScope,
        status: "approved"
      },
      {
        ...baseRelation,
        id: "rel_proposed",
        relationKind: "controls",
        accessScope: supportScope,
        status: "proposed"
      },
      {
        ...baseRelation,
        id: "rel_private",
        relationKind: "owns",
        targetEntityId: "entity_private",
        accessScope: privateScope,
        status: "approved"
      }
    ],
    createdAt: FIXED_NOW
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
    quoteHash: "hash_1",
    characterStart: 0,
    characterEnd: 20
  };
}
