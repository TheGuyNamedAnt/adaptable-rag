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
  compareGraphPageFacts,
  decodeGraphPageCursor,
  encodeGraphPageCursor,
  isGraphPageFactAfterCursor,
  type GraphPageCursor
} from "./graph-pagination.js";

export interface GraphRelationQuery {
  readonly filter: IndexFilter;
  readonly entityId?: string;
  readonly relationKinds?: readonly GraphRelationKind[];
  readonly includeUnapproved?: boolean;
  readonly limit?: number;
}

export interface GraphEntityQuery {
  readonly filter: IndexFilter;
  readonly entityIds?: readonly string[];
  readonly entityName?: string;
  readonly limit?: number;
}

export interface GraphEntityPageQuery extends GraphEntityQuery {
  readonly cursor?: GraphPageCursor;
}

export interface GraphRelationPageQuery extends GraphRelationQuery {
  readonly cursor?: GraphPageCursor;
}

export interface GraphEntityPage {
  readonly entities: readonly GraphEntityProposal[];
  readonly nextCursor?: GraphPageCursor;
}

export interface GraphRelationPage {
  readonly relations: readonly GraphRelationProposal[];
  readonly nextCursor?: GraphPageCursor;
}

export interface GraphEvidencePruneRequest {
  readonly filter: IndexFilter;
  readonly documentIds?: readonly string[];
  readonly chunkIds?: readonly string[];
  readonly sourceIds?: readonly string[];
}

export interface GraphEvidencePruneResult {
  readonly accepted: boolean;
  readonly prunedEntityCount: number;
  readonly prunedRelationCount: number;
  readonly supersededEntityCount: number;
  readonly supersededRelationCount: number;
  readonly removedEvidenceAnchorCount: number;
}

export interface GraphStore {
  addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult;
  findEntities(filter: IndexFilter): readonly GraphEntityProposal[];
  queryEntities?(query: GraphEntityQuery): readonly GraphEntityProposal[];
  pageEntities?(query: GraphEntityPageQuery): GraphEntityPage;
  findRelations(query: GraphRelationQuery): readonly GraphRelationProposal[];
  pageRelations?(query: GraphRelationPageQuery): GraphRelationPage;
  updateEntityStatus(id: string, status: GraphProposalStatus): GraphEntityProposal | undefined;
  updateRelationStatus(id: string, status: GraphProposalStatus): GraphRelationProposal | undefined;
  updateRelationEndpoints(
    id: string,
    endpoints: {
      readonly sourceEntityId?: string;
      readonly targetEntityId?: string;
    }
  ): GraphRelationProposal | undefined;
  pruneEvidence(request: GraphEvidencePruneRequest): GraphEvidencePruneResult;
}

export interface GraphStoreWriteResult {
  readonly accepted: boolean;
  readonly entityCount: number;
  readonly relationCount: number;
}

export interface InMemoryGraphStoreSnapshot {
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
}

export class InMemoryGraphStore implements GraphStore {
  private readonly entities = new Map<string, GraphEntityProposal>();
  private readonly relations = new Map<string, GraphRelationProposal>();
  private readonly entityIdsByNamespace = new Map<string, Set<string>>();
  private readonly entityIdsByNameKey = new Map<string, Set<string>>();
  private readonly relationIdsByNamespace = new Map<string, Set<string>>();
  private readonly relationIdsByEntityId = new Map<string, Set<string>>();
  private readonly relationIdsByKind = new Map<string, Set<string>>();

  addExtractionBatch(batch: GraphExtractionBatch): GraphStoreWriteResult {
    assertValidGraphExtractionBatch(batch);

    for (const entity of batch.entities) {
      this.setEntity(entity);
    }

    for (const relation of batch.relations) {
      this.setRelation(relation);
    }

    return {
      accepted: true,
      entityCount: batch.entities.length,
      relationCount: batch.relations.length
    };
  }

  findEntities(filter: IndexFilter): readonly GraphEntityProposal[] {
    return this.queryEntities({ filter });
  }

  queryEntities(query: GraphEntityQuery): readonly GraphEntityProposal[] {
    const filter = query.filter;
    assertValidIndexFilter(filter);
    const limit = query.limit ?? filter.limit ?? 100;
    const candidateIds = entityCandidateIds({
      query,
      namespaceIndex: this.entityIdsByNamespace,
      nameIndex: this.entityIdsByNameKey
    });

    return [...candidateIds]
      .flatMap((id) => {
        const entity = this.entities.get(id);
        return entity === undefined ? [] : [entity];
      })
      .filter(
        (entity) =>
          entity.namespaceId === filter.namespaceId &&
          evaluateAccess(filter.principal, entity.accessScope).allowed
      )
      .slice(0, Math.max(0, limit));
  }

  pageEntities(query: GraphEntityPageQuery): GraphEntityPage {
    const filter = query.filter;
    assertValidIndexFilter(filter);
    const limit = Math.max(0, query.limit ?? filter.limit ?? 100);
    if (limit === 0) {
      return { entities: [] };
    }

    const cursor = decodeGraphPageCursor(query.cursor, "entity");
    const candidateIds = entityCandidateIds({
      query,
      namespaceIndex: this.entityIdsByNamespace,
      nameIndex: this.entityIdsByNameKey
    });
    const matches = [...candidateIds]
      .flatMap((id) => {
        const entity = this.entities.get(id);
        return entity === undefined ? [] : [entity];
      })
      .filter(
        (entity) =>
          entity.namespaceId === filter.namespaceId &&
          evaluateAccess(filter.principal, entity.accessScope).allowed
      )
      .sort(compareGraphPageFacts)
      .filter((entity) => isGraphPageFactAfterCursor(entity, cursor));
    const entities = matches.slice(0, limit);
    const lastEntity = entities.at(-1);

    return {
      entities,
      ...(matches.length > limit && lastEntity !== undefined
        ? { nextCursor: encodeGraphPageCursor("entity", lastEntity) }
        : {})
    };
  }

  findRelations(query: GraphRelationQuery): readonly GraphRelationProposal[] {
    assertValidIndexFilter(query.filter);
    const limit = query.limit ?? query.filter.limit ?? 100;
    const candidateIds = relationCandidateIds({
      query,
      namespaceIndex: this.relationIdsByNamespace,
      entityIndex: this.relationIdsByEntityId,
      kindIndex: this.relationIdsByKind
    });

    return [...candidateIds]
      .flatMap((id) => {
        const relation = this.relations.get(id);
        return relation === undefined ? [] : [relation];
      })
      .filter((relation) => relation.namespaceId === query.filter.namespaceId)
      .filter((relation) => evaluateAccess(query.filter.principal, relation.accessScope).allowed)
      .filter((relation) => query.includeUnapproved === true || relation.status === "approved")
      .filter(
        (relation) =>
          query.entityId === undefined ||
          relation.sourceEntityId === query.entityId ||
          relation.targetEntityId === query.entityId
      )
      .filter(
        (relation) =>
          query.relationKinds === undefined || query.relationKinds.includes(relation.relationKind)
      )
      .slice(0, Math.max(0, limit));
  }

  pageRelations(query: GraphRelationPageQuery): GraphRelationPage {
    assertValidIndexFilter(query.filter);
    const limit = Math.max(0, query.limit ?? query.filter.limit ?? 100);
    if (limit === 0) {
      return { relations: [] };
    }

    const cursor = decodeGraphPageCursor(query.cursor, "relation");
    const candidateIds = relationCandidateIds({
      query,
      namespaceIndex: this.relationIdsByNamespace,
      entityIndex: this.relationIdsByEntityId,
      kindIndex: this.relationIdsByKind
    });
    const matches = [...candidateIds]
      .flatMap((id) => {
        const relation = this.relations.get(id);
        return relation === undefined ? [] : [relation];
      })
      .filter((relation) => relation.namespaceId === query.filter.namespaceId)
      .filter((relation) => evaluateAccess(query.filter.principal, relation.accessScope).allowed)
      .filter((relation) => query.includeUnapproved === true || relation.status === "approved")
      .filter(
        (relation) =>
          query.entityId === undefined ||
          relation.sourceEntityId === query.entityId ||
          relation.targetEntityId === query.entityId
      )
      .filter(
        (relation) =>
          query.relationKinds === undefined || query.relationKinds.includes(relation.relationKind)
      )
      .sort(compareGraphPageFacts)
      .filter((relation) => isGraphPageFactAfterCursor(relation, cursor));
    const relations = matches.slice(0, limit);
    const lastRelation = relations.at(-1);

    return {
      relations,
      ...(matches.length > limit && lastRelation !== undefined
        ? { nextCursor: encodeGraphPageCursor("relation", lastRelation) }
        : {})
    };
  }

  updateEntityStatus(id: string, status: GraphProposalStatus): GraphEntityProposal | undefined {
    const entity = this.entities.get(id);
    if (!entity) {
      return undefined;
    }

    const updated = { ...entity, status };
    this.setEntity(updated);
    return updated;
  }

  updateRelationStatus(id: string, status: GraphProposalStatus): GraphRelationProposal | undefined {
    const relation = this.relations.get(id);
    if (!relation) {
      return undefined;
    }

    const updated = { ...relation, status };
    this.setRelation(updated);
    return updated;
  }

  updateRelationEndpoints(
    id: string,
    endpoints: {
      readonly sourceEntityId?: string;
      readonly targetEntityId?: string;
    }
  ): GraphRelationProposal | undefined {
    const relation = this.relations.get(id);
    if (!relation) {
      return undefined;
    }

    const updated = {
      ...relation,
      ...(endpoints.sourceEntityId === undefined
        ? {}
        : { sourceEntityId: endpoints.sourceEntityId }),
      ...(endpoints.targetEntityId === undefined
        ? {}
        : { targetEntityId: endpoints.targetEntityId })
    };
    this.setRelation(updated);
    return updated;
  }

  pruneEvidence(request: GraphEvidencePruneRequest): GraphEvidencePruneResult {
    assertValidIndexFilter(request.filter);
    assertEvidencePruneSelector(request);

    let prunedEntityCount = 0;
    let prunedRelationCount = 0;
    let supersededEntityCount = 0;
    let supersededRelationCount = 0;
    let removedEvidenceAnchorCount = 0;

    for (const entity of [...this.entities.values()]) {
      if (!factVisibleForPrune(entity, request.filter)) {
        continue;
      }
      const pruned = pruneEvidenceAnchors(entity.evidence, request);
      if (pruned.removedCount === 0) {
        continue;
      }
      removedEvidenceAnchorCount += pruned.removedCount;
      prunedEntityCount += 1;
      const superseded = pruned.evidence.length === 0;
      if (superseded) {
        supersededEntityCount += 1;
      }
      this.setEntity({
        ...entity,
        evidence: pruned.evidence,
        ...(superseded ? { status: "superseded" } : {})
      });
    }

    for (const relation of [...this.relations.values()]) {
      if (!factVisibleForPrune(relation, request.filter)) {
        continue;
      }
      const pruned = pruneEvidenceAnchors(relation.evidence, request);
      if (pruned.removedCount === 0) {
        continue;
      }
      removedEvidenceAnchorCount += pruned.removedCount;
      prunedRelationCount += 1;
      const superseded = pruned.evidence.length === 0;
      if (superseded) {
        supersededRelationCount += 1;
      }
      this.setRelation({
        ...relation,
        evidence: pruned.evidence,
        ...(superseded ? { status: "superseded" } : {})
      });
    }

    return {
      accepted: removedEvidenceAnchorCount > 0,
      prunedEntityCount,
      prunedRelationCount,
      supersededEntityCount,
      supersededRelationCount,
      removedEvidenceAnchorCount
    };
  }

  snapshot(): InMemoryGraphStoreSnapshot {
    return {
      entities: [...this.entities.values()],
      relations: [...this.relations.values()]
    };
  }

  private setEntity(entity: GraphEntityProposal): void {
    const existing = this.entities.get(entity.id);
    if (existing) {
      this.removeEntityFromIndexes(existing);
    }
    this.entities.set(entity.id, entity);
    addToIndex(this.entityIdsByNamespace, entity.namespaceId, entity.id);
    for (const key of entityNameKeys(entity)) {
      addToIndex(this.entityIdsByNameKey, entityLookupKey(entity.namespaceId, key), entity.id);
    }
  }

  private setRelation(relation: GraphRelationProposal): void {
    const existing = this.relations.get(relation.id);
    if (existing) {
      this.removeRelationFromIndexes(existing);
    }
    this.relations.set(relation.id, relation);
    addToIndex(this.relationIdsByNamespace, relation.namespaceId, relation.id);
    addToIndex(this.relationIdsByEntityId, relation.sourceEntityId, relation.id);
    addToIndex(this.relationIdsByEntityId, relation.targetEntityId, relation.id);
    addToIndex(
      this.relationIdsByKind,
      relationLookupKey(relation.namespaceId, relation.relationKind),
      relation.id
    );
  }

  private removeEntityFromIndexes(entity: GraphEntityProposal): void {
    removeFromIndex(this.entityIdsByNamespace, entity.namespaceId, entity.id);
    for (const key of entityNameKeys(entity)) {
      removeFromIndex(this.entityIdsByNameKey, entityLookupKey(entity.namespaceId, key), entity.id);
    }
  }

  private removeRelationFromIndexes(relation: GraphRelationProposal): void {
    removeFromIndex(this.relationIdsByNamespace, relation.namespaceId, relation.id);
    removeFromIndex(this.relationIdsByEntityId, relation.sourceEntityId, relation.id);
    removeFromIndex(this.relationIdsByEntityId, relation.targetEntityId, relation.id);
    removeFromIndex(
      this.relationIdsByKind,
      relationLookupKey(relation.namespaceId, relation.relationKind),
      relation.id
    );
  }
}

function entityCandidateIds(input: {
  readonly query: GraphEntityQuery;
  readonly namespaceIndex: ReadonlyMap<string, ReadonlySet<string>>;
  readonly nameIndex: ReadonlyMap<string, ReadonlySet<string>>;
}): ReadonlySet<string> {
  const namespaceIds = input.namespaceIndex.get(input.query.filter.namespaceId) ?? new Set();
  const byIds =
    input.query.entityIds === undefined
      ? undefined
      : new Set(input.query.entityIds.filter((id) => namespaceIds.has(id)));
  const nameKey = normalizeIndexKey(input.query.entityName ?? "");
  const byName =
    nameKey.length === 0
      ? undefined
      : (input.nameIndex.get(entityLookupKey(input.query.filter.namespaceId, nameKey)) ??
        new Set());

  return intersectSets(
    [namespaceIds, byIds, byName].filter((set): set is ReadonlySet<string> => set !== undefined)
  );
}

function relationCandidateIds(input: {
  readonly query: GraphRelationQuery;
  readonly namespaceIndex: ReadonlyMap<string, ReadonlySet<string>>;
  readonly entityIndex: ReadonlyMap<string, ReadonlySet<string>>;
  readonly kindIndex: ReadonlyMap<string, ReadonlySet<string>>;
}): ReadonlySet<string> {
  const namespaceIds = input.namespaceIndex.get(input.query.filter.namespaceId) ?? new Set();
  const byEntity =
    input.query.entityId === undefined
      ? undefined
      : (input.entityIndex.get(input.query.entityId) ?? new Set());
  const byKind =
    input.query.relationKinds === undefined
      ? undefined
      : unionSets(
          input.query.relationKinds.map(
            (kind) =>
              input.kindIndex.get(relationLookupKey(input.query.filter.namespaceId, kind)) ??
              new Set<string>()
          )
        );

  return intersectSets(
    [namespaceIds, byEntity, byKind].filter((set): set is ReadonlySet<string> => set !== undefined)
  );
}

function entityNameKeys(entity: GraphEntityProposal): readonly string[] {
  const normalized = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])].map(
    normalizeIndexKey
  );
  const tokens = normalized.flatMap((value) => value.split(" ").filter(Boolean));
  return unique([...normalized, ...tokens]);
}

function entityLookupKey(namespaceId: string, nameKey: string): string {
  return `${namespaceId}\u0000${nameKey}`;
}

function relationLookupKey(namespaceId: string, relationKind: GraphRelationKind): string {
  return `${namespaceId}\u0000${relationKind}`;
}

function normalizeIndexKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertEvidencePruneSelector(request: GraphEvidencePruneRequest): void {
  if (
    hasNonBlankValues(request.documentIds) ||
    hasNonBlankValues(request.chunkIds) ||
    hasNonBlankValues(request.sourceIds)
  ) {
    return;
  }

  throw new Error("Graph evidence prune requires at least one documentId, chunkId, or sourceId.");
}

function hasNonBlankValues(values: readonly string[] | undefined): boolean {
  return values !== undefined && values.some((value) => value.trim().length > 0);
}

function factVisibleForPrune(
  fact: GraphEntityProposal | GraphRelationProposal,
  filter: IndexFilter
): boolean {
  return (
    fact.namespaceId === filter.namespaceId &&
    fact.accessScope.tenantId === filter.tenantId &&
    evaluateAccess(filter.principal, fact.accessScope).allowed
  );
}

function pruneEvidenceAnchors<
  T extends GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number]
>(
  evidence: readonly T[],
  request: GraphEvidencePruneRequest
): { readonly evidence: readonly T[]; readonly removedCount: number } {
  const remaining = evidence.filter((anchor) => !evidenceAnchorMatches(anchor, request));
  return {
    evidence: remaining,
    removedCount: evidence.length - remaining.length
  };
}

function evidenceAnchorMatches(
  anchor: GraphEntityProposal["evidence"][number] | GraphRelationProposal["evidence"][number],
  request: GraphEvidencePruneRequest
): boolean {
  return (
    valueMatches(anchor.documentId, request.documentIds) ||
    valueMatches(anchor.chunkId, request.chunkIds) ||
    valueMatches(anchor.sourceId, request.sourceIds)
  );
}

function valueMatches(value: string, candidates: readonly string[] | undefined): boolean {
  return candidates !== undefined && candidates.includes(value);
}

function addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(id);
  index.set(key, values);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const values = index.get(key);
  if (!values) {
    return;
  }
  values.delete(id);
  if (values.size === 0) {
    index.delete(key);
  }
}

function unionSets(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  const union = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      union.add(value);
    }
  }
  return union;
}

function intersectSets(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  if (sets.length === 0) {
    return new Set();
  }

  const [first, ...rest] = [...sets].sort((a, b) => a.size - b.size);
  const intersection = new Set<string>();
  for (const value of first ?? []) {
    if (rest.every((set) => set.has(value))) {
      intersection.add(value);
    }
  }
  return intersection;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}
