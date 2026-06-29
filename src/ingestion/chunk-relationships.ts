import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";

export type ChunkRelationshipKind =
  | "previous_chunk"
  | "next_chunk"
  | "same_section"
  | "caption_for"
  | "explains"
  | "continues_as"
  | "references";

export interface ChunkRelationship {
  readonly id: string;
  readonly documentId: string;
  readonly fromChunkId: string;
  readonly toChunkId: string;
  readonly kind: ChunkRelationshipKind;
  readonly evidence: "chunk_order" | "layout_relation";
  readonly weight: number;
}

export function buildChunkRelationships(input: {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
}): readonly ChunkRelationship[] {
  const relationships = new Map<string, ChunkRelationship>();
  const chunksByDocumentId = groupChunksByDocumentId(input.chunks);
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));

  for (const [documentId, chunks] of chunksByDocumentId) {
    const ordered = [...chunks].sort((first, second) => first.index - second.index);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (!current || !next) {
        continue;
      }
      addRelationship(relationships, {
        documentId,
        fromChunkId: current.id,
        toChunkId: next.id,
        kind: "next_chunk",
        evidence: "chunk_order",
        weight: 0.82
      });
      addRelationship(relationships, {
        documentId,
        fromChunkId: next.id,
        toChunkId: current.id,
        kind: "previous_chunk",
        evidence: "chunk_order",
        weight: 0.82
      });
    }

    const document = documentsById.get(documentId);
    if (document?.layout) {
      addLayoutRelationships(relationships, document, chunks);
    }
  }

  return [...relationships.values()].sort((first, second) => first.id.localeCompare(second.id));
}

function addLayoutRelationships(
  relationships: Map<string, ChunkRelationship>,
  document: RagDocument,
  chunks: readonly RagChunk[]
): void {
  const relations = document.layout?.relations ?? [];
  if (relations.length === 0) {
    return;
  }

  for (const relation of relations) {
    const fromChunks = chunksForRegion(chunks, relation.fromRegionId);
    const toChunks = chunksForRegion(chunks, relation.toRegionId);
    for (const fromChunk of fromChunks) {
      for (const toChunk of toChunks) {
        if (fromChunk.id === toChunk.id) {
          continue;
        }
        addRelationship(relationships, {
          documentId: document.id,
          fromChunkId: fromChunk.id,
          toChunkId: toChunk.id,
          kind: relation.kind,
          evidence: "layout_relation",
          weight: layoutRelationWeight(relation.kind)
        });
      }
    }
  }
}

function chunksForRegion(chunks: readonly RagChunk[], regionId: string): readonly RagChunk[] {
  return chunks.filter((chunk) => chunk.layoutRegionIds?.includes(regionId) === true);
}

function addRelationship(
  relationships: Map<string, ChunkRelationship>,
  relationship: Omit<ChunkRelationship, "id">
): void {
  const id = [
    "chunk_rel",
    relationship.kind,
    relationship.fromChunkId,
    relationship.toChunkId
  ].join(":");
  const existing = relationships.get(id);
  if (!existing || relationship.weight > existing.weight) {
    relationships.set(id, { id, ...relationship });
  }
}

function groupChunksByDocumentId(
  chunks: readonly RagChunk[]
): ReadonlyMap<string, readonly RagChunk[]> {
  const groups = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.documentId) ?? [];
    group.push(chunk);
    groups.set(chunk.documentId, group);
  }
  return groups;
}

function layoutRelationWeight(kind: ChunkRelationshipKind): number {
  switch (kind) {
    case "caption_for":
    case "explains":
      return 0.9;
    case "continues_as":
    case "same_section":
      return 0.86;
    case "references":
      return 0.78;
    case "previous_chunk":
    case "next_chunk":
      return 0.82;
  }
}
