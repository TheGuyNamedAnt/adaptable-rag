import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import {
  buildGraphExtractionTrace,
  runGraphExtractor,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "../graph/graph-extractor.js";
import type {
  GraphEntityProposal,
  GraphExtractionBatch,
  GraphRelationProposal
} from "../graph/graph-types.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import {
  buildLocalEvalKnowledgeMapBatch,
  type LocalEvalKnowledgeMapEntityFixture,
  type LocalEvalKnowledgeMapRelationFixture
} from "../runtime/eval-knowledge-map.js";
import type { RagEvalExtractionFixture, RagEvalRelationshipEdgeExpectation } from "./eval-types.js";

export interface RunEvalExtractionQualityRequest {
  readonly profile: ValidatedRagProfile;
  readonly fixture: RagEvalExtractionFixture;
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly runId: string;
  readonly sourceLabel?: string;
  readonly now: () => string;
}

export interface EvalExtractionQualityResult {
  readonly extraction?: GraphExtractionResult;
  readonly failures: readonly string[];
}

export async function runEvalExtractionQuality(
  request: RunEvalExtractionQualityRequest
): Promise<EvalExtractionQualityResult> {
  const actualEntities = request.fixture.actualEntities ?? request.fixture.expectedEntities;
  const actualRelations = request.fixture.actualRelations ?? request.fixture.expectedRelations;
  const batch = buildLocalEvalKnowledgeMapBatch({
    profile: request.profile,
    fixture: {
      ...(request.fixture.ontology ? { ontology: request.fixture.ontology } : {}),
      entities: actualEntities,
      relations: actualRelations
    },
    chunks: request.chunks,
    now: request.now,
    ...(request.sourceLabel ? { sourceLabel: request.sourceLabel } : {})
  });
  const extraction = await runGraphExtractor(
    new StaticEvalGraphExtractor(batch, request.now),
    {
      profile: request.profile,
      ontology: batch.ontology,
      documents: request.documents,
      chunks: request.chunks,
      extractionId: request.runId,
      requestedAt: request.now()
    },
    { now: request.now }
  );

  if (extraction.status === "failed") {
    return {
      extraction,
      failures: [
        `extraction_quality expected extraction succeeded, got "${extraction.failure.code}".`
      ]
    };
  }

  return {
    extraction,
    failures: scoreExtractionBatch(request.fixture, extraction.batch)
  };
}

function scoreExtractionBatch(
  fixture: RagEvalExtractionFixture,
  batch: GraphExtractionBatch
): readonly string[] {
  const failures: string[] = [];
  const expectedEntities = fixture.expectedEntities;
  const expectedRelations = fixture.expectedRelations;
  const matchedExpectedEntities = expectedEntities.filter((expected) =>
    batch.entities.some((actual) => entityMatches(expected, actual))
  );
  const matchedExpectedRelations = expectedRelations.filter((expected) =>
    batch.relations.some((actual) =>
      relationMatches(expected, fixture.expectedEntities, actual, batch.entities)
    )
  );
  const extraEntities = batch.entities.filter(
    (actual) => !expectedEntities.some((expected) => entityMatches(expected, actual))
  );
  const extraRelations = batch.relations.filter(
    (actual) =>
      !expectedRelations.some((expected) =>
        relationMatches(expected, fixture.expectedEntities, actual, batch.entities)
      )
  );
  const forbiddenRelations = (fixture.forbiddenRelations ?? []).flatMap((forbidden) =>
    batch.relations.filter((actual) => relationMatchesForbidden(forbidden, actual, batch.entities))
  );
  const entityRecall = recall(matchedExpectedEntities.length, expectedEntities.length);
  const relationRecall = recall(matchedExpectedRelations.length, expectedRelations.length);
  const minimumEntityRecall = fixture.minimumEntityRecall ?? 1;
  const minimumRelationRecall = fixture.minimumRelationRecall ?? 1;
  const maximumExtraEntities = fixture.maximumExtraEntities ?? 0;
  const maximumExtraRelations = fixture.maximumExtraRelations ?? 0;

  if (entityRecall < minimumEntityRecall) {
    failures.push(
      `extraction_quality entity recall ${formatRatio(entityRecall)} was below ${formatRatio(
        minimumEntityRecall
      )}; missing ${missingEntityLabels(expectedEntities, matchedExpectedEntities).join(", ")}.`
    );
  }

  if (relationRecall < minimumRelationRecall) {
    failures.push(
      `extraction_quality relation recall ${formatRatio(relationRecall)} was below ${formatRatio(
        minimumRelationRecall
      )}; missing ${missingRelationLabels(expectedRelations, matchedExpectedRelations).join(", ")}.`
    );
  }

  if (extraEntities.length > maximumExtraEntities) {
    failures.push(
      `extraction_quality found ${extraEntities.length} extra entit${
        extraEntities.length === 1 ? "y" : "ies"
      }: ${extraEntities.map(entityLabel).join(", ")}.`
    );
  }

  if (extraRelations.length > maximumExtraRelations) {
    failures.push(
      `extraction_quality found ${extraRelations.length} extra relation${
        extraRelations.length === 1 ? "" : "s"
      }: ${extraRelations.map((relation) => relationLabel(relation, batch.entities)).join(", ")}.`
    );
  }

  if (forbiddenRelations.length > 0) {
    failures.push(
      `extraction_quality extracted forbidden relation${
        forbiddenRelations.length === 1 ? "" : "s"
      }: ${forbiddenRelations
        .map((relation) => relationLabel(relation, batch.entities))
        .join(", ")}.`
    );
  }

  return failures;
}

class StaticEvalGraphExtractor implements GraphExtractor {
  readonly id = "static-eval-extraction-quality-extractor";
  readonly supportedOntologyIds: readonly string[];

  constructor(
    private readonly batch: GraphExtractionBatch,
    private readonly now: () => string
  ) {
    this.supportedOntologyIds = [batch.ontology.id];
  }

  async extract(request: GraphExtractionRequest): Promise<GraphExtractionResult> {
    const startedAt = request.requestedAt ?? this.now();
    const extractionId = request.extractionId ?? `${this.batch.id}_extraction`;
    return {
      status: "succeeded",
      batch: this.batch,
      validationIssues: [],
      trace: buildGraphExtractionTrace({
        request,
        extractionId,
        startedAt,
        finishedAt: this.now(),
        status: "succeeded",
        entityCount: this.batch.entities.length,
        relationCount: this.batch.relations.length
      })
    };
  }
}

function entityMatches(
  expected: LocalEvalKnowledgeMapEntityFixture,
  actual: GraphEntityProposal
): boolean {
  return (
    expected.kind === actual.kind && namesIntersect(entityNames(expected), entityNames(actual))
  );
}

function relationMatches(
  expected: LocalEvalKnowledgeMapRelationFixture,
  expectedEntities: readonly LocalEvalKnowledgeMapEntityFixture[],
  actual: GraphRelationProposal,
  actualEntities: readonly GraphEntityProposal[]
): boolean {
  return (
    expected.relationKind === actual.relationKind &&
    endpointMatches(
      expected.sourceEntityId,
      expectedEntities,
      actual.sourceEntityId,
      actualEntities
    ) &&
    endpointMatches(
      expected.targetEntityId,
      expectedEntities,
      actual.targetEntityId,
      actualEntities
    )
  );
}

function relationMatchesForbidden(
  expected: RagEvalRelationshipEdgeExpectation,
  actual: GraphRelationProposal,
  actualEntities: readonly GraphEntityProposal[]
): boolean {
  const sourceEntity = actualEntities.find((entity) => entity.id === actual.sourceEntityId);
  const targetEntity = actualEntities.find((entity) => entity.id === actual.targetEntityId);

  return (
    (expected.relationType === undefined ||
      normalize(expected.relationType) === normalize(actual.relationKind)) &&
    (expected.fromEntityId === undefined || expected.fromEntityId === actual.sourceEntityId) &&
    (expected.toEntityId === undefined || expected.toEntityId === actual.targetEntityId) &&
    (expected.fromName === undefined ||
      (sourceEntity !== undefined &&
        entityNames(sourceEntity).some((name) => name === normalize(expected.fromName ?? "")))) &&
    (expected.toName === undefined ||
      (targetEntity !== undefined &&
        entityNames(targetEntity).some((name) => name === normalize(expected.toName ?? ""))))
  );
}

function endpointMatches(
  expectedEntityId: string,
  expectedEntities: readonly LocalEvalKnowledgeMapEntityFixture[],
  actualEntityId: string,
  actualEntities: readonly GraphEntityProposal[]
): boolean {
  if (expectedEntityId === actualEntityId) {
    return true;
  }

  const expected = expectedEntities.find((entity) => entity.id === expectedEntityId);
  const actual = actualEntities.find((entity) => entity.id === actualEntityId);
  return expected !== undefined && actual !== undefined && entityMatches(expected, actual);
}

function entityNames(
  entity: LocalEvalKnowledgeMapEntityFixture | GraphEntityProposal
): readonly string[] {
  return uniqueSorted(
    [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
      .filter((value): value is string => value !== undefined)
      .map(normalize)
      .filter(Boolean)
  );
}

function namesIntersect(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function recall(matchedCount: number, expectedCount: number): number {
  return expectedCount === 0 ? 1 : matchedCount / expectedCount;
}

function missingEntityLabels(
  expected: readonly LocalEvalKnowledgeMapEntityFixture[],
  matched: readonly LocalEvalKnowledgeMapEntityFixture[]
): readonly string[] {
  const matchedIds = new Set(matched.map((entity) => entity.id));
  return expected.filter((entity) => !matchedIds.has(entity.id)).map(entityLabel);
}

function missingRelationLabels(
  expected: readonly LocalEvalKnowledgeMapRelationFixture[],
  matched: readonly LocalEvalKnowledgeMapRelationFixture[]
): readonly string[] {
  const matchedIds = new Set(matched.map((relation) => relation.id));
  return expected.filter((relation) => !matchedIds.has(relation.id)).map((relation) => relation.id);
}

function entityLabel(entity: LocalEvalKnowledgeMapEntityFixture | GraphEntityProposal): string {
  return `${entity.kind}:${entity.name}`;
}

function relationLabel(
  relation: GraphRelationProposal,
  entities: readonly GraphEntityProposal[]
): string {
  const source = entities.find((entity) => entity.id === relation.sourceEntityId);
  const target = entities.find((entity) => entity.id === relation.targetEntityId);
  return `${source?.name ?? relation.sourceEntityId} -${relation.relationKind}-> ${
    target?.name ?? relation.targetEntityId
  }`;
}

function formatRatio(value: number): string {
  return value.toFixed(2);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
