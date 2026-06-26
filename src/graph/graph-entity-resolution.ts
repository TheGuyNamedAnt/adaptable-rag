import type { IndexFilter } from "../indexing/index-types.js";
import type { GraphEntityProposal } from "./graph-types.js";
import type { GraphStore } from "./in-memory-graph-store.js";

export interface GraphEntityResolutionDecision {
  readonly canonicalEntityId: string;
  readonly duplicateEntityIds: readonly string[];
  readonly normalizedName: string;
  readonly reason: string;
}

export interface GraphEntityResolutionRunRequest {
  readonly filter: IndexFilter;
  readonly runId?: string;
  readonly requestedAt?: string;
}

export interface GraphEntityResolutionRunResult {
  readonly runId: string;
  readonly resolvedAt: string;
  readonly decisions: readonly GraphEntityResolutionDecision[];
  readonly canonicalCount: number;
  readonly duplicateCount: number;
  readonly rewiredRelationCount: number;
}

export class GraphEntityResolutionRunner {
  private readonly graphStore: GraphStore;
  private readonly now: () => string;

  constructor(options: { readonly graphStore: GraphStore; readonly now?: () => string }) {
    this.graphStore = options.graphStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  resolve(request: GraphEntityResolutionRunRequest): GraphEntityResolutionRunResult {
    const resolvedAt = request.requestedAt ?? this.now();
    const runId =
      request.runId ?? `graph_entity_resolution_${resolvedAt.replace(/[^0-9a-z]/gi, "")}`;
    const entities = this.graphStore
      .findEntities(request.filter)
      .filter((entity) => entity.status !== "rejected" && entity.status !== "superseded");
    const groups = groupByResolutionKey(entities);
    const decisions: GraphEntityResolutionDecision[] = [];
    let rewiredRelationCount = 0;

    for (const [normalizedName, group] of groups) {
      if (group.length < 2) {
        continue;
      }

      const canonical = chooseCanonical(group);
      const duplicateIds = group
        .filter((entity) => entity.id !== canonical.id)
        .map((entity) => entity.id)
        .sort();

      for (const duplicateId of duplicateIds) {
        this.graphStore.updateEntityStatus(duplicateId, "superseded");
      }

      const relations = this.graphStore.findRelations({
        filter: request.filter,
        includeUnapproved: true,
        limit: request.filter.limit ?? 1000
      });
      for (const relation of relations) {
        const nextSource = duplicateIds.includes(relation.sourceEntityId)
          ? canonical.id
          : relation.sourceEntityId;
        const nextTarget = duplicateIds.includes(relation.targetEntityId)
          ? canonical.id
          : relation.targetEntityId;
        if (nextSource === relation.sourceEntityId && nextTarget === relation.targetEntityId) {
          continue;
        }
        this.graphStore.updateRelationEndpoints(relation.id, {
          sourceEntityId: nextSource,
          targetEntityId: nextTarget
        });
        rewiredRelationCount += 1;
      }

      decisions.push({
        canonicalEntityId: canonical.id,
        duplicateEntityIds: duplicateIds,
        normalizedName,
        reason: `Selected ${canonical.id} as canonical for ${group.length} entity proposals with matching normalized name.`
      });
    }

    return {
      runId,
      resolvedAt,
      decisions,
      canonicalCount: decisions.length,
      duplicateCount: decisions.reduce(
        (total, decision) => total + decision.duplicateEntityIds.length,
        0
      ),
      rewiredRelationCount
    };
  }
}

function groupByResolutionKey(
  entities: readonly GraphEntityProposal[]
): ReadonlyMap<string, readonly GraphEntityProposal[]> {
  const groups = new Map<string, GraphEntityProposal[]>();
  for (const entity of entities) {
    const key = normalizeEntityName(entity.normalizedName || entity.name);
    if (!key) {
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), entity]);
  }
  return groups;
}

function chooseCanonical(entities: readonly GraphEntityProposal[]): GraphEntityProposal {
  return [...entities].sort((first, second) => {
    if (second.confidence !== first.confidence) {
      return second.confidence - first.confidence;
    }
    if (second.evidence.length !== first.evidence.length) {
      return second.evidence.length - first.evidence.length;
    }
    return first.id.localeCompare(second.id);
  })[0] as GraphEntityProposal;
}

export function normalizeEntityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(
      /\b(limited liability company|llc|l l c|incorporated|inc|corp|corporation|ltd|limited|gmbh|plc|lp|llp)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}
