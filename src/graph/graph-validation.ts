import type { GraphExtractionBatch, GraphRelationProposal } from "./graph-types.js";

export type GraphValidationSeverity = "error" | "warning";

export type GraphValidationCode =
  | "missing_batch_field"
  | "unsupported_entity_kind"
  | "unsupported_relation_kind"
  | "namespace_mismatch"
  | "invalid_confidence"
  | "missing_evidence"
  | "unknown_relation_entity"
  | "inferred_relation_disallowed"
  | "invalid_temporal_validity";

export interface GraphValidationIssue {
  readonly severity: GraphValidationSeverity;
  readonly code: GraphValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface GraphValidationResult {
  readonly valid: boolean;
  readonly issues: readonly GraphValidationIssue[];
  readonly errors: readonly GraphValidationIssue[];
  readonly warnings: readonly GraphValidationIssue[];
}

export function validateGraphExtractionBatch(batch: GraphExtractionBatch): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];

  if (!batch.id.trim()) {
    issues.push(error("missing_batch_field", "id", "Graph extraction batch id is required."));
  }

  if (!batch.namespaceId.trim()) {
    issues.push(
      error("missing_batch_field", "namespaceId", "Graph extraction namespaceId is required.")
    );
  }

  const entityIds = new Set<string>();
  for (const [index, entity] of batch.entities.entries()) {
    const path = `entities[${index}]`;
    entityIds.add(entity.id);

    if (entity.namespaceId !== batch.namespaceId) {
      issues.push(error("namespace_mismatch", `${path}.namespaceId`, "Entity namespace mismatch."));
    }

    if (!batch.ontology.entityKinds.includes(entity.kind)) {
      issues.push(
        error(
          "unsupported_entity_kind",
          `${path}.kind`,
          `Entity kind "${entity.kind}" is not allowed.`
        )
      );
    }

    validateConfidence(entity.confidence, `${path}.confidence`, issues);

    if (entity.evidence.length === 0 && entity.status !== "superseded") {
      issues.push(
        error("missing_evidence", `${path}.evidence`, "Entity proposals require evidence.")
      );
    }
  }

  for (const [index, relation] of batch.relations.entries()) {
    const path = `relations[${index}]`;

    if (relation.namespaceId !== batch.namespaceId) {
      issues.push(
        error("namespace_mismatch", `${path}.namespaceId`, "Relation namespace mismatch.")
      );
    }

    if (!batch.ontology.relationKinds.includes(relation.relationKind)) {
      issues.push(
        error(
          "unsupported_relation_kind",
          `${path}.relationKind`,
          `Relation kind "${relation.relationKind}" is not allowed.`
        )
      );
    }

    validateRelationEntityRefs(relation, entityIds, path, issues);
    validateConfidence(relation.confidence, `${path}.confidence`, issues);
    validateTemporal(relation, path, issues);

    if (
      batch.ontology.requiredEvidenceForRelations &&
      relation.evidence.length === 0 &&
      relation.status !== "superseded"
    ) {
      issues.push(
        error("missing_evidence", `${path}.evidence`, "Relation proposals require evidence.")
      );
    }

    if (!batch.ontology.allowInferredRelations && relation.factStrength !== "explicit_fact") {
      issues.push(
        error(
          "inferred_relation_disallowed",
          `${path}.factStrength`,
          "Ontology requires explicit relation evidence."
        )
      );
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

export function assertValidGraphExtractionBatch(
  batch: GraphExtractionBatch
): asserts batch is GraphExtractionBatch {
  const result = validateGraphExtractionBatch(batch);
  if (!result.valid) {
    throw new Error(
      `Invalid graph extraction batch:\n${result.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n")}`
    );
  }
}

function validateRelationEntityRefs(
  relation: GraphRelationProposal,
  entityIds: ReadonlySet<string>,
  path: string,
  issues: GraphValidationIssue[]
): void {
  if (!entityIds.has(relation.sourceEntityId)) {
    issues.push(
      error(
        "unknown_relation_entity",
        `${path}.sourceEntityId`,
        "Relation sourceEntityId must reference an entity in the same batch."
      )
    );
  }

  if (!entityIds.has(relation.targetEntityId)) {
    issues.push(
      error(
        "unknown_relation_entity",
        `${path}.targetEntityId`,
        "Relation targetEntityId must reference an entity in the same batch."
      )
    );
  }
}

function validateConfidence(
  confidence: number,
  path: string,
  issues: GraphValidationIssue[]
): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push(error("invalid_confidence", path, "Confidence must be between 0 and 1."));
  }
}

function validateTemporal(
  relation: GraphRelationProposal,
  path: string,
  issues: GraphValidationIssue[]
): void {
  if (
    !relation.temporal.observedAt.trim() ||
    Number.isNaN(Date.parse(relation.temporal.observedAt))
  ) {
    issues.push(
      error(
        "invalid_temporal_validity",
        `${path}.temporal.observedAt`,
        "Relation observedAt must be a parseable timestamp."
      )
    );
  }

  if (
    relation.temporal.validFrom &&
    relation.temporal.validTo &&
    Date.parse(relation.temporal.validFrom) > Date.parse(relation.temporal.validTo)
  ) {
    issues.push(
      error(
        "invalid_temporal_validity",
        `${path}.temporal`,
        "Relation validFrom cannot be after validTo."
      )
    );
  }
}

function error(code: GraphValidationCode, path: string, message: string): GraphValidationIssue {
  return {
    severity: "error",
    code,
    path,
    message
  };
}
