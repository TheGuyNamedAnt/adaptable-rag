import type { IndexFilter } from "../indexing/index-types.js";
import type { GraphEntityProposal, GraphRelationProposal } from "./graph-types.js";
import type { GraphStore } from "./in-memory-graph-store.js";
import type {
  RagGraphEntity,
  RagGraphMatch,
  RagGraphNeighbor,
  RagGraphNeighborQuery,
  RagGraphRelationship,
  RagGraphStore
} from "./graph-store.js";

export class ProposalBackedRagGraphStore implements RagGraphStore {
  private readonly proposalStore: GraphStore;

  constructor(proposalStore: GraphStore) {
    this.proposalStore = proposalStore;
  }

  upsertEntity(_entity: RagGraphEntity): void {
    throw new Error("Proposal-backed graph stores are populated through graph extraction batches.");
  }

  upsertRelationship(_relationship: RagGraphRelationship): void {
    throw new Error("Proposal-backed graph stores are populated through graph extraction batches.");
  }

  findEntities(
    queryTerms: readonly string[],
    limit: number,
    filter?: IndexFilter
  ): readonly RagGraphMatch[] {
    if (!filter || limit < 1) {
      return [];
    }

    const terms = queryTerms.map(normalize).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }

    return this.proposalStore
      .findEntities(filter)
      .filter(isRetrievalVisibleEntity)
      .map((entity) => scoreEntity(entity, terms))
      .filter((match): match is RagGraphMatch => match !== undefined)
      .sort((first, second) => {
        if (second.score !== first.score) {
          return second.score - first.score;
        }
        return first.entity.id.localeCompare(second.entity.id);
      })
      .slice(0, limit);
  }

  getOneHopNeighbors(
    entityId: string,
    limit: number,
    filter?: IndexFilter,
    query: RagGraphNeighborQuery = {}
  ): readonly RagGraphNeighbor[] {
    if (!filter || limit < 1) {
      return [];
    }

    const entitiesById = new Map(
      this.proposalStore
        .findEntities(filter)
        .filter(isRetrievalVisibleEntity)
        .map((entity) => [entity.id, entity] as const)
    );
    if (!entitiesById.has(entityId)) {
      return [];
    }

    const relationKinds = query.relationKinds;
    const direction = query.direction ?? "any";
    return this.proposalStore
      .findRelations({
        filter,
        entityId,
        limit,
        ...(relationKinds === undefined ? {} : { relationKinds })
      })
      .filter((relationship) => relationDirectionMatches(relationship, entityId, direction))
      .flatMap((relationship) => {
        const neighborEntityId =
          relationship.sourceEntityId === entityId
            ? relationship.targetEntityId
            : relationship.sourceEntityId;
        const entity = entitiesById.get(neighborEntityId);
        if (!entity) {
          return [];
        }
        return [
          {
            entity: toRagEntity(entity),
            relationship: toRagRelationship(relationship),
            distance: 1 as const
          }
        ];
      })
      .slice(0, limit);
  }
}

function relationDirectionMatches(
  relationship: GraphRelationProposal,
  entityId: string,
  direction: NonNullable<RagGraphNeighborQuery["direction"]>
): boolean {
  if (direction === "outgoing") {
    return relationship.sourceEntityId === entityId;
  }

  if (direction === "incoming") {
    return relationship.targetEntityId === entityId;
  }

  return relationship.sourceEntityId === entityId || relationship.targetEntityId === entityId;
}

function isRetrievalVisibleEntity(entity: GraphEntityProposal): boolean {
  return entity.status === "approved" || entity.status === "verified";
}

function scoreEntity(
  entity: GraphEntityProposal,
  terms: readonly string[]
): RagGraphMatch | undefined {
  const haystack = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
    .join("\n")
    .toLowerCase();
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  if (matchedTerms.length === 0) {
    return undefined;
  }

  return {
    entity: toRagEntity(entity),
    score: Math.round((matchedTerms.length / terms.length) * 1000) / 1000,
    matchedTerms
  };
}

function toRagEntity(entity: GraphEntityProposal): RagGraphEntity {
  return {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases ?? [],
    summary: entity.kind,
    chunkIds: unique(entity.evidence.map((anchor) => anchor.chunkId))
  };
}

function toRagRelationship(relationship: GraphRelationProposal): RagGraphRelationship {
  return {
    id: relationship.id,
    fromEntityId: relationship.sourceEntityId,
    toEntityId: relationship.targetEntityId,
    type: relationship.relationKind,
    summary: relationship.factStrength,
    highLevelKeywords: unique([
      relationship.relationKind,
      relationship.factStrength,
      relationship.verificationStatus
    ]),
    chunkIds: unique(relationship.evidence.map((anchor) => anchor.chunkId))
  };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}
