import type { IndexFilter } from "../indexing/index-types.js";
import type { GraphEntityProposal } from "./graph-types.js";
import type { GraphStore } from "./in-memory-graph-store.js";

export interface GraphEntityResolutionDecision {
  readonly canonicalEntityId: string;
  readonly duplicateEntityIds: readonly string[];
  readonly normalizedName: string;
  readonly reason: string;
}

export interface GraphEntityResolutionReviewCandidate {
  readonly entityIds: readonly string[];
  readonly normalizedNames: readonly string[];
  readonly score: number;
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
  readonly reviewCandidates: readonly GraphEntityResolutionReviewCandidate[];
  readonly reviewCandidateCount: number;
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
    const decisions: GraphEntityResolutionDecision[] = [];
    let rewiredRelationCount = 0;

    const identifierEntities = activeEntities(this.graphStore, request.filter);
    const identifierRegisteredTargets = registeredInTargetsByEntityId(
      identifierEntities,
      activeRelations(this.graphStore, request.filter)
    );
    for (const [identifierGroupKey, group] of groupBySharedIdentifier(identifierEntities)) {
      if (group.length < 2) {
        continue;
      }
      if (hasGroupRegisteredTargetConflict(group, identifierRegisteredTargets)) {
        continue;
      }
      rewiredRelationCount += this.mergeEntityGroup({
        filter: request.filter,
        group,
        normalizedName: resolutionGroupDisplayName(identifierGroupKey),
        decisions,
        reason: `Selected canonical entity from ${group.length} proposals with matching stable identifier ${resolutionGroupDisplayName(identifierGroupKey)}.`
      });
    }

    const entitiesAfterIdentifierMerges = activeEntities(this.graphStore, request.filter);
    const relationsAfterIdentifierMerges = activeRelations(this.graphStore, request.filter);
    const groups = groupByResolutionKey(
      entitiesAfterIdentifierMerges,
      registeredInTargetsByEntityId(entitiesAfterIdentifierMerges, relationsAfterIdentifierMerges)
    );

    for (const [resolutionGroupKey, group] of groups) {
      if (group.length < 2) {
        continue;
      }
      rewiredRelationCount += this.mergeEntityGroup({
        filter: request.filter,
        group,
        normalizedName: resolutionGroupDisplayName(resolutionGroupKey),
        decisions,
        reason: `Selected canonical entity from ${group.length} proposals with matching normalized name.`
      });
    }

    const entitiesAfterMerges = activeEntities(this.graphStore, request.filter);
    const reviewCandidates = fuzzyReviewCandidates(
      entitiesAfterMerges,
      registeredInTargetsByEntityId(
        entitiesAfterMerges,
        activeRelations(this.graphStore, request.filter)
      )
    );

    return {
      runId,
      resolvedAt,
      decisions,
      canonicalCount: decisions.length,
      duplicateCount: decisions.reduce(
        (total, decision) => total + decision.duplicateEntityIds.length,
        0
      ),
      rewiredRelationCount,
      reviewCandidates,
      reviewCandidateCount: reviewCandidates.length
    };
  }

  private mergeEntityGroup(options: {
    readonly filter: IndexFilter;
    readonly group: readonly GraphEntityProposal[];
    readonly normalizedName: string;
    readonly decisions: GraphEntityResolutionDecision[];
    readonly reason: string;
  }): number {
    const activeEntityIds = new Set(
      activeEntities(this.graphStore, options.filter).map((entity) => entity.id)
    );
    const group = options.group.filter((entity) => activeEntityIds.has(entity.id));
    if (group.length < 2) {
      return 0;
    }

    const canonical = chooseCanonical(group);
    const duplicateIds = group
      .filter((entity) => entity.id !== canonical.id)
      .map((entity) => entity.id)
      .sort();

    for (const duplicateId of duplicateIds) {
      this.graphStore.updateEntityStatus(duplicateId, "superseded");
    }

    let rewiredRelationCount = 0;
    for (const relation of activeRelations(this.graphStore, options.filter)) {
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

    options.decisions.push({
      canonicalEntityId: canonical.id,
      duplicateEntityIds: duplicateIds,
      normalizedName: options.normalizedName,
      reason: options.reason
    });

    return rewiredRelationCount;
  }
}

function activeEntities(
  graphStore: GraphStore,
  filter: IndexFilter
): readonly GraphEntityProposal[] {
  return graphStore
    .findEntities(filter)
    .filter((entity) => entity.status !== "rejected" && entity.status !== "superseded");
}

function activeRelations(
  graphStore: GraphStore,
  filter: IndexFilter
): ReturnType<GraphStore["findRelations"]> {
  return graphStore.findRelations({
    filter,
    includeUnapproved: true,
    limit: filter.limit ?? 1000
  });
}

function groupByResolutionKey(
  entities: readonly GraphEntityProposal[],
  registeredTargetsByEntityId: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly GraphEntityProposal[]> {
  const groups = new Map<string, GraphEntityProposal[]>();
  for (const entity of entities) {
    const normalizedName = normalizeEntityName(entity.normalizedName || entity.name);
    if (!normalizedName) {
      continue;
    }
    const registeredTargets = registeredTargetsByEntityId.get(entity.id) ?? [];
    const key =
      registeredTargets.length === 0
        ? normalizedName
        : `${normalizedName}|registered_in:${registeredTargets.join(",")}`;
    const kindScopedKey = `${entity.kind}:${key}`;
    groups.set(kindScopedKey, [...(groups.get(kindScopedKey) ?? []), entity]);
  }
  return groups;
}

function groupBySharedIdentifier(
  entities: readonly GraphEntityProposal[]
): ReadonlyMap<string, readonly GraphEntityProposal[]> {
  const groups = new Map<string, GraphEntityProposal[]>();
  for (const entity of entities) {
    for (const identifier of stableIdentifiers(entity)) {
      const kindScopedIdentifier = `${entity.kind}:${identifier}`;
      groups.set(kindScopedIdentifier, [...(groups.get(kindScopedIdentifier) ?? []), entity]);
    }
  }
  return groups;
}

function resolutionGroupDisplayName(kindScopedKey: string): string {
  const separatorIndex = kindScopedKey.indexOf(":");
  return separatorIndex < 0 ? kindScopedKey : kindScopedKey.slice(separatorIndex + 1);
}

function registeredInTargetsByEntityId(
  entities: readonly GraphEntityProposal[],
  relations: ReturnType<GraphStore["findRelations"]>
): ReadonlyMap<string, readonly string[]> {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const targetsByEntityId = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.relationKind !== "registered_in") {
      continue;
    }
    const target = entitiesById.get(relation.targetEntityId);
    if (!target) {
      continue;
    }
    const normalizedTarget = normalizeEntityName(target.normalizedName || target.name);
    if (!normalizedTarget) {
      continue;
    }
    const targets = targetsByEntityId.get(relation.sourceEntityId) ?? new Set<string>();
    targets.add(normalizedTarget);
    targetsByEntityId.set(relation.sourceEntityId, targets);
  }
  return new Map(
    [...targetsByEntityId.entries()].map(([entityId, targets]) => [entityId, [...targets].sort()])
  );
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

function fuzzyReviewCandidates(
  entities: readonly GraphEntityProposal[],
  registeredTargetsByEntityId: ReadonlyMap<string, readonly string[]>
): readonly GraphEntityResolutionReviewCandidate[] {
  const candidates: GraphEntityResolutionReviewCandidate[] = [];
  const seen = new Set<string>();
  const sortedEntities = [...entities].sort((first, second) => first.id.localeCompare(second.id));

  for (let firstIndex = 0; firstIndex < sortedEntities.length; firstIndex += 1) {
    const first = sortedEntities[firstIndex];
    if (first === undefined) {
      continue;
    }
    for (let secondIndex = firstIndex + 1; secondIndex < sortedEntities.length; secondIndex += 1) {
      const second = sortedEntities[secondIndex];
      if (second === undefined || first.kind !== second.kind) {
        continue;
      }
      const score = entityNameSimilarityScore(first, second);
      if (score < 0.55) {
        continue;
      }

      const registeredConflict = hasConflictingRegisteredTargets(
        first.id,
        second.id,
        registeredTargetsByEntityId
      );
      const firstName = normalizeEntityName(first.normalizedName || first.name);
      const secondName = normalizeEntityName(second.normalizedName || second.name);
      const materialExtras = materialExtraTokens(firstName, secondName);
      if (materialExtras.length === 0 && score < 0.82 && !registeredConflict) {
        continue;
      }

      const entityIds = [first.id, second.id].sort();
      const key = entityIds.join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      candidates.push({
        entityIds,
        normalizedNames: [firstName, secondName].sort(),
        score,
        reason: reviewReason({ score, materialExtras, registeredConflict })
      });
    }
  }

  return candidates.sort((first, second) => {
    if (second.score !== first.score) {
      return second.score - first.score;
    }
    return first.entityIds.join("|").localeCompare(second.entityIds.join("|"));
  });
}

function stableIdentifiers(entity: GraphEntityProposal): readonly string[] {
  const metadata = entity.metadata ?? {};
  const identifiers: string[] = [];
  for (const key of STABLE_IDENTIFIER_METADATA_KEYS) {
    const value = metadata[key];
    if (value === undefined || typeof value === "boolean") {
      continue;
    }
    const canonicalKey = canonicalIdentifierKey(key);
    const normalizedValue = normalizeIdentifierValue(canonicalKey, String(value));
    if (!normalizedValue) {
      continue;
    }
    identifiers.push(`${canonicalKey}:${normalizedValue}`);
  }
  return [...new Set(identifiers)].sort();
}

function entityNameSimilarityScore(
  first: GraphEntityProposal,
  second: GraphEntityProposal
): number {
  const firstNames = entityNameVariants(first);
  const secondNames = entityNameVariants(second);
  let bestScore = 0;

  for (const firstName of firstNames) {
    for (const secondName of secondNames) {
      bestScore = Math.max(bestScore, normalizedNameSimilarityScore(firstName, secondName));
    }
  }

  return Number(bestScore.toFixed(3));
}

function entityNameVariants(entity: GraphEntityProposal): readonly string[] {
  const variants = [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
    .map(normalizeEntityName)
    .filter((value) => value.length > 0);
  return [...new Set(variants)];
}

function normalizedNameSimilarityScore(firstName: string, secondName: string): number {
  if (firstName === secondName) {
    return 1;
  }

  const firstTokens = tokenSet(firstName);
  const secondTokens = tokenSet(secondName);
  const shared = intersectionSize(firstTokens, secondTokens);
  if (shared === 0) {
    return 0;
  }

  const union = new Set([...firstTokens, ...secondTokens]).size;
  const jaccard = shared / union;
  const containment = shared / Math.min(firstTokens.size, secondTokens.size);
  const prefixBonus =
    firstName.startsWith(`${secondName} `) || secondName.startsWith(`${firstName} `) ? 0.08 : 0;

  return Math.min(1, Math.max(jaccard, containment * 0.72 + prefixBonus));
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
  );
}

function intersectionSize(
  firstTokens: ReadonlySet<string>,
  secondTokens: ReadonlySet<string>
): number {
  let shared = 0;
  for (const token of firstTokens) {
    if (secondTokens.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

function materialExtraTokens(firstName: string, secondName: string): readonly string[] {
  const firstTokens = tokenSet(firstName);
  const secondTokens = tokenSet(secondName);
  const extras = new Set<string>();

  for (const token of firstTokens) {
    if (!secondTokens.has(token) && MATERIAL_ENTITY_QUALIFIER_TOKENS.has(token)) {
      extras.add(token);
    }
  }
  for (const token of secondTokens) {
    if (!firstTokens.has(token) && MATERIAL_ENTITY_QUALIFIER_TOKENS.has(token)) {
      extras.add(token);
    }
  }

  return [...extras].sort();
}

function hasConflictingRegisteredTargets(
  firstEntityId: string,
  secondEntityId: string,
  registeredTargetsByEntityId: ReadonlyMap<string, readonly string[]>
): boolean {
  const firstTargets = registeredTargetsByEntityId.get(firstEntityId) ?? [];
  const secondTargets = registeredTargetsByEntityId.get(secondEntityId) ?? [];
  if (firstTargets.length === 0 || secondTargets.length === 0) {
    return false;
  }
  return firstTargets.some((target) => !secondTargets.includes(target));
}

function hasGroupRegisteredTargetConflict(
  entities: readonly GraphEntityProposal[],
  registeredTargetsByEntityId: ReadonlyMap<string, readonly string[]>
): boolean {
  const populatedTargetSets = entities
    .map((entity) => registeredTargetsByEntityId.get(entity.id) ?? [])
    .filter((targets) => targets.length > 0)
    .map((targets) => targets.join("|"));
  return new Set(populatedTargetSets).size > 1;
}

function reviewReason(options: {
  readonly score: number;
  readonly materialExtras: readonly string[];
  readonly registeredConflict: boolean;
}): string {
  const parts = [`Name similarity score ${options.score} needs review before merge.`];
  if (options.materialExtras.length > 0) {
    parts.push(`Material qualifier tokens differ: ${options.materialExtras.join(", ")}.`);
  }
  if (options.registeredConflict) {
    parts.push("Registered jurisdiction evidence conflicts.");
  }
  return parts.join(" ");
}

function canonicalIdentifierKey(key: (typeof STABLE_IDENTIFIER_METADATA_KEYS)[number]): string {
  switch (key) {
    case "website":
      return "domain";
    case "taxId":
      return "tax_id";
    case "registryId":
      return "registry_id";
    default:
      return key;
  }
}

function normalizeIdentifierValue(identifierKey: string, value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "")
    .trim();

  if (identifierKey === "domain") {
    return normalized.split(/[/?#]/u)[0] ?? "";
  }
  if (identifierKey === "cik") {
    return normalized.replace(/^0+(?=\d)/u, "");
  }
  return normalized;
}

export function normalizeEntityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘']/g, "")
    .replace(/[.,]/g, " ")
    .replace(
      /\b(limited liability company|llc|l l c|incorporated|inc|corp|corporation|ltd|limited|gmbh|plc|lp|llp)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

const STABLE_IDENTIFIER_METADATA_KEYS = [
  "cik",
  "lei",
  "ticker",
  "domain",
  "website",
  "duns",
  "ein",
  "taxId",
  "tax_id",
  "registryId",
  "registry_id"
] as const;

const MATERIAL_ENTITY_QUALIFIER_TOKENS = new Set([
  "bank",
  "capital",
  "energy",
  "financial",
  "finance",
  "global",
  "group",
  "health",
  "hospitality",
  "insurance",
  "medical",
  "online",
  "partners",
  "properties",
  "realty",
  "reit",
  "research",
  "systems",
  "technologies",
  "trust"
]);
