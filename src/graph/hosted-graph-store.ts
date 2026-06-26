import type { IndexFilter } from "../indexing/index-types.js";
import { assertValidIndexFilter } from "../indexing/index-filter.js";
import { evaluateAccess } from "../security/access-control.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphProposalStatus,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";
import { assertValidGraphExtractionBatch } from "./graph-validation.js";
import {
  decodeGraphPageCursor,
  encodeGraphPageCursor,
  type GraphPageCursor
} from "./graph-pagination.js";
import type {
  GraphEntityPage,
  GraphEntityPageQuery,
  GraphEntityQuery,
  GraphEvidencePruneRequest,
  GraphEvidencePruneResult,
  GraphRelationPage,
  GraphRelationPageQuery,
  GraphRelationQuery,
  GraphStore,
  GraphStoreWriteResult
} from "./in-memory-graph-store.js";

export interface HostedGraphStoreTransport {
  addExtractionBatch(request: HostedGraphAddBatchRequest): GraphStoreWriteResult;
  queryEntities(request: HostedGraphEntityQueryRequest): HostedGraphEntityQueryResult;
  pageEntities(request: HostedGraphEntityPageRequest): HostedGraphEntityPageResult;
  queryRelations(request: HostedGraphRelationQueryRequest): HostedGraphRelationQueryResult;
  pageRelations(request: HostedGraphRelationPageRequest): HostedGraphRelationPageResult;
  updateEntityStatus(request: HostedGraphUpdateEntityStatusRequest): HostedGraphEntityUpdateResult;
  updateRelationStatus(
    request: HostedGraphUpdateRelationStatusRequest
  ): HostedGraphRelationUpdateResult;
  updateRelationEndpoints(
    request: HostedGraphUpdateRelationEndpointsRequest
  ): HostedGraphRelationUpdateResult;
  pruneEvidence(request: HostedGraphEvidencePruneRequest): GraphEvidencePruneResult;
}

export interface HostedGraphStoreOptions {
  readonly transport: HostedGraphStoreTransport;
  readonly candidateMultiplier?: number;
  readonly maxCandidateLimit?: number;
}

export interface HostedGraphSafeIndexFilter {
  readonly namespaceId: string;
  readonly tenantId: string;
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceKinds?: IndexFilter["sourceKinds"];
  readonly trustTiers?: IndexFilter["trustTiers"];
  readonly includeSafetyFlags?: IndexFilter["includeSafetyFlags"];
  readonly excludeSafetyFlags?: IndexFilter["excludeSafetyFlags"];
  readonly accessTags?: readonly string[];
  readonly limit?: number;
}

export interface HostedGraphAddBatchRequest {
  readonly batch: GraphExtractionBatch;
}

export interface HostedGraphEntityQueryRequest {
  readonly filter: HostedGraphSafeIndexFilter;
  readonly entityIds?: readonly string[];
  readonly entityName?: string;
  readonly limit: number;
}

export interface HostedGraphEntityPageRequest extends HostedGraphEntityQueryRequest {
  readonly cursor?: GraphPageCursor;
}

export interface HostedGraphEntityQueryResult {
  readonly entities: readonly GraphEntityProposal[];
}

export interface HostedGraphEntityPageResult extends HostedGraphEntityQueryResult {
  readonly nextCursor?: GraphPageCursor;
}

export interface HostedGraphRelationQueryRequest {
  readonly filter: HostedGraphSafeIndexFilter;
  readonly entityId?: string;
  readonly relationKinds?: readonly GraphRelationKind[];
  readonly includeUnapproved?: boolean;
  readonly limit: number;
}

export interface HostedGraphRelationPageRequest extends HostedGraphRelationQueryRequest {
  readonly cursor?: GraphPageCursor;
}

export interface HostedGraphRelationQueryResult {
  readonly relations: readonly GraphRelationProposal[];
}

export interface HostedGraphRelationPageResult extends HostedGraphRelationQueryResult {
  readonly nextCursor?: GraphPageCursor;
}

export interface HostedGraphUpdateEntityStatusRequest {
  readonly id: string;
  readonly status: GraphProposalStatus;
}

export interface HostedGraphUpdateRelationStatusRequest {
  readonly id: string;
  readonly status: GraphProposalStatus;
}

export interface HostedGraphUpdateRelationEndpointsRequest {
  readonly id: string;
  readonly endpoints: {
    readonly sourceEntityId?: string;
    readonly targetEntityId?: string;
  };
}

export interface HostedGraphEvidencePruneRequest {
  readonly filter: HostedGraphSafeIndexFilter;
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceIds?: readonly string[];
}

export interface HostedGraphEntityUpdateResult {
  readonly entity?: GraphEntityProposal;
}

export interface HostedGraphRelationUpdateResult {
  readonly relation?: GraphRelationProposal;
}

const DEFAULT_QUERY_LIMIT = 100;
const DEFAULT_CANDIDATE_MULTIPLIER = 5;
const DEFAULT_MAX_CANDIDATE_LIMIT = 500;

export class HostedGraphStore implements GraphStore {
  private readonly transport: HostedGraphStoreTransport;
  private readonly candidateMultiplier: number;
  private readonly maxCandidateLimit: number;

  constructor(options: HostedGraphStoreOptions) {
    this.transport = options.transport;
    this.candidateMultiplier = options.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
    this.maxCandidateLimit = options.maxCandidateLimit ?? DEFAULT_MAX_CANDIDATE_LIMIT;

    if (!Number.isInteger(this.candidateMultiplier) || this.candidateMultiplier < 1) {
      throw new Error("Hosted graph candidateMultiplier must be a positive integer.");
    }

    if (!Number.isInteger(this.maxCandidateLimit) || this.maxCandidateLimit < 1) {
      throw new Error("Hosted graph maxCandidateLimit must be a positive integer.");
    }
  }

  addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult {
    assertValidGraphExtractionBatch(batch);
    return this.transport.addExtractionBatch({ batch });
  }

  findEntities(filter: IndexFilter): readonly GraphEntityProposal[] {
    return this.queryEntities({ filter });
  }

  queryEntities(query: GraphEntityQuery): readonly GraphEntityProposal[] {
    assertValidIndexFilter(query.filter);
    const limit = publicLimit(query.limit, query.filter.limit);
    if (limit === 0) {
      return [];
    }

    const result = this.transport.queryEntities({
      filter: toHostedFilter(query.filter),
      ...(query.entityIds === undefined ? {} : { entityIds: query.entityIds }),
      ...(query.entityName === undefined ? {} : { entityName: query.entityName }),
      limit: candidateLimit(limit, this.candidateMultiplier, this.maxCandidateLimit)
    });

    return result.entities.filter((entity) => entityVisibleForQuery(entity, query)).slice(0, limit);
  }

  pageEntities(query: GraphEntityPageQuery): GraphEntityPage {
    assertValidIndexFilter(query.filter);
    const limit = publicLimit(query.limit, query.filter.limit);
    if (limit === 0) {
      return { entities: [] };
    }

    if (query.cursor !== undefined) {
      decodeGraphPageCursor(query.cursor, "entity");
    }

    const result = this.transport.pageEntities({
      filter: toHostedFilter(query.filter),
      ...(query.entityIds === undefined ? {} : { entityIds: query.entityIds }),
      ...(query.entityName === undefined ? {} : { entityName: query.entityName }),
      limit: candidateLimit(limit, this.candidateMultiplier, this.maxCandidateLimit),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    const visible = result.entities.filter((entity) => entityVisibleForQuery(entity, query));
    const entities = visible.slice(0, limit);

    return {
      entities,
      ...nextPageCursor("entity", entities, visible.length, limit, result.nextCursor)
    };
  }

  findRelations(query: GraphRelationQuery): readonly GraphRelationProposal[] {
    assertValidIndexFilter(query.filter);
    const limit = publicLimit(query.limit, query.filter.limit);
    if (limit === 0) {
      return [];
    }

    const result = this.transport.queryRelations({
      filter: toHostedFilter(query.filter),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.relationKinds === undefined ? {} : { relationKinds: query.relationKinds }),
      ...(query.includeUnapproved === undefined
        ? {}
        : { includeUnapproved: query.includeUnapproved }),
      limit: candidateLimit(limit, this.candidateMultiplier, this.maxCandidateLimit)
    });

    return result.relations
      .filter((relation) => relationVisibleForQuery(relation, query))
      .slice(0, limit);
  }

  pageRelations(query: GraphRelationPageQuery): GraphRelationPage {
    assertValidIndexFilter(query.filter);
    const limit = publicLimit(query.limit, query.filter.limit);
    if (limit === 0) {
      return { relations: [] };
    }

    if (query.cursor !== undefined) {
      decodeGraphPageCursor(query.cursor, "relation");
    }

    const result = this.transport.pageRelations({
      filter: toHostedFilter(query.filter),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.relationKinds === undefined ? {} : { relationKinds: query.relationKinds }),
      ...(query.includeUnapproved === undefined
        ? {}
        : { includeUnapproved: query.includeUnapproved }),
      limit: candidateLimit(limit, this.candidateMultiplier, this.maxCandidateLimit),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    const visible = result.relations.filter((relation) => relationVisibleForQuery(relation, query));
    const relations = visible.slice(0, limit);

    return {
      relations,
      ...nextPageCursor("relation", relations, visible.length, limit, result.nextCursor)
    };
  }

  updateEntityStatus(id: string, status: GraphProposalStatus): GraphEntityProposal | undefined {
    return this.transport.updateEntityStatus({ id, status }).entity;
  }

  updateRelationStatus(id: string, status: GraphProposalStatus): GraphRelationProposal | undefined {
    return this.transport.updateRelationStatus({ id, status }).relation;
  }

  updateRelationEndpoints(
    id: string,
    endpoints: {
      readonly sourceEntityId?: string;
      readonly targetEntityId?: string;
    }
  ): GraphRelationProposal | undefined {
    return this.transport.updateRelationEndpoints({ id, endpoints }).relation;
  }

  pruneEvidence(request: GraphEvidencePruneRequest): GraphEvidencePruneResult {
    assertValidIndexFilter(request.filter);
    return this.transport.pruneEvidence({
      filter: toHostedFilter(request.filter),
      ...(request.documentIds === undefined ? {} : { documentIds: request.documentIds }),
      ...(request.chunkIds === undefined ? {} : { chunkIds: request.chunkIds }),
      ...(request.sourceIds === undefined ? {} : { sourceIds: request.sourceIds })
    });
  }
}

function toHostedFilter(filter: IndexFilter): HostedGraphSafeIndexFilter {
  return {
    namespaceId: filter.namespaceId,
    tenantId: filter.tenantId,
    ...(filter.documentIds === undefined ? {} : { documentIds: filter.documentIds }),
    ...(filter.chunkIds === undefined ? {} : { chunkIds: filter.chunkIds }),
    ...(filter.sourceIds === undefined ? {} : { sourceIds: filter.sourceIds }),
    ...(filter.sourceKinds === undefined ? {} : { sourceKinds: filter.sourceKinds }),
    ...(filter.trustTiers === undefined ? {} : { trustTiers: filter.trustTiers }),
    ...(filter.includeSafetyFlags === undefined
      ? {}
      : { includeSafetyFlags: filter.includeSafetyFlags }),
    ...(filter.excludeSafetyFlags === undefined
      ? {}
      : { excludeSafetyFlags: filter.excludeSafetyFlags }),
    ...(filter.accessTags === undefined ? {} : { accessTags: filter.accessTags }),
    ...(filter.limit === undefined ? {} : { limit: filter.limit })
  };
}

function entityVisibleForQuery(entity: GraphEntityProposal, query: GraphEntityQuery): boolean {
  return (
    entity.namespaceId === query.filter.namespaceId &&
    evaluateAccess(query.filter.principal, entity.accessScope).allowed &&
    (query.entityIds === undefined || query.entityIds.includes(entity.id)) &&
    (query.entityName === undefined || entityNameMatches(entity, query.entityName))
  );
}

function relationVisibleForQuery(
  relation: GraphRelationProposal,
  query: GraphRelationQuery
): boolean {
  return (
    relation.namespaceId === query.filter.namespaceId &&
    evaluateAccess(query.filter.principal, relation.accessScope).allowed &&
    (query.includeUnapproved === true || relation.status === "approved") &&
    (query.entityId === undefined ||
      relation.sourceEntityId === query.entityId ||
      relation.targetEntityId === query.entityId) &&
    (query.relationKinds === undefined || query.relationKinds.includes(relation.relationKind))
  );
}

function entityNameMatches(entity: GraphEntityProposal, entityName: string): boolean {
  const queryName = normalizeIndexKey(entityName);
  if (queryName.length === 0) {
    return true;
  }

  return entityNameKeys(entity).includes(queryName);
}

function entityNameKeys(entity: GraphEntityProposal): readonly string[] {
  const normalized = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])].map(
    normalizeIndexKey
  );
  const tokens = normalized.flatMap((value) => value.split(" ").filter(Boolean));
  return unique([...normalized, ...tokens]);
}

function normalizeIndexKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function publicLimit(queryLimit: number | undefined, filterLimit: number | undefined): number {
  const limit = queryLimit ?? filterLimit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("Graph query limit must be a non-negative integer.");
  }
  return limit;
}

function candidateLimit(limit: number, multiplier: number, maxCandidateLimit: number): number {
  return Math.max(limit, Math.min(maxCandidateLimit, limit * multiplier));
}

function nextPageCursor(
  target: "entity",
  facts: readonly GraphEntityProposal[],
  visibleCount: number,
  limit: number,
  hostedCursor: GraphPageCursor | undefined
): Partial<GraphEntityPage>;
function nextPageCursor(
  target: "relation",
  facts: readonly GraphRelationProposal[],
  visibleCount: number,
  limit: number,
  hostedCursor: GraphPageCursor | undefined
): Partial<GraphRelationPage>;
function nextPageCursor(
  target: "entity" | "relation",
  facts: readonly (GraphEntityProposal | GraphRelationProposal)[],
  visibleCount: number,
  limit: number,
  hostedCursor: GraphPageCursor | undefined
): { readonly nextCursor?: GraphPageCursor } {
  const lastFact = facts.at(-1);
  if (lastFact !== undefined && (visibleCount > limit || hostedCursor !== undefined)) {
    return { nextCursor: encodeGraphPageCursor(target, lastFact) };
  }

  if (hostedCursor !== undefined) {
    return { nextCursor: hostedCursor };
  }

  return {};
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
