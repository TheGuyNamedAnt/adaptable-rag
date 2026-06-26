import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayoutPage, LayoutBox } from "../documents/layout.js";
import { DEFAULT_CHUNKING_POLICY, type ChunkingPolicy } from "./chunk-policy.js";
import { hashText } from "./hash.js";

export type ChunkValidationSeverity = "error" | "warning";

export type ChunkValidationCode =
  | "empty_chunk"
  | "document_mismatch"
  | "namespace_mismatch"
  | "access_scope_mismatch"
  | "provenance_mismatch"
  | "citation_mismatch"
  | "invalid_character_range"
  | "source_range_mismatch"
  | "invalid_chunk_size"
  | "hash_mismatch"
  | "missing_safety_flags"
  | "invalid_layout_reference"
  | "layout_citation_mismatch"
  | "invalid_layout_box";

export interface ChunkValidationIssue {
  readonly severity: ChunkValidationSeverity;
  readonly code: ChunkValidationCode;
  readonly chunkId: string;
  readonly path: string;
  readonly message: string;
}

export interface ChunkValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ChunkValidationIssue[];
  readonly errors: readonly ChunkValidationIssue[];
  readonly warnings: readonly ChunkValidationIssue[];
}

export function validateChunk(
  chunk: RagChunk,
  document: RagDocument,
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY
): ChunkValidationResult {
  const issues: ChunkValidationIssue[] = [];

  if (!chunk.text.trim()) {
    issues.push(issue("error", "empty_chunk", chunk.id, "text", "Chunk text is required."));
  }

  if (chunk.documentId !== document.id) {
    issues.push(
      issue(
        "error",
        "document_mismatch",
        chunk.id,
        "documentId",
        "Chunk documentId does not match document id."
      )
    );
  }

  if (chunk.namespaceId !== document.namespaceId) {
    issues.push(
      issue(
        "error",
        "namespace_mismatch",
        chunk.id,
        "namespaceId",
        "Chunk namespaceId does not match document namespaceId."
      )
    );
  }

  if (
    chunk.accessScope.tenantId !== document.accessScope.tenantId ||
    chunk.accessScope.namespaceId !== document.accessScope.namespaceId
  ) {
    issues.push(
      issue(
        "error",
        "access_scope_mismatch",
        chunk.id,
        "accessScope",
        "Chunk access scope must be copied from the document."
      )
    );
  }

  if (
    chunk.provenance.sourceId !== document.provenance.sourceId ||
    chunk.provenance.trustTier !== document.provenance.trustTier
  ) {
    issues.push(
      issue(
        "error",
        "provenance_mismatch",
        chunk.id,
        "provenance",
        "Chunk provenance must be copied from the document."
      )
    );
  }

  if (
    chunk.citation.chunkId !== chunk.id ||
    chunk.citation.sourceId !== document.provenance.sourceId ||
    !chunk.citation.locator
  ) {
    issues.push(
      issue(
        "error",
        "citation_mismatch",
        chunk.id,
        "citation",
        "Chunk citation must point to the exact chunk and source."
      )
    );
  }

  if (
    chunk.characterStart < 0 ||
    chunk.characterEnd <= chunk.characterStart ||
    chunk.characterEnd > document.body.length
  ) {
    issues.push(
      issue(
        "error",
        "invalid_character_range",
        chunk.id,
        "characterStart/characterEnd",
        "Chunk character range is invalid for the source document."
      )
    );
  }

  if (
    chunk.characterStart >= 0 &&
    chunk.characterEnd > chunk.characterStart &&
    chunk.characterEnd <= document.body.length &&
    document.body.slice(chunk.characterStart, chunk.characterEnd) !== chunk.text
  ) {
    issues.push(
      issue(
        "error",
        "source_range_mismatch",
        chunk.id,
        "text",
        "Chunk text must match the recorded source document character range."
      )
    );
  }

  if (chunk.text.length > policy.maxCharacters) {
    issues.push(
      issue(
        "error",
        "invalid_chunk_size",
        chunk.id,
        "text",
        `Chunk exceeds maxCharacters=${policy.maxCharacters}.`
      )
    );
  }

  if (policy.includeTextHash && chunk.textHash !== hashText(chunk.text)) {
    issues.push(
      issue(
        "error",
        "hash_mismatch",
        chunk.id,
        "textHash",
        "Chunk textHash does not match chunk text."
      )
    );
  }

  if (!Array.isArray(chunk.safetyFlags)) {
    issues.push(
      issue(
        "error",
        "missing_safety_flags",
        chunk.id,
        "safetyFlags",
        "Chunk safetyFlags must be present."
      )
    );
  }

  validateLayoutEvidence(chunk, document, issues);

  const errors = issues.filter((validationIssue) => validationIssue.severity === "error");
  const warnings = issues.filter((validationIssue) => validationIssue.severity === "warning");

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

export function validateChunks(
  chunks: readonly RagChunk[],
  document: RagDocument,
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY
): ChunkValidationResult {
  const issues = chunks.flatMap((chunk) => validateChunk(chunk, document, policy).issues);
  const errors = issues.filter((validationIssue) => validationIssue.severity === "error");
  const warnings = issues.filter((validationIssue) => validationIssue.severity === "warning");

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

function validateLayoutEvidence(
  chunk: RagChunk,
  document: RagDocument,
  issues: ChunkValidationIssue[]
): void {
  const chunkRegionIds = chunk.layoutRegionIds ?? [];
  const citationRegionIds = chunk.citation.layoutRegionIds ?? [];
  const chunkBoxes = chunk.boundingBoxes ?? [];
  const citationBoxes = chunk.citation.boundingBoxes ?? [];

  if (!document.layout) {
    if (
      chunkRegionIds.length > 0 ||
      citationRegionIds.length > 0 ||
      chunkBoxes.length > 0 ||
      citationBoxes.length > 0 ||
      chunk.citation.pageNumber !== undefined
    ) {
      issues.push(
        issue(
          "error",
          "invalid_layout_reference",
          chunk.id,
          "layout",
          "Chunk cannot cite layout evidence when the source document has no validated layout."
        )
      );
    }
    return;
  }

  const regionsById = new Set(document.layout.regions.map((region) => region.id));
  const pagesByNumber = new Map(
    document.layout.pages.map((page) => [page.pageNumber, page] as const)
  );

  for (const [index, regionId] of chunkRegionIds.entries()) {
    if (!regionsById.has(regionId)) {
      issues.push(
        issue(
          "error",
          "invalid_layout_reference",
          chunk.id,
          `layoutRegionIds.${index}`,
          `Chunk references unknown layout region "${regionId}".`
        )
      );
    }
  }

  for (const [index, regionId] of citationRegionIds.entries()) {
    if (!regionsById.has(regionId)) {
      issues.push(
        issue(
          "error",
          "invalid_layout_reference",
          chunk.id,
          `citation.layoutRegionIds.${index}`,
          `Citation references unknown layout region "${regionId}".`
        )
      );
    }
  }

  if (!sameStrings(chunkRegionIds, citationRegionIds)) {
    issues.push(
      issue(
        "error",
        "layout_citation_mismatch",
        chunk.id,
        "citation.layoutRegionIds",
        "Citation layout region ids must match chunk layout region ids."
      )
    );
  }

  validateLayoutBoxes(chunkBoxes, pagesByNumber, chunk.id, "boundingBoxes", issues);
  validateLayoutBoxes(citationBoxes, pagesByNumber, chunk.id, "citation.boundingBoxes", issues);

  if (!sameBoxes(chunkBoxes, citationBoxes)) {
    issues.push(
      issue(
        "error",
        "layout_citation_mismatch",
        chunk.id,
        "citation.boundingBoxes",
        "Citation bounding boxes must match chunk bounding boxes."
      )
    );
  }

  if (chunk.citation.pageNumber !== undefined && !pagesByNumber.has(chunk.citation.pageNumber)) {
    issues.push(
      issue(
        "error",
        "invalid_layout_reference",
        chunk.id,
        "citation.pageNumber",
        `Citation references unknown page ${chunk.citation.pageNumber}.`
      )
    );
  }
}

function validateLayoutBoxes(
  boxes: readonly LayoutBox[],
  pagesByNumber: ReadonlyMap<number, DocumentLayoutPage>,
  chunkId: string,
  path: string,
  issues: ChunkValidationIssue[]
): void {
  for (const [index, box] of boxes.entries()) {
    const page = pagesByNumber.get(box.pageNumber);
    if (!page) {
      issues.push(
        issue(
          "error",
          "invalid_layout_box",
          chunkId,
          `${path}.${index}.pageNumber`,
          `Layout box references unknown page ${box.pageNumber}.`
        )
      );
      continue;
    }

    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.x < 0 ||
      box.y < 0 ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      issues.push(
        issue(
          "error",
          "invalid_layout_box",
          chunkId,
          `${path}.${index}`,
          "Layout box coordinates must be finite, non-negative, and have positive size."
        )
      );
      continue;
    }

    if (box.unit === "normalized") {
      if (box.x + box.width > 1 + Number.EPSILON || box.y + box.height > 1 + Number.EPSILON) {
        issues.push(
          issue(
            "error",
            "invalid_layout_box",
            chunkId,
            `${path}.${index}`,
            "Normalized layout boxes must fit inside 0..1."
          )
        );
      }
      continue;
    }

    if (box.unit !== page.unit) {
      issues.push(
        issue(
          "error",
          "invalid_layout_box",
          chunkId,
          `${path}.${index}.unit`,
          "Layout box unit must match its page unit."
        )
      );
      continue;
    }

    if (box.x + box.width > page.width || box.y + box.height > page.height) {
      issues.push(
        issue(
          "error",
          "invalid_layout_box",
          chunkId,
          `${path}.${index}`,
          "Layout box must fit inside the page."
        )
      );
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBoxes(left: readonly LayoutBox[], right: readonly LayoutBox[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function issue(
  severity: ChunkValidationSeverity,
  code: ChunkValidationCode,
  chunkId: string,
  path: string,
  message: string
): ChunkValidationIssue {
  return {
    severity,
    code,
    chunkId,
    path,
    message
  };
}
