import type {
  GraphEntityKind,
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";

export interface ExpectedGraphEntity {
  readonly id?: string;
  readonly kind?: GraphEntityKind;
  readonly name: string;
  readonly normalizedName?: string;
  readonly aliases?: readonly string[];
}

export interface ExpectedGraphRelation {
  readonly id?: string;
  readonly relationKind: GraphRelationKind;
  readonly sourceEntityId?: string;
  readonly targetEntityId?: string;
  readonly sourceName?: string;
  readonly targetName?: string;
}

export interface ForbiddenGraphRelation {
  readonly relationKind?: GraphRelationKind;
  readonly sourceEntityId?: string;
  readonly targetEntityId?: string;
  readonly sourceName?: string;
  readonly targetName?: string;
}

export interface GraphRecallThresholds {
  readonly minimumEntityRecall?: number;
  readonly minimumRelationRecall?: number;
  readonly maximumExtraEntities?: number;
  readonly maximumExtraRelations?: number;
  readonly maximumForbiddenRelations?: number;
}

export interface GraphRecallIssue {
  readonly code:
    | "entity_recall_below_threshold"
    | "relation_recall_below_threshold"
    | "extra_entities_above_threshold"
    | "extra_relations_above_threshold"
    | "forbidden_relations_present";
  readonly message: string;
  readonly expectedEntity?: ExpectedGraphEntity;
  readonly expectedRelation?: ExpectedGraphRelation;
  readonly actualEntityId?: string;
  readonly actualRelationId?: string;
}

export interface GraphRecallResult {
  readonly passed: boolean;
  readonly expectedEntityCount: number;
  readonly expectedRelationCount: number;
  readonly matchedEntityCount: number;
  readonly matchedRelationCount: number;
  readonly entityRecall: number;
  readonly relationRecall: number;
  readonly missingEntities: readonly ExpectedGraphEntity[];
  readonly missingRelations: readonly ExpectedGraphRelation[];
  readonly extraEntities: readonly GraphEntityProposal[];
  readonly extraRelations: readonly GraphRelationProposal[];
  readonly forbiddenRelations: readonly GraphRelationProposal[];
  readonly issues: readonly GraphRecallIssue[];
}

export interface GraphRecallInput {
  readonly batch: GraphExtractionBatch;
  readonly expectedEntities: readonly ExpectedGraphEntity[];
  readonly expectedRelations: readonly ExpectedGraphRelation[];
  readonly forbiddenRelations?: readonly ForbiddenGraphRelation[];
  readonly thresholds?: GraphRecallThresholds;
}

export function checkGraphRecall(input: GraphRecallInput): GraphRecallResult {
  const thresholds = {
    minimumEntityRecall: 1,
    minimumRelationRecall: 1,
    maximumExtraEntities: 0,
    maximumExtraRelations: 0,
    maximumForbiddenRelations: 0,
    ...(input.thresholds ?? {})
  };
  const actualEntitiesById = new Map(input.batch.entities.map((entity) => [entity.id, entity]));
  const matchedEntities = input.expectedEntities.filter((expected) =>
    input.batch.entities.some((actual) => entityMatches(expected, actual))
  );
  const matchedRelations = input.expectedRelations.filter((expected) =>
    input.batch.relations.some((actual) =>
      relationMatches({
        expected,
        expectedEntities: input.expectedEntities,
        actual,
        actualEntitiesById
      })
    )
  );
  const extraEntities = input.batch.entities.filter(
    (actual) => !input.expectedEntities.some((expected) => entityMatches(expected, actual))
  );
  const extraRelations = input.batch.relations.filter(
    (actual) =>
      !input.expectedRelations.some((expected) =>
        relationMatches({
          expected,
          expectedEntities: input.expectedEntities,
          actual,
          actualEntitiesById
        })
      )
  );
  const forbiddenRelations = input.batch.relations.filter((actual) =>
    (input.forbiddenRelations ?? []).some((forbidden) =>
      forbiddenRelationMatches(forbidden, actual, actualEntitiesById)
    )
  );
  const missingEntities = input.expectedEntities.filter(
    (expected) => !matchedEntities.includes(expected)
  );
  const missingRelations = input.expectedRelations.filter(
    (expected) => !matchedRelations.includes(expected)
  );
  const entityRecall = recall(matchedEntities.length, input.expectedEntities.length);
  const relationRecall = recall(matchedRelations.length, input.expectedRelations.length);
  const issues: GraphRecallIssue[] = [];

  if (entityRecall < thresholds.minimumEntityRecall) {
    issues.push({
      code: "entity_recall_below_threshold",
      message: `Entity recall ${formatRatio(entityRecall)} was below ${formatRatio(thresholds.minimumEntityRecall)}.`
    });
  }
  if (relationRecall < thresholds.minimumRelationRecall) {
    issues.push({
      code: "relation_recall_below_threshold",
      message: `Relation recall ${formatRatio(relationRecall)} was below ${formatRatio(thresholds.minimumRelationRecall)}.`
    });
  }
  if (extraEntities.length > thresholds.maximumExtraEntities) {
    issues.push({
      code: "extra_entities_above_threshold",
      message: `Found ${extraEntities.length} extra graph entities; maximum allowed is ${thresholds.maximumExtraEntities}.`
    });
  }
  if (extraRelations.length > thresholds.maximumExtraRelations) {
    issues.push({
      code: "extra_relations_above_threshold",
      message: `Found ${extraRelations.length} extra graph relations; maximum allowed is ${thresholds.maximumExtraRelations}.`
    });
  }
  if (forbiddenRelations.length > thresholds.maximumForbiddenRelations) {
    issues.push({
      code: "forbidden_relations_present",
      message: `Found ${forbiddenRelations.length} forbidden graph relations; maximum allowed is ${thresholds.maximumForbiddenRelations}.`
    });
  }

  return {
    passed: issues.length === 0,
    expectedEntityCount: input.expectedEntities.length,
    expectedRelationCount: input.expectedRelations.length,
    matchedEntityCount: matchedEntities.length,
    matchedRelationCount: matchedRelations.length,
    entityRecall,
    relationRecall,
    missingEntities,
    missingRelations,
    extraEntities,
    extraRelations,
    forbiddenRelations,
    issues
  };
}

function entityMatches(expected: ExpectedGraphEntity, actual: GraphEntityProposal): boolean {
  if (expected.id !== undefined && expected.id === actual.id) {
    return true;
  }
  if (expected.kind !== undefined && expected.kind !== actual.kind) {
    return false;
  }
  return namesIntersect(entityNames(expected), entityNames(actual));
}

function relationMatches(input: {
  readonly expected: ExpectedGraphRelation;
  readonly expectedEntities: readonly ExpectedGraphEntity[];
  readonly actual: GraphRelationProposal;
  readonly actualEntitiesById: ReadonlyMap<string, GraphEntityProposal>;
}): boolean {
  if (input.expected.id !== undefined && input.expected.id === input.actual.id) {
    return true;
  }
  if (input.expected.relationKind !== input.actual.relationKind) {
    return false;
  }
  return (
    endpointMatches({
      ...(input.expected.sourceEntityId === undefined
        ? {}
        : { expectedEntityId: input.expected.sourceEntityId }),
      ...(input.expected.sourceName === undefined
        ? {}
        : { expectedName: input.expected.sourceName }),
      expectedEntities: input.expectedEntities,
      actualEntityId: input.actual.sourceEntityId,
      actualEntitiesById: input.actualEntitiesById
    }) &&
    endpointMatches({
      ...(input.expected.targetEntityId === undefined
        ? {}
        : { expectedEntityId: input.expected.targetEntityId }),
      ...(input.expected.targetName === undefined
        ? {}
        : { expectedName: input.expected.targetName }),
      expectedEntities: input.expectedEntities,
      actualEntityId: input.actual.targetEntityId,
      actualEntitiesById: input.actualEntitiesById
    })
  );
}

function forbiddenRelationMatches(
  expected: ForbiddenGraphRelation,
  actual: GraphRelationProposal,
  actualEntitiesById: ReadonlyMap<string, GraphEntityProposal>
): boolean {
  const sourceEntity = actualEntitiesById.get(actual.sourceEntityId);
  const targetEntity = actualEntitiesById.get(actual.targetEntityId);
  return (
    (expected.relationKind === undefined || expected.relationKind === actual.relationKind) &&
    (expected.sourceEntityId === undefined || expected.sourceEntityId === actual.sourceEntityId) &&
    (expected.targetEntityId === undefined || expected.targetEntityId === actual.targetEntityId) &&
    (expected.sourceName === undefined ||
      (sourceEntity !== undefined &&
        entityNames(sourceEntity).some(
          (name) => name === normalizeName(expected.sourceName ?? "")
        ))) &&
    (expected.targetName === undefined ||
      (targetEntity !== undefined &&
        entityNames(targetEntity).some(
          (name) => name === normalizeName(expected.targetName ?? "")
        )))
  );
}

function endpointMatches(input: {
  readonly expectedEntityId?: string;
  readonly expectedName?: string;
  readonly expectedEntities: readonly ExpectedGraphEntity[];
  readonly actualEntityId: string;
  readonly actualEntitiesById: ReadonlyMap<string, GraphEntityProposal>;
}): boolean {
  const actualEntity = input.actualEntitiesById.get(input.actualEntityId);
  if (!actualEntity) {
    return false;
  }
  if (input.expectedEntityId !== undefined) {
    if (input.expectedEntityId === input.actualEntityId) {
      return true;
    }
    const expectedEntity = input.expectedEntities.find(
      (entity) => entity.id === input.expectedEntityId
    );
    return expectedEntity !== undefined && entityMatches(expectedEntity, actualEntity);
  }
  if (input.expectedName !== undefined) {
    return entityNames(actualEntity).some(
      (name) => name === normalizeName(input.expectedName ?? "")
    );
  }
  return false;
}

function entityNames(entity: ExpectedGraphEntity | GraphEntityProposal): readonly string[] {
  return unique(
    [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
      .filter((value): value is string => value !== undefined)
      .map(normalizeName)
      .filter(Boolean)
  );
}

function namesIntersect(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[’‘]/gu, "'")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function recall(matchedCount: number, expectedCount: number): number {
  return expectedCount === 0 ? 1 : matchedCount / expectedCount;
}

function formatRatio(value: number): string {
  return value.toFixed(3);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
