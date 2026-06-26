import type { IndexFilter } from "../indexing/index-types.js";

export interface RagGraphEntity {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly chunkIds: readonly string[];
}

export interface RagGraphRelationship {
  readonly id: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly type: string;
  readonly summary?: string;
  readonly highLevelKeywords?: readonly string[];
  readonly chunkIds: readonly string[];
}

export interface RagGraphMatch {
  readonly entity: RagGraphEntity;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface RagGraphNeighbor {
  readonly entity: RagGraphEntity;
  readonly relationship: RagGraphRelationship;
  readonly distance: 1;
}

export type RagGraphTraversalDirection = "any" | "outgoing" | "incoming";

export interface RagGraphNeighborQuery {
  readonly relationKinds?: readonly string[];
  readonly direction?: RagGraphTraversalDirection;
}

export interface RagGraphStore {
  upsertEntity(entity: RagGraphEntity): void;
  upsertRelationship(relationship: RagGraphRelationship): void;
  findEntities(
    queryTerms: readonly string[],
    limit: number,
    filter?: IndexFilter
  ): readonly RagGraphMatch[];
  getOneHopNeighbors(
    entityId: string,
    limit: number,
    filter?: IndexFilter,
    query?: RagGraphNeighborQuery
  ): readonly RagGraphNeighbor[];
}

export class InMemoryRagGraphStore implements RagGraphStore {
  private readonly entities = new Map<string, RagGraphEntity>();
  private readonly relationships = new Map<string, RagGraphRelationship>();

  upsertEntity(entity: RagGraphEntity): void {
    validateEntity(entity);
    this.entities.set(entity.id, {
      ...entity,
      aliases: entity.aliases ?? [],
      chunkIds: unique(entity.chunkIds)
    });
  }

  upsertRelationship(relationship: RagGraphRelationship): void {
    validateRelationship(relationship);
    this.relationships.set(relationship.id, {
      ...relationship,
      highLevelKeywords: relationship.highLevelKeywords ?? [],
      chunkIds: unique(relationship.chunkIds)
    });
  }

  findEntities(
    queryTerms: readonly string[],
    limit: number,
    _filter?: IndexFilter
  ): readonly RagGraphMatch[] {
    const terms = queryTerms.map(normalize).filter(Boolean);
    if (terms.length === 0 || limit < 1) {
      return [];
    }

    return [...this.entities.values()]
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
    _filter?: IndexFilter,
    query: RagGraphNeighborQuery = {}
  ): readonly RagGraphNeighbor[] {
    if (!this.entities.has(entityId) || limit < 1) {
      return [];
    }

    const direction = query.direction ?? "any";
    const relationKinds =
      query.relationKinds === undefined ? undefined : new Set(query.relationKinds.map(normalize));

    return [...this.relationships.values()]
      .flatMap((relationship) => {
        if (relationKinds !== undefined && !relationKinds.has(normalize(relationship.type))) {
          return [];
        }

        if (relationship.fromEntityId === entityId && direction !== "incoming") {
          const entity = this.entities.get(relationship.toEntityId);
          return entity ? [{ entity, relationship, distance: 1 as const }] : [];
        }
        if (relationship.toEntityId === entityId && direction !== "outgoing") {
          const entity = this.entities.get(relationship.fromEntityId);
          return entity ? [{ entity, relationship, distance: 1 as const }] : [];
        }
        return [];
      })
      .slice(0, limit);
  }
}

function scoreEntity(entity: RagGraphEntity, terms: readonly string[]): RagGraphMatch | undefined {
  const haystack = [entity.name, ...(entity.aliases ?? []), entity.summary ?? ""]
    .join("\n")
    .toLowerCase();
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  if (matchedTerms.length === 0) {
    return undefined;
  }

  return {
    entity,
    score: Math.round((matchedTerms.length / terms.length) * 1000) / 1000,
    matchedTerms
  };
}

function validateEntity(entity: RagGraphEntity): void {
  if (!entity.id.trim() || !entity.name.trim()) {
    throw new Error("Graph entity id and name are required.");
  }
}

function validateRelationship(relationship: RagGraphRelationship): void {
  if (
    !relationship.id.trim() ||
    !relationship.fromEntityId.trim() ||
    !relationship.toEntityId.trim() ||
    !relationship.type.trim()
  ) {
    throw new Error("Graph relationship id, endpoints, and type are required.");
  }
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}
