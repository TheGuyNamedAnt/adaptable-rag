import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { DocumentLayoutRelation, DocumentLayoutRegion } from "../documents/layout.js";
import type { ChunkVector, VectorStore } from "../indexing/vector-store.js";
import type { EmbeddingAdapter } from "./embedding-types.js";

export interface LayoutRelationIndexerOptions {
  readonly adapter: EmbeddingAdapter;
  readonly vectorStore: VectorStore;
  readonly now?: () => string;
}

export interface LayoutRelationIndexRequest {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly requestedAt?: string;
  readonly overwriteMode?: "reject" | "replace";
}

export type LayoutRelationIndexWarningCode =
  | "missing_document"
  | "missing_region"
  | "missing_anchor_chunk"
  | "embedding_failed"
  | "missing_embedding"
  | "dimension_mismatch";

export interface LayoutRelationIndexWarning {
  readonly code: LayoutRelationIndexWarningCode;
  readonly documentId?: string;
  readonly relationId?: string;
  readonly message: string;
}

export interface LayoutRelationIndexResult {
  readonly embeddedAt: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly candidateRelationCount: number;
  readonly indexedRelationVectorCount: number;
  readonly skippedRelationCount: number;
  readonly warnings: readonly LayoutRelationIndexWarning[];
}

interface LayoutRelationInput {
  readonly id: string;
  readonly text: string;
  readonly relation: DocumentLayoutRelation;
  readonly document: RagDocument;
  readonly chunk: RagChunk;
}

export class LayoutRelationIndexer {
  private readonly adapter: EmbeddingAdapter;
  private readonly vectorStore: VectorStore;
  private readonly now: () => string;

  constructor(options: LayoutRelationIndexerOptions) {
    this.adapter = options.adapter;
    this.vectorStore = options.vectorStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async indexRelations(request: LayoutRelationIndexRequest): Promise<LayoutRelationIndexResult> {
    const embeddedAt = request.requestedAt ?? this.now();
    const warnings: LayoutRelationIndexWarning[] = [];
    const inputs = layoutRelationInputsForChunks(request.documents, request.chunks, warnings);

    if (inputs.length === 0) {
      return {
        embeddedAt,
        provider: this.adapter.provider,
        modelName: this.adapter.modelName,
        dimensions: this.adapter.dimensions,
        candidateRelationCount: 0,
        indexedRelationVectorCount: 0,
        skippedRelationCount: 0,
        warnings
      };
    }

    const result = await this.adapter.embed({
      inputs: inputs.map((input) => ({
        id: input.id,
        text: input.text,
        metadata: {
          kind: "layout_relation",
          relationId: input.relation.id,
          relationKind: input.relation.kind,
          documentId: input.document.id,
          chunkId: input.chunk.id
        }
      })),
      requestedAt: embeddedAt
    });

    if (result.status === "failed") {
      return {
        embeddedAt,
        provider: result.provider,
        modelName: result.modelName,
        dimensions: result.dimensions,
        candidateRelationCount: inputs.length,
        indexedRelationVectorCount: 0,
        skippedRelationCount: inputs.length,
        warnings: [
          ...warnings,
          {
            code: "embedding_failed",
            message: result.errorMessage ?? "Embedding adapter failed for layout relations."
          }
        ]
      };
    }

    const embeddingsById = new Map(result.embeddings.map((embedding) => [embedding.id, embedding]));
    const vectors: ChunkVector[] = [];

    for (const input of inputs) {
      const embedding = embeddingsById.get(input.id);
      if (!embedding) {
        warnings.push({
          code: "missing_embedding",
          documentId: input.document.id,
          relationId: input.relation.id,
          message: "Embedding adapter did not return an embedding for this layout relation."
        });
        continue;
      }

      if (embedding.vector.length !== result.dimensions) {
        warnings.push({
          code: "dimension_mismatch",
          documentId: input.document.id,
          relationId: input.relation.id,
          message:
            "Layout relation embedding dimensions did not match the adapter result dimensions."
        });
        continue;
      }

      vectors.push({
        id: layoutRelationVectorId(result.modelName, input.document.id, input.relation.id),
        chunkId: input.chunk.id,
        documentId: input.chunk.documentId,
        tenantId: input.chunk.accessScope.tenantId,
        namespaceId: input.chunk.namespaceId,
        textHash: input.chunk.textHash,
        embeddingModel: result.modelName,
        dimensions: result.dimensions,
        vector: embedding.vector,
        embeddedAt,
        metadata: {
          kind: "layout_relation",
          relationId: input.relation.id,
          relationKind: input.relation.kind,
          fromRegionId: input.relation.fromRegionId,
          toRegionId: input.relation.toRegionId
        }
      });
    }

    const indexResults = await this.vectorStore.addChunkVectors(vectors, {
      overwriteMode: request.overwriteMode ?? "replace",
      indexedAt: embeddedAt
    });

    return {
      embeddedAt,
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      candidateRelationCount: inputs.length,
      indexedRelationVectorCount: indexResults.filter((indexResult) => indexResult.accepted).length,
      skippedRelationCount: inputs.length - vectors.length,
      warnings
    };
  }
}

export function layoutRelationInputsForChunks(
  documents: readonly RagDocument[],
  chunks: readonly RagChunk[],
  warnings: LayoutRelationIndexWarning[] = []
): readonly LayoutRelationInput[] {
  const chunksByDocumentId = groupChunksByDocumentId(chunks);
  const inputs: LayoutRelationInput[] = [];

  for (const document of documents) {
    const layout = document.layout;
    if (!layout || (layout.relations ?? []).length === 0) {
      continue;
    }

    const chunksForDocument = chunksByDocumentId.get(document.id) ?? [];
    const regionsById = new Map(layout.regions.map((region) => [region.id, region]));

    for (const relation of layout.relations ?? []) {
      const from = regionsById.get(relation.fromRegionId);
      const to = regionsById.get(relation.toRegionId);
      if (!from || !to) {
        warnings.push({
          code: "missing_region",
          documentId: document.id,
          relationId: relation.id,
          message: "Layout relation references a region that is not present on the document."
        });
        continue;
      }

      const chunk = anchorChunkForRelation(relation, chunksForDocument);
      if (!chunk) {
        warnings.push({
          code: "missing_anchor_chunk",
          documentId: document.id,
          relationId: relation.id,
          message: "No accepted chunk carries either side of this layout relation."
        });
        continue;
      }

      inputs.push({
        id: layoutRelationInputId(document.id, relation.id),
        text: layoutRelationText(relation, from, to),
        relation,
        document,
        chunk
      });
    }
  }

  const documentIds = new Set(documents.map((document) => document.id));
  for (const documentId of chunksByDocumentId.keys()) {
    if (!documentIds.has(documentId)) {
      warnings.push({
        code: "missing_document",
        documentId,
        message: "Accepted chunks included a document that was not passed to relation indexing."
      });
    }
  }

  return inputs;
}

function layoutRelationText(
  relation: DocumentLayoutRelation,
  from: DocumentLayoutRegion,
  to: DocumentLayoutRegion
): string {
  const fromText = regionText(from);
  const toText = regionText(to);
  return [
    `Layout relation: ${relation.kind}.`,
    `From ${from.kind} ${from.id} on page ${from.pageNumber}: ${fromText}`,
    `To ${to.kind} ${to.id} on page ${to.pageNumber}: ${toText}`
  ].join("\n");
}

function regionText(region: DocumentLayoutRegion): string {
  const text = region.text?.trim();
  return text && text.length > 0 ? text : "[visual region]";
}

function anchorChunkForRelation(
  relation: DocumentLayoutRelation,
  chunks: readonly RagChunk[]
): RagChunk | undefined {
  return (
    chunks.find((chunk) => chunk.layoutRegionIds?.includes(relation.fromRegionId)) ??
    chunks.find((chunk) => chunk.layoutRegionIds?.includes(relation.toRegionId))
  );
}

function groupChunksByDocumentId(chunks: readonly RagChunk[]): ReadonlyMap<string, RagChunk[]> {
  const grouped = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    const existing = grouped.get(chunk.documentId) ?? [];
    existing.push(chunk);
    grouped.set(chunk.documentId, existing);
  }
  return grouped;
}

function layoutRelationInputId(documentId: string, relationId: string): string {
  return `layout_relation_${sanitizeId(documentId)}_${sanitizeId(relationId)}`;
}

function layoutRelationVectorId(modelName: string, documentId: string, relationId: string): string {
  return `${sanitizeId(modelName)}_${layoutRelationInputId(documentId, relationId)}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}
