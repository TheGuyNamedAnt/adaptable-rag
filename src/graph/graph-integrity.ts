import type { RagChunk } from "../documents/chunk.js";
import type {
  GraphEntityProposal,
  GraphEvidenceAnchor,
  GraphExtractionBatch,
  GraphRelationKind
} from "./graph-types.js";
import { validateGraphExtractionBatch, type GraphValidationIssue } from "./graph-validation.js";

export type GraphIntegritySeverity = "error" | "warning";

export type GraphIntegrityIssueCode =
  | "batch_validation_failed"
  | "unknown_evidence_chunk"
  | "evidence_document_mismatch"
  | "evidence_source_mismatch"
  | "evidence_quote_hash_mismatch"
  | "evidence_character_range_mismatch"
  | "entity_evidence_text_missing"
  | "relation_source_not_grounded"
  | "relation_target_not_grounded"
  | "relation_kind_not_grounded"
  | "unsafe_auto_approved_relation";

export interface GraphIntegrityIssue {
  readonly severity: GraphIntegritySeverity;
  readonly code: GraphIntegrityIssueCode;
  readonly path: string;
  readonly message: string;
  readonly entityId?: string;
  readonly relationId?: string;
  readonly chunkId?: string;
  readonly validationCode?: GraphValidationIssue["code"];
}

export interface GraphIntegrityResult {
  readonly valid: boolean;
  readonly checkedEntityCount: number;
  readonly checkedRelationCount: number;
  readonly checkedEvidenceAnchorCount: number;
  readonly issues: readonly GraphIntegrityIssue[];
  readonly errors: readonly GraphIntegrityIssue[];
  readonly warnings: readonly GraphIntegrityIssue[];
}

export interface GraphIntegrityOptions {
  readonly requireEntityEvidenceText?: boolean;
  readonly requireRelationEvidenceText?: boolean;
  readonly allowApprovedInferredRelations?: boolean;
}

export interface GraphIntegrityInput {
  readonly batch: GraphExtractionBatch;
  readonly chunks: readonly RagChunk[];
  readonly options?: GraphIntegrityOptions;
}

const DEFAULT_OPTIONS: Required<GraphIntegrityOptions> = {
  requireEntityEvidenceText: true,
  requireRelationEvidenceText: true,
  allowApprovedInferredRelations: false
};

export function checkGraphIntegrity(input: GraphIntegrityInput): GraphIntegrityResult {
  const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) };
  const issues: GraphIntegrityIssue[] = [];
  const validation = validateGraphExtractionBatch(input.batch);
  for (const issue of validation.issues) {
    issues.push({
      severity: issue.severity,
      code: "batch_validation_failed",
      path: issue.path,
      message: issue.message,
      validationCode: issue.code
    });
  }

  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk] as const));
  const entitiesById = new Map(input.batch.entities.map((entity) => [entity.id, entity] as const));
  const entityEvidenceChunks = new Map<string, readonly RagChunk[]>();
  let checkedEvidenceAnchorCount = 0;

  for (const [entityIndex, entity] of input.batch.entities.entries()) {
    const chunks: RagChunk[] = [];
    for (const [anchorIndex, anchor] of entity.evidence.entries()) {
      checkedEvidenceAnchorCount += 1;
      const chunk = validateEvidenceAnchor({
        anchor,
        chunksById,
        path: `entities[${entityIndex}].evidence[${anchorIndex}]`,
        entityId: entity.id,
        issues
      });
      if (chunk) {
        chunks.push(chunk);
      }
    }
    entityEvidenceChunks.set(entity.id, chunks);

    if (
      options.requireEntityEvidenceText &&
      entity.status !== "superseded" &&
      chunks.length > 0 &&
      !entityGroundedInChunks(entity, chunks)
    ) {
      issues.push({
        severity: "error",
        code: "entity_evidence_text_missing",
        path: `entities[${entityIndex}].evidence`,
        entityId: entity.id,
        message: `Entity "${entity.id}" evidence does not mention its name or aliases.`
      });
    }
  }

  for (const [relationIndex, relation] of input.batch.relations.entries()) {
    const relationChunks: RagChunk[] = [];
    for (const [anchorIndex, anchor] of relation.evidence.entries()) {
      checkedEvidenceAnchorCount += 1;
      const chunk = validateEvidenceAnchor({
        anchor,
        chunksById,
        path: `relations[${relationIndex}].evidence[${anchorIndex}]`,
        relationId: relation.id,
        issues
      });
      if (chunk) {
        relationChunks.push(chunk);
      }
    }

    const source = entitiesById.get(relation.sourceEntityId);
    const target = entitiesById.get(relation.targetEntityId);
    if (!source || !target) {
      continue;
    }

    if (
      relation.status === "approved" &&
      !options.allowApprovedInferredRelations &&
      relation.factStrength !== "explicit_fact"
    ) {
      issues.push({
        severity: "error",
        code: "unsafe_auto_approved_relation",
        path: `relations[${relationIndex}].factStrength`,
        relationId: relation.id,
        message: `Approved relation "${relation.id}" is not an explicit evidence-backed fact.`
      });
    }

    if (
      relation.status === "approved" &&
      relation.verificationStatus !== "supported" &&
      relation.verificationStatus !== "not_checked"
    ) {
      issues.push({
        severity: "error",
        code: "unsafe_auto_approved_relation",
        path: `relations[${relationIndex}].verificationStatus`,
        relationId: relation.id,
        message: `Approved relation "${relation.id}" has verification status "${relation.verificationStatus}".`
      });
    }

    if (options.requireRelationEvidenceText && relationChunks.length > 0) {
      const sourceChunks = [...relationChunks, ...(entityEvidenceChunks.get(source.id) ?? [])];
      const targetChunks = [...relationChunks, ...(entityEvidenceChunks.get(target.id) ?? [])];
      if (!entityGroundedInChunks(source, sourceChunks)) {
        issues.push({
          severity: "error",
          code: "relation_source_not_grounded",
          path: `relations[${relationIndex}].sourceEntityId`,
          relationId: relation.id,
          entityId: source.id,
          message: `Relation "${relation.id}" evidence does not ground source entity "${source.name}".`
        });
      }
      if (!entityGroundedInChunks(target, targetChunks)) {
        issues.push({
          severity: "error",
          code: "relation_target_not_grounded",
          path: `relations[${relationIndex}].targetEntityId`,
          relationId: relation.id,
          entityId: target.id,
          message: `Relation "${relation.id}" evidence does not ground target entity "${target.name}".`
        });
      }
      if (!relationKindGroundedInChunks(relation.relationKind, relationChunks)) {
        issues.push({
          severity: "error",
          code: "relation_kind_not_grounded",
          path: `relations[${relationIndex}].relationKind`,
          relationId: relation.id,
          message: `Relation "${relation.id}" evidence does not ground relation kind "${relation.relationKind}".`
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    valid: errors.length === 0,
    checkedEntityCount: input.batch.entities.length,
    checkedRelationCount: input.batch.relations.length,
    checkedEvidenceAnchorCount,
    issues,
    errors,
    warnings
  };
}

export function assertGraphIntegrity(input: GraphIntegrityInput): void {
  const result = checkGraphIntegrity(input);
  if (!result.valid) {
    throw new Error(
      `Invalid graph integrity:\n${result.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n")}`
    );
  }
}

function validateEvidenceAnchor(input: {
  readonly anchor: GraphEvidenceAnchor;
  readonly chunksById: ReadonlyMap<string, RagChunk>;
  readonly path: string;
  readonly entityId?: string;
  readonly relationId?: string;
  readonly issues: GraphIntegrityIssue[];
}): RagChunk | undefined {
  const chunk = input.chunksById.get(input.anchor.chunkId);
  if (!chunk) {
    input.issues.push({
      severity: "error",
      code: "unknown_evidence_chunk",
      path: `${input.path}.chunkId`,
      chunkId: input.anchor.chunkId,
      ...evidenceIssueTarget(input),
      message: `Evidence references unknown chunk "${input.anchor.chunkId}".`
    });
    return undefined;
  }

  if (input.anchor.documentId !== chunk.documentId) {
    input.issues.push({
      severity: "error",
      code: "evidence_document_mismatch",
      path: `${input.path}.documentId`,
      chunkId: chunk.id,
      ...evidenceIssueTarget(input),
      message: `Evidence documentId "${input.anchor.documentId}" does not match chunk documentId "${chunk.documentId}".`
    });
  }

  if (input.anchor.sourceId !== chunk.provenance.sourceId) {
    input.issues.push({
      severity: "error",
      code: "evidence_source_mismatch",
      path: `${input.path}.sourceId`,
      chunkId: chunk.id,
      ...evidenceIssueTarget(input),
      message: `Evidence sourceId "${input.anchor.sourceId}" does not match chunk sourceId "${chunk.provenance.sourceId}".`
    });
  }

  if (input.anchor.quoteHash !== undefined && input.anchor.quoteHash !== chunk.textHash) {
    input.issues.push({
      severity: "error",
      code: "evidence_quote_hash_mismatch",
      path: `${input.path}.quoteHash`,
      chunkId: chunk.id,
      ...evidenceIssueTarget(input),
      message: `Evidence quoteHash does not match chunk textHash for chunk "${chunk.id}".`
    });
  }

  if (
    input.anchor.characterStart !== undefined &&
    input.anchor.characterStart !== chunk.characterStart
  ) {
    input.issues.push({
      severity: "error",
      code: "evidence_character_range_mismatch",
      path: `${input.path}.characterStart`,
      chunkId: chunk.id,
      ...evidenceIssueTarget(input),
      message: `Evidence characterStart ${input.anchor.characterStart} does not match chunk characterStart ${chunk.characterStart}.`
    });
  }

  if (input.anchor.characterEnd !== undefined && input.anchor.characterEnd !== chunk.characterEnd) {
    input.issues.push({
      severity: "error",
      code: "evidence_character_range_mismatch",
      path: `${input.path}.characterEnd`,
      chunkId: chunk.id,
      ...evidenceIssueTarget(input),
      message: `Evidence characterEnd ${input.anchor.characterEnd} does not match chunk characterEnd ${chunk.characterEnd}.`
    });
  }

  return chunk;
}

function evidenceIssueTarget(input: {
  readonly entityId?: string;
  readonly relationId?: string;
}): Pick<GraphIntegrityIssue, "entityId" | "relationId"> {
  return {
    ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    ...(input.relationId === undefined ? {} : { relationId: input.relationId })
  };
}

function entityGroundedInChunks(entity: GraphEntityProposal, chunks: readonly RagChunk[]): boolean {
  const terms = entitySearchTerms(entity);
  return terms.length === 0 || chunks.some((chunk) => textContainsAnyTerm(chunk.text, terms));
}

function relationKindGroundedInChunks(
  relationKind: GraphRelationKind,
  chunks: readonly RagChunk[]
): boolean {
  const terms = relationSearchTerms(relationKind);
  return terms.length === 0 || chunks.some((chunk) => textContainsAnyTerm(chunk.text, terms));
}

function entitySearchTerms(entity: GraphEntityProposal): readonly string[] {
  return unique(
    [entity.name, entity.normalizedName, ...(entity.aliases ?? [])]
      .map(normalizeSearchText)
      .filter((term) => term.length > 1)
  );
}

function relationSearchTerms(kind: GraphRelationKind): readonly string[] {
  switch (kind) {
    case "owns":
      return [
        "owns",
        "owned",
        "owner",
        "ownership",
        "wholly owned",
        "parent of",
        "parent company",
        "subsidiary",
        "subsidiaries",
        "subsidiaries of registrant"
      ];
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
      return [
        "registered",
        "registered in",
        "incorporated",
        "incorporation",
        "jurisdiction",
        "jurisdiction of incorporation",
        "where incorporated",
        "domicile",
        "state of incorporation",
        "organized",
        "organization"
      ];
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
      return customRelationSearchTerms(kind);
  }
}

function customRelationSearchTerms(kind: string): readonly string[] {
  const spaced = kind.replace(/[_:-]+/gu, " ").trim();
  return unique([kind, spaced].map(normalizeSearchText).filter(Boolean));
}

function textContainsAnyTerm(text: string, terms: readonly string[]): boolean {
  const normalizedText = ` ${normalizeSearchText(text)} `;
  return terms.some((term) => normalizedText.includes(` ${term} `));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[’‘]/gu, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
