import type { RagChunk } from "../documents/chunk.js";
import type {
  GraphEntityProposal,
  GraphRelationKind,
  GraphRelationProposal
} from "./graph-types.js";

export type RelationEvidenceFaithfulnessCode =
  | "missing_relation_endpoint"
  | "missing_relation_evidence"
  | "unknown_evidence_chunk"
  | "source_entity_not_supported"
  | "target_entity_not_supported"
  | "relation_kind_not_supported";

export interface RelationEvidenceFaithfulnessIssue {
  readonly relationId: string;
  readonly code: RelationEvidenceFaithfulnessCode;
  readonly message: string;
  readonly chunkId?: string;
}

export interface RelationEvidenceFaithfulnessResult {
  readonly faithful: boolean;
  readonly checkedRelationCount: number;
  readonly issues: readonly RelationEvidenceFaithfulnessIssue[];
}

export function checkRelationEvidenceFaithfulness(input: {
  readonly entities: readonly GraphEntityProposal[];
  readonly relations: readonly GraphRelationProposal[];
  readonly chunks: readonly RagChunk[];
}): RelationEvidenceFaithfulnessResult {
  const entitiesById = new Map(input.entities.map((entity) => [entity.id, entity] as const));
  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk] as const));
  const issues: RelationEvidenceFaithfulnessIssue[] = [];

  for (const relation of input.relations) {
    const source = entitiesById.get(relation.sourceEntityId);
    const target = entitiesById.get(relation.targetEntityId);

    if (!source || !target) {
      issues.push({
        relationId: relation.id,
        code: "missing_relation_endpoint",
        message: `Relation "${relation.id}" references an entity missing from the checked entity set.`
      });
      continue;
    }

    if (relation.evidence.length === 0) {
      issues.push({
        relationId: relation.id,
        code: "missing_relation_evidence",
        message: `Relation "${relation.id}" has no evidence anchors.`
      });
      continue;
    }

    const relationSupported = relation.evidence.some((anchor) => {
      const chunk = chunksById.get(anchor.chunkId);
      if (!chunk) {
        issues.push({
          relationId: relation.id,
          code: "unknown_evidence_chunk",
          chunkId: anchor.chunkId,
          message: `Relation "${relation.id}" cites unknown chunk "${anchor.chunkId}".`
        });
        return false;
      }

      return evidenceChunkSupportsRelation({ relation, source, target, chunk, issues });
    });

    if (!relationSupported) {
      // Specific issues are added per chunk. This keeps the aggregate result explicit without
      // inventing a second generic failure for the same unsupported evidence set.
    }
  }

  return {
    faithful: issues.length === 0,
    checkedRelationCount: input.relations.length,
    issues
  };
}

function evidenceChunkSupportsRelation(input: {
  readonly relation: GraphRelationProposal;
  readonly source: GraphEntityProposal;
  readonly target: GraphEntityProposal;
  readonly chunk: RagChunk;
  readonly issues: RelationEvidenceFaithfulnessIssue[];
}): boolean {
  const text = normalize(input.chunk.text);
  const sourceSupported = entityTerms(input.source).some((term) => text.includes(term));
  const targetSupported = entityTerms(input.target).some((term) => text.includes(term));
  const relationSupported = relationTerms(input.relation.relationKind).some((term) =>
    text.includes(term)
  );

  if (!sourceSupported) {
    input.issues.push({
      relationId: input.relation.id,
      code: "source_entity_not_supported",
      chunkId: input.chunk.id,
      message: `Relation "${input.relation.id}" evidence chunk "${input.chunk.id}" does not mention the source entity.`
    });
  }

  if (!targetSupported) {
    input.issues.push({
      relationId: input.relation.id,
      code: "target_entity_not_supported",
      chunkId: input.chunk.id,
      message: `Relation "${input.relation.id}" evidence chunk "${input.chunk.id}" does not mention the target entity.`
    });
  }

  if (!relationSupported) {
    input.issues.push({
      relationId: input.relation.id,
      code: "relation_kind_not_supported",
      chunkId: input.chunk.id,
      message: `Relation "${input.relation.id}" evidence chunk "${input.chunk.id}" does not mention relation kind "${input.relation.relationKind}".`
    });
  }

  return sourceSupported && targetSupported && relationSupported;
}

function entityTerms(entity: GraphEntityProposal): readonly string[] {
  return unique(
    [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
      .map(normalize)
      .filter((term) => term.length > 1)
  );
}

function relationTerms(kind: GraphRelationKind): readonly string[] {
  switch (kind) {
    case "owns":
      return ["owns", "owned", "owner", "ownership", "wholly owned"];
    case "controls":
      return ["controls", "controlled", "control"];
    case "manages":
      return ["manages", "managed", "manager", "management"];
    case "beneficiary_of":
      return ["beneficiary", "beneficiary of"];
    case "trustee_of":
      return ["trustee", "trustee of"];
    case "director_of":
      return ["director", "director of"];
    case "signatory_of":
      return ["signatory", "signatory of", "signed by"];
    case "guarantees":
      return ["guarantees", "guaranteed", "guarantor"];
    case "owes":
      return ["owes", "owed", "debt", "payable"];
    case "member_of":
      return ["member", "member of"];
    case "registered_in":
      return ["registered", "registered in"];
    case "formed_on":
      return ["formed", "formed on", "formation"];
    case "expires_on":
      return ["expires", "expires on", "expiration"];
    case "reports_metric":
      return ["reports", "reported", "metric"];
    case "supplies":
      return ["supplies", "supplier", "supplied"];
    case "customer_of":
      return ["customer", "customer of"];
    case "partner_of":
      return ["partner", "partner of"];
    case "related_to":
      return ["related", "related to"];
    default:
      return customRelationTerms(kind);
  }
}

function customRelationTerms(kind: string): readonly string[] {
  const spaced = kind.replace(/[_:-]+/gu, " ").trim();
  return unique([kind, spaced].map(normalize).filter(Boolean));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
