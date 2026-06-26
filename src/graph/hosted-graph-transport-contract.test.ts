import assert from "node:assert/strict";
import test from "node:test";

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
import {
  assertHostedGraphTransportContract,
  HostedGraphTransportContractError,
  validateHostedGraphTransportContract
} from "./hosted-graph-transport-contract.js";
import type { GraphEntityProposal, GraphRelationProposal } from "./graph-types.js";
import {
  compareGraphPageFacts,
  decodeGraphPageCursor,
  encodeGraphPageCursor,
  isGraphPageFactAfterCursor
} from "./graph-pagination.js";

test("asserts the hosted graph transport contract for a conforming transport", () => {
  const transport = new InMemoryContractHostedGraphTransport();
  const result = assertHostedGraphTransportContract({
    transport,
    runId: "hosted_contract_valid"
  });

  assert.equal(result.runId, "hosted_contract_valid");
  assert.equal(result.entityIds.length, 4);
  assert.equal(result.relationIds.length, 3);
  assert.deepEqual(result.issues, []);
});

test("reports graph transport contract failures without throwing in validate mode", () => {
  const result = validateHostedGraphTransportContract({
    transport: new BrokenHostedGraphTransport(),
    runId: "hosted_contract_broken"
  });
  const codes = new Set(result.issues.map((issue) => issue.code));

  assert.equal(codes.has("entity_name_lookup_failed"), true);
  assert.equal(codes.has("entity_namespace_filter_failed"), true);
  assert.equal(codes.has("relation_status_filter_failed"), true);
  assert.equal(codes.has("entity_pagination_failed"), true);
  assert.equal(codes.has("relation_endpoint_update_failed"), true);
});

test("throws a contract error with the full result when a hosted graph transport fails", () => {
  assert.throws(
    () =>
      assertHostedGraphTransportContract({
        transport: new BrokenHostedGraphTransport(),
        runId: "hosted_contract_error"
      }),
    (error) =>
      error instanceof HostedGraphTransportContractError &&
      error.result.issues.some((issue) => issue.code === "entity_name_lookup_failed")
  );
});

class InMemoryContractHostedGraphTransport implements HostedGraphStoreTransport {
  protected entities: GraphEntityProposal[] = [];
  protected relations: GraphRelationProposal[] = [];

  addExtractionBatch(request: HostedGraphAddBatchRequest): {
    readonly accepted: boolean;
    readonly entityCount: number;
    readonly relationCount: number;
  } {
    this.entities = upsertById(this.entities, request.batch.entities);
    this.relations = upsertById(this.relations, request.batch.relations);

    return {
      accepted: true,
      entityCount: request.batch.entities.length,
      relationCount: request.batch.relations.length
    };
  }

  queryEntities(request: HostedGraphEntityQueryRequest): HostedGraphEntityQueryResult {
    return {
      entities: this.filteredEntities(request).slice(0, request.limit)
    };
  }

  pageEntities(request: HostedGraphEntityPageRequest): HostedGraphEntityPageResult {
    const cursor = decodeGraphPageCursor(request.cursor, "entity");
    const matches = this.filteredEntities(request)
      .sort(compareGraphPageFacts)
      .filter((entity) => isGraphPageFactAfterCursor(entity, cursor));
    const entities = matches.slice(0, request.limit);
    const lastEntity = entities.at(-1);

    return {
      entities,
      ...(matches.length > request.limit && lastEntity !== undefined
        ? { nextCursor: encodeGraphPageCursor("entity", lastEntity) }
        : {})
    };
  }

  queryRelations(request: HostedGraphRelationQueryRequest): HostedGraphRelationQueryResult {
    return {
      relations: this.filteredRelations(request).slice(0, request.limit)
    };
  }

  pageRelations(request: HostedGraphRelationPageRequest): HostedGraphRelationPageResult {
    const cursor = decodeGraphPageCursor(request.cursor, "relation");
    const matches = this.filteredRelations(request)
      .sort(compareGraphPageFacts)
      .filter((relation) => isGraphPageFactAfterCursor(relation, cursor));
    const relations = matches.slice(0, request.limit);
    const lastRelation = relations.at(-1);

    return {
      relations,
      ...(matches.length > request.limit && lastRelation !== undefined
        ? { nextCursor: encodeGraphPageCursor("relation", lastRelation) }
        : {})
    };
  }

  updateEntityStatus(request: HostedGraphUpdateEntityStatusRequest): {
    readonly entity?: GraphEntityProposal;
  } {
    const entity = this.entities.find((candidate) => candidate.id === request.id);
    if (entity === undefined) {
      return {};
    }

    const updated = { ...entity, status: request.status };
    this.entities = upsertById(this.entities, [updated]);
    return { entity: updated };
  }

  updateRelationStatus(request: HostedGraphUpdateRelationStatusRequest): {
    readonly relation?: GraphRelationProposal;
  } {
    const relation = this.relations.find((candidate) => candidate.id === request.id);
    if (relation === undefined) {
      return {};
    }

    const updated = { ...relation, status: request.status };
    this.relations = upsertById(this.relations, [updated]);
    return { relation: updated };
  }

  updateRelationEndpoints(request: HostedGraphUpdateRelationEndpointsRequest): {
    readonly relation?: GraphRelationProposal;
  } {
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
    this.relations = upsertById(this.relations, [updated]);
    return { relation: updated };
  }

  pruneEvidence(request: HostedGraphEvidencePruneRequest) {
    let prunedEntityCount = 0;
    let prunedRelationCount = 0;
    let supersededEntityCount = 0;
    let supersededRelationCount = 0;
    let removedEvidenceAnchorCount = 0;

    this.entities = this.entities.map((entity) => {
      if (
        entity.namespaceId !== request.filter.namespaceId ||
        entity.accessScope.tenantId !== request.filter.tenantId
      ) {
        return entity;
      }
      const evidence = entity.evidence.filter(
        (anchor) => !anchorMatchesPruneRequest(anchor, request)
      );
      const removed = entity.evidence.length - evidence.length;
      if (removed === 0) {
        return entity;
      }
      prunedEntityCount += 1;
      removedEvidenceAnchorCount += removed;
      if (evidence.length === 0) {
        supersededEntityCount += 1;
      }
      return {
        ...entity,
        evidence,
        ...(evidence.length === 0 ? { status: "superseded" as const } : {})
      };
    });

    this.relations = this.relations.map((relation) => {
      if (
        relation.namespaceId !== request.filter.namespaceId ||
        relation.accessScope.tenantId !== request.filter.tenantId
      ) {
        return relation;
      }
      const evidence = relation.evidence.filter(
        (anchor) => !anchorMatchesPruneRequest(anchor, request)
      );
      const removed = relation.evidence.length - evidence.length;
      if (removed === 0) {
        return relation;
      }
      prunedRelationCount += 1;
      removedEvidenceAnchorCount += removed;
      if (evidence.length === 0) {
        supersededRelationCount += 1;
      }
      return {
        ...relation,
        evidence,
        ...(evidence.length === 0 ? { status: "superseded" as const } : {})
      };
    });

    return {
      accepted: removedEvidenceAnchorCount > 0,
      prunedEntityCount,
      prunedRelationCount,
      supersededEntityCount,
      supersededRelationCount,
      removedEvidenceAnchorCount
    };
  }

  protected filteredEntities(request: HostedGraphEntityQueryRequest): GraphEntityProposal[] {
    return this.entities
      .filter((entity) => entity.namespaceId === request.filter.namespaceId)
      .filter((entity) => entity.accessScope.tenantId === request.filter.tenantId)
      .filter((entity) => request.entityIds === undefined || request.entityIds.includes(entity.id))
      .filter(
        (entity) =>
          request.entityName === undefined || entityNameMatches(entity, request.entityName)
      );
  }

  protected filteredRelations(request: HostedGraphRelationQueryRequest): GraphRelationProposal[] {
    return this.relations
      .filter((relation) => relation.namespaceId === request.filter.namespaceId)
      .filter((relation) => relation.accessScope.tenantId === request.filter.tenantId)
      .filter((relation) => request.includeUnapproved === true || relation.status === "approved")
      .filter(
        (relation) =>
          request.entityId === undefined ||
          relation.sourceEntityId === request.entityId ||
          relation.targetEntityId === request.entityId
      )
      .filter(
        (relation) =>
          request.relationKinds === undefined ||
          request.relationKinds.includes(relation.relationKind)
      );
  }
}

class BrokenHostedGraphTransport extends InMemoryContractHostedGraphTransport {
  override queryEntities(request: HostedGraphEntityQueryRequest): HostedGraphEntityQueryResult {
    return {
      entities: this.entities.slice(0, request.limit)
    };
  }

  override pageEntities(request: HostedGraphEntityPageRequest): HostedGraphEntityPageResult {
    return {
      entities: this.entities.slice(0, request.limit + 1)
    };
  }

  override queryRelations(
    request: HostedGraphRelationQueryRequest
  ): HostedGraphRelationQueryResult {
    return {
      relations: this.relations.slice(0, request.limit)
    };
  }

  override pageRelations(request: HostedGraphRelationPageRequest): HostedGraphRelationPageResult {
    return {
      relations: this.relations.slice(0, request.limit + 1)
    };
  }

  override updateEntityStatus(): { readonly entity?: GraphEntityProposal } {
    return {};
  }

  override updateRelationStatus(): { readonly relation?: GraphRelationProposal } {
    return {};
  }

  override updateRelationEndpoints(): { readonly relation?: GraphRelationProposal } {
    return {};
  }
}

function upsertById<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] {
  const merged = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    merged.set(item.id, item);
  }

  return [...merged.values()];
}

function anchorMatchesPruneRequest(
  anchor: GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number],
  request: HostedGraphEvidencePruneRequest
): boolean {
  return (
    request.documentIds?.includes(anchor.documentId) === true ||
    request.chunkIds?.includes(anchor.chunkId) === true ||
    request.sourceIds?.includes(anchor.sourceId) === true
  );
}

function entityNameMatches(entity: GraphEntityProposal, entityName: string): boolean {
  const queryName = normalizeIndexKey(entityName);
  const names = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])].map(
    normalizeIndexKey
  );
  const tokens = names.flatMap((name) => name.split(" ").filter(Boolean));

  return [...names, ...tokens].includes(queryName);
}

function normalizeIndexKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
