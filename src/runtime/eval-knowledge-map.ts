import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { GraphApprovalRunner } from "../graph/graph-approval.js";
import {
  buildGraphExtractionTrace,
  type GraphExtractionRequest,
  type GraphExtractionResult,
  type GraphExtractor
} from "../graph/graph-extractor.js";
import { GraphIngestionRunner, type GraphIngestionResult } from "../graph/graph-ingestion.js";
import type {
  GraphEntityKind,
  GraphExtractionBatch,
  GraphFactStrength,
  GraphOntology,
  GraphProposalStatus,
  GraphRelationKind,
  GraphVerificationStatus
} from "../graph/graph-types.js";
import { isGraphEntityKind, isGraphRelationKind } from "../graph/graph-types.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { ownershipGraphOntology } from "../graph/ownership-ontology.js";
import { ProposalBackedRagGraphStore } from "../graph/proposal-graph-adapter.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { AccessScope } from "../security/access-scope.js";
import type { TrustTier } from "../documents/trust-tier.js";

export interface LocalEvalKnowledgeMapFixture {
  readonly ontology?: LocalEvalKnowledgeMapOntologyFixture;
  readonly entities: readonly LocalEvalKnowledgeMapEntityFixture[];
  readonly relations: readonly LocalEvalKnowledgeMapRelationFixture[];
  readonly expectedVisibleEntityIds?: readonly string[];
  readonly expectedVisibleRelationIds?: readonly string[];
}

export interface LocalEvalKnowledgeMapOntologyFixture {
  readonly id: string;
  readonly entityKinds: readonly string[];
  readonly relationKinds: readonly string[];
  readonly requiredEvidenceForRelations: boolean;
  readonly allowInferredRelations: boolean;
}

export interface LocalEvalKnowledgeMapEntityFixture {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly normalizedName?: string;
  readonly aliases?: readonly string[];
  readonly evidenceDocumentIds: readonly string[];
  readonly confidence?: number;
  readonly trustTier?: TrustTier;
  readonly accessScope?: AccessScope;
  readonly status?: string;
}

export interface LocalEvalKnowledgeMapRelationFixture {
  readonly id: string;
  readonly relationKind: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly evidenceDocumentIds: readonly string[];
  readonly factStrength?: string;
  readonly confidence?: number;
  readonly trustTier?: TrustTier;
  readonly accessScope?: AccessScope;
  readonly verificationStatus?: string;
  readonly status?: string;
  readonly observedAt?: string;
}

export interface LocalEvalKnowledgeMapSetupRequest {
  readonly profile: ValidatedRagProfile;
  readonly fixture?: LocalEvalKnowledgeMapFixture;
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly filter: IndexFilter;
  readonly runId: string;
  readonly sourceLabel?: string;
  readonly now: () => string;
}

export interface LocalEvalKnowledgeMapSetup {
  readonly retrievalStore?: ProposalBackedRagGraphStore;
  readonly ingestion?: GraphIngestionResult;
  readonly failures: readonly string[];
}

export async function setupLocalEvalKnowledgeMap(
  request: LocalEvalKnowledgeMapSetupRequest
): Promise<LocalEvalKnowledgeMapSetup> {
  if (!request.fixture) {
    return { failures: [] };
  }

  const graphStore = new InMemoryGraphStore();
  const batch = buildLocalEvalKnowledgeMapBatch({
    profile: request.profile,
    fixture: request.fixture,
    chunks: request.chunks,
    now: request.now,
    ...(request.sourceLabel ? { sourceLabel: request.sourceLabel } : {})
  });
  const runner = new GraphIngestionRunner({
    extractor: new StaticLocalEvalKnowledgeMapExtractor(batch, request.now),
    graphStore,
    approvalRunner: new GraphApprovalRunner({ graphStore, now: request.now }),
    now: request.now
  });
  const ingestion = await runner.ingest({
    profile: request.profile,
    ontology: batch.ontology,
    documents: request.documents,
    chunks: request.chunks,
    approvalFilter: request.filter,
    ingestionId: request.runId,
    requestedAt: request.now()
  });
  const failures: string[] = [];

  if (ingestion.status !== "succeeded") {
    failures.push(`Knowledge-map ingestion expected succeeded, got "${ingestion.status}".`);
  }

  const visibleEntities = graphStore
    .findEntities(request.filter)
    .filter((entity) => entity.status === "approved" || entity.status === "verified");
  const visibleRelations = graphStore.findRelations({
    filter: request.filter,
    limit: request.fixture.relations.length
  });
  const visibleEntityIds = new Set(visibleEntities.map((entity) => entity.id));
  const visibleRelationIds = new Set(visibleRelations.map((relation) => relation.id));
  const expectedVisibleEntityIds =
    request.fixture.expectedVisibleEntityIds ?? request.fixture.entities.map((entity) => entity.id);
  const expectedVisibleRelationIds =
    request.fixture.expectedVisibleRelationIds ??
    request.fixture.relations.map((relation) => relation.id);
  const missingVisibleEntityIds = expectedVisibleEntityIds.filter(
    (id) => !visibleEntityIds.has(id)
  );
  const missingVisibleRelationIds = expectedVisibleRelationIds.filter(
    (id) => !visibleRelationIds.has(id)
  );
  const unexpectedVisibleEntityIds =
    request.fixture.expectedVisibleEntityIds === undefined
      ? []
      : [...visibleEntityIds].filter((id) => !expectedVisibleEntityIds.includes(id));
  const unexpectedVisibleRelationIds =
    request.fixture.expectedVisibleRelationIds === undefined
      ? []
      : [...visibleRelationIds].filter((id) => !expectedVisibleRelationIds.includes(id));

  if (missingVisibleEntityIds.length > 0) {
    failures.push(
      `Knowledge-map ingestion did not expose expected entity fixture(s): ${missingVisibleEntityIds.join(", ")}.`
    );
  }
  if (missingVisibleRelationIds.length > 0) {
    failures.push(
      `Knowledge-map ingestion did not expose expected relation fixture(s): ${missingVisibleRelationIds.join(", ")}.`
    );
  }
  if (unexpectedVisibleEntityIds.length > 0) {
    failures.push(
      `Knowledge-map ingestion exposed unexpected entity fixture(s): ${unexpectedVisibleEntityIds.join(", ")}.`
    );
  }
  if (unexpectedVisibleRelationIds.length > 0) {
    failures.push(
      `Knowledge-map ingestion exposed unexpected relation fixture(s): ${unexpectedVisibleRelationIds.join(", ")}.`
    );
  }

  return {
    retrievalStore: new ProposalBackedRagGraphStore(graphStore),
    ingestion,
    failures
  };
}

export function buildLocalEvalKnowledgeMapBatch(input: {
  readonly profile: ValidatedRagProfile;
  readonly fixture: LocalEvalKnowledgeMapFixture;
  readonly chunks: readonly RagChunk[];
  readonly now: () => string;
  readonly sourceLabel?: string;
}): GraphExtractionBatch {
  const createdAt = input.now();
  const ontology = toGraphOntology(input.fixture.ontology);
  const evidenceResolver = new LocalEvalKnowledgeEvidenceResolver({
    chunks: input.chunks,
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {})
  });

  return {
    id: `local_eval_knowledge_map_${createdAt.replace(/[^0-9a-z]/gi, "")}`,
    namespaceId: input.profile.namespaceId,
    ontology,
    createdAt,
    entities: input.fixture.entities.map((entity) => {
      const evidence = evidenceResolver.resolve(entity.evidenceDocumentIds, `entity ${entity.id}`);
      const firstEvidenceChunk = evidenceResolver.chunkForAnchor(evidence[0]);
      return {
        id: entity.id,
        namespaceId: input.profile.namespaceId,
        kind: toGraphEntityKind(entity.kind),
        name: entity.name,
        normalizedName: entity.normalizedName ?? normalizeKnowledgeMapName(entity.name),
        ...(entity.aliases ? { aliases: entity.aliases } : {}),
        confidence: entity.confidence ?? 0.95,
        trustTier: entity.trustTier ?? firstEvidenceChunk.provenance.trustTier,
        accessScope: entity.accessScope ?? firstEvidenceChunk.accessScope,
        evidence,
        status: toGraphProposalStatus(entity.status ?? "proposed"),
        createdAt
      };
    }),
    relations: input.fixture.relations.map((relation) => {
      const evidence = evidenceResolver.resolve(
        relation.evidenceDocumentIds,
        `relation ${relation.id}`
      );
      const firstEvidenceChunk = evidenceResolver.chunkForAnchor(evidence[0]);
      return {
        id: relation.id,
        namespaceId: input.profile.namespaceId,
        relationKind: toGraphRelationKind(relation.relationKind),
        sourceEntityId: relation.sourceEntityId,
        targetEntityId: relation.targetEntityId,
        factStrength: toGraphFactStrength(relation.factStrength ?? "explicit_fact"),
        confidence: relation.confidence ?? 0.95,
        trustTier: relation.trustTier ?? firstEvidenceChunk.provenance.trustTier,
        accessScope: relation.accessScope ?? firstEvidenceChunk.accessScope,
        evidence,
        temporal: {
          observedAt: relation.observedAt ?? createdAt
        },
        verificationStatus: toGraphVerificationStatus(relation.verificationStatus ?? "supported"),
        status: toGraphProposalStatus(relation.status ?? "proposed"),
        createdAt
      };
    })
  };
}

class LocalEvalKnowledgeEvidenceResolver {
  private readonly chunksByDocumentId: ReadonlyMap<string, readonly RagChunk[]>;
  private readonly chunksById: ReadonlyMap<string, RagChunk>;
  private readonly sourceLabel: string | undefined;

  constructor(options: { readonly chunks: readonly RagChunk[]; readonly sourceLabel?: string }) {
    const byDocumentId = new Map<string, RagChunk[]>();
    const byId = new Map<string, RagChunk>();
    for (const chunk of options.chunks) {
      byId.set(chunk.id, chunk);
      const existing = byDocumentId.get(chunk.documentId) ?? [];
      existing.push(chunk);
      byDocumentId.set(chunk.documentId, existing);
    }
    this.chunksByDocumentId = byDocumentId;
    this.chunksById = byId;
    this.sourceLabel = options.sourceLabel;
  }

  resolve(
    documentIds: readonly string[],
    pathLabel: string
  ): GraphExtractionBatch["entities"][number]["evidence"] {
    if (documentIds.length === 0) {
      throw new Error(`${this.label()}knowledgeMap ${pathLabel} requires evidenceDocumentIds.`);
    }

    return documentIds.map((documentId) => {
      const chunk = this.chunksByDocumentId.get(documentId)?.[0];
      if (!chunk) {
        throw new Error(
          `${this.label()}knowledgeMap ${pathLabel} references document "${documentId}" with no accepted chunk.`
        );
      }
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        sourceId: chunk.provenance.sourceId,
        citation: chunk.citation,
        characterStart: chunk.characterStart,
        characterEnd: chunk.characterEnd
      };
    });
  }

  chunkForAnchor(
    anchor: GraphExtractionBatch["entities"][number]["evidence"][number] | undefined
  ): RagChunk {
    const chunk = anchor ? this.chunksById.get(anchor.chunkId) : undefined;
    if (!chunk) {
      throw new Error(`${this.label()}knowledgeMap evidence could not resolve an accepted chunk.`);
    }
    return chunk;
  }

  private label(): string {
    return this.sourceLabel ? `${this.sourceLabel}: ` : "";
  }
}

class StaticLocalEvalKnowledgeMapExtractor implements GraphExtractor {
  readonly id = "static-local-eval-knowledge-map-extractor";
  readonly supportedOntologyIds: readonly string[];

  private readonly batch: GraphExtractionBatch;
  private readonly now: () => string;

  constructor(batch: GraphExtractionBatch, now: () => string) {
    this.batch = batch;
    this.supportedOntologyIds = [batch.ontology.id];
    this.now = now;
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

function toGraphOntology(value: LocalEvalKnowledgeMapOntologyFixture | undefined): GraphOntology {
  if (!value) {
    return ownershipGraphOntology;
  }

  return {
    id: value.id,
    entityKinds: value.entityKinds.map(toGraphEntityKind),
    relationKinds: value.relationKinds.map(toGraphRelationKind),
    requiredEvidenceForRelations: value.requiredEvidenceForRelations,
    allowInferredRelations: value.allowInferredRelations
  };
}

function toGraphEntityKind(value: string): GraphEntityKind {
  if (!isGraphEntityKind(value)) {
    throw new Error(`Invalid knowledge-map entity kind "${value}".`);
  }
  return value;
}

function toGraphRelationKind(value: string): GraphRelationKind {
  if (!isGraphRelationKind(value)) {
    throw new Error(`Invalid knowledge-map relation kind "${value}".`);
  }
  return value;
}

function toGraphFactStrength(value: string): GraphFactStrength {
  switch (value) {
    case "explicit_fact":
    case "inferred_fact":
    case "co_mention":
    case "semantic_association":
      return value;
    default:
      throw new Error(`Invalid knowledge-map fact strength "${value}".`);
  }
}

function toGraphProposalStatus(value: string): GraphProposalStatus {
  switch (value) {
    case "proposed":
    case "verified":
    case "needs_review":
    case "rejected":
    case "approved":
    case "superseded":
      return value;
    default:
      throw new Error(`Invalid knowledge-map proposal status "${value}".`);
  }
}

function toGraphVerificationStatus(value: string): GraphVerificationStatus {
  switch (value) {
    case "not_checked":
    case "supported":
    case "unsupported":
    case "ambiguous":
    case "contradicted":
      return value;
    default:
      throw new Error(`Invalid knowledge-map verification status "${value}".`);
  }
}

function normalizeKnowledgeMapName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
