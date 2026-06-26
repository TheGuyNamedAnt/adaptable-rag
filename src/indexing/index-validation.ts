import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import { validateChunk } from "../chunking/chunk-validation.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";

export type IndexValidationSeverity = "error" | "warning";

export type IndexValidationCode =
  | "missing_document_field"
  | "document_boundary_mismatch"
  | "missing_document_provenance"
  | "missing_document_access_scope"
  | "chunk_validation_failed"
  | "chunk_parent_missing"
  | "chunk_duplicate_id";

export interface IndexValidationIssue {
  readonly severity: IndexValidationSeverity;
  readonly code: IndexValidationCode;
  readonly targetId: string;
  readonly path: string;
  readonly message: string;
}

export interface IndexValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IndexValidationIssue[];
  readonly errors: readonly IndexValidationIssue[];
  readonly warnings: readonly IndexValidationIssue[];
}

export function validateDocumentForIndex(document: RagDocument): IndexValidationResult {
  const issues: IndexValidationIssue[] = [];

  if (!document.id.trim()) {
    issues.push(
      issue("error", "missing_document_field", document.id, "id", "Document id is required.")
    );
  }

  if (!document.namespaceId.trim()) {
    issues.push(
      issue(
        "error",
        "missing_document_field",
        document.id,
        "namespaceId",
        "Document namespaceId is required."
      )
    );
  }

  if (!document.title.trim() || !document.body.trim()) {
    issues.push(
      issue(
        "error",
        "missing_document_field",
        document.id,
        "title/body",
        "Document title and body are required."
      )
    );
  }

  if (!document.provenance.sourceId.trim() || !document.provenance.title.trim()) {
    issues.push(
      issue(
        "error",
        "missing_document_provenance",
        document.id,
        "provenance",
        "Document provenance sourceId and title are required."
      )
    );
  }

  if (!document.provenance.ingestedAt.trim()) {
    issues.push(
      issue(
        "error",
        "missing_document_provenance",
        document.id,
        "provenance.ingestedAt",
        "Document provenance ingestedAt is required."
      )
    );
  }

  if (!document.accessScope.tenantId.trim() || !document.accessScope.namespaceId.trim()) {
    issues.push(
      issue(
        "error",
        "missing_document_access_scope",
        document.id,
        "accessScope",
        "Document accessScope tenantId and namespaceId are required."
      )
    );
  }

  if (document.accessScope.namespaceId !== document.namespaceId) {
    issues.push(
      issue(
        "error",
        "document_boundary_mismatch",
        document.id,
        "accessScope.namespaceId",
        "Document accessScope namespaceId must match document namespaceId."
      )
    );
  }

  return result(issues);
}

export function validateChunksForIndex(
  document: RagDocument | undefined,
  chunks: readonly RagChunk[],
  existingChunkIds: ReadonlySet<string> = new Set<string>(),
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY
): IndexValidationResult {
  const issues: IndexValidationIssue[] = [];
  const seen = new Set<string>();

  if (!document) {
    for (const chunk of chunks) {
      issues.push(
        issue(
          "error",
          "chunk_parent_missing",
          chunk.id,
          "documentId",
          `Parent document "${chunk.documentId}" is not indexed.`
        )
      );
    }
    return result(issues);
  }

  for (const chunk of chunks) {
    if (seen.has(chunk.id) || existingChunkIds.has(chunk.id)) {
      issues.push(
        issue(
          "error",
          "chunk_duplicate_id",
          chunk.id,
          "id",
          `Chunk id "${chunk.id}" is already indexed or duplicated in this batch.`
        )
      );
    }
    seen.add(chunk.id);

    const chunkValidation = validateChunk(chunk, document, policy);
    for (const chunkIssue of chunkValidation.issues) {
      issues.push(
        issue(
          chunkIssue.severity,
          "chunk_validation_failed",
          chunk.id,
          chunkIssue.path,
          chunkIssue.message
        )
      );
    }
  }

  return result(issues);
}

function result(issues: readonly IndexValidationIssue[]): IndexValidationResult {
  const errors = issues.filter((validationIssue) => validationIssue.severity === "error");
  const warnings = issues.filter((validationIssue) => validationIssue.severity === "warning");

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

function issue(
  severity: IndexValidationSeverity,
  code: IndexValidationCode,
  targetId: string,
  path: string,
  message: string
): IndexValidationIssue {
  return {
    severity,
    code,
    targetId,
    path,
    message
  };
}
