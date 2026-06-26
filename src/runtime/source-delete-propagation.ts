import type { GraphEvidencePruneResult, GraphStore } from "../graph/in-memory-graph-store.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { DocumentStore } from "../indexing/document-store.js";
import type {
  IndexChunkDeleteResult,
  IndexDocumentDeleteResult,
  IndexFilter
} from "../indexing/index-types.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import type { SourceSyncDeletedItem } from "../sync/sync-runner.js";

export type SourceDeletePropagationStatus = "succeeded" | "partial" | "failed" | "skipped";
export type SourceDeletePropagationItemStatus = "succeeded" | "failed" | "skipped";

export interface SourceDeletePropagationRequest {
  readonly deleted: readonly SourceSyncDeletedItem[];
  readonly filter: IndexFilter;
  readonly documentStore: DocumentStore;
  readonly chunkStore: ChunkStore;
  readonly vectorStore?: VectorStore;
  readonly visualVectorStore?: VisualVectorStore;
  readonly graphStore?: GraphStore;
  readonly propagationId?: string;
  readonly requestedAt?: string;
  readonly now?: () => string;
}

export interface SourceDeletePropagationItemResult {
  readonly status: SourceDeletePropagationItemStatus;
  readonly sourceItemIds: readonly string[];
  readonly documentId?: string;
  readonly deletedDocumentCount: number;
  readonly deletedChunkCount: number;
  readonly deletedVectorCount: number;
  readonly deletedVisualVectorCount: number;
  readonly prunedKnowledgeEntityCount: number;
  readonly prunedKnowledgeRelationCount: number;
  readonly prunedKnowledgeEvidenceAnchorCount: number;
  readonly errors: readonly SourceDeletePropagationError[];
}

export interface SourceDeletePropagationError {
  readonly code: SourceDeletePropagationErrorCode;
  readonly message: string;
  readonly sourceItemId?: string;
  readonly documentId?: string;
}

export type SourceDeletePropagationErrorCode =
  | "missing_record_id"
  | "document_delete_failed"
  | "chunk_delete_failed"
  | "vector_delete_failed"
  | "visual_vector_delete_failed"
  | "knowledge_prune_failed";

export interface SourceDeletePropagationMetrics {
  readonly requestedDeleteCount: number;
  readonly propagatedDocumentCount: number;
  readonly skippedDeleteCount: number;
  readonly failedDocumentCount: number;
  readonly deletedDocumentCount: number;
  readonly deletedChunkCount: number;
  readonly deletedVectorCount: number;
  readonly deletedVisualVectorCount: number;
  readonly prunedKnowledgeEntityCount: number;
  readonly prunedKnowledgeRelationCount: number;
  readonly prunedKnowledgeEvidenceAnchorCount: number;
}

export interface SourceDeletePropagationResult {
  readonly status: SourceDeletePropagationStatus;
  readonly propagationId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly SourceDeletePropagationItemResult[];
  readonly errors: readonly SourceDeletePropagationError[];
  readonly metrics: SourceDeletePropagationMetrics;
  readonly evidenceBoundary: readonly string[];
}

export async function propagateSourceDeletes(
  request: SourceDeletePropagationRequest
): Promise<SourceDeletePropagationResult> {
  const now = request.now ?? (() => new Date().toISOString());
  const startedAt = request.requestedAt ?? now();
  const propagationId =
    request.propagationId ?? `source_delete_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
  const groups = groupByDocumentId(request.deleted);
  const results: SourceDeletePropagationItemResult[] = [];

  for (const item of request.deleted) {
    if (!item.recordId?.trim()) {
      results.push(skippedItem(item));
    }
  }

  for (const group of groups) {
    results.push(await propagateOneDocument(request, group));
  }

  const errors = results.flatMap((result) => result.errors);
  const status = propagationStatus(results);

  return {
    status,
    propagationId,
    startedAt,
    finishedAt: now(),
    results,
    errors,
    metrics: sourceDeletePropagationMetrics(request.deleted.length, results),
    evidenceBoundary: sourceDeletePropagationEvidenceBoundary()
  };
}

export function sourceDeletePropagationEvidenceBoundary(): readonly string[] {
  return [
    "source item ids",
    "corpus record ids used as document ids",
    "deleted document/chunk/vector counts",
    "knowledge evidence prune counts",
    "safe error codes and redacted messages"
  ];
}

function groupByDocumentId(
  deleted: readonly SourceSyncDeletedItem[]
): readonly { readonly documentId: string; readonly sourceItemIds: readonly string[] }[] {
  const byDocumentId = new Map<string, Set<string>>();
  for (const item of deleted) {
    const documentId = item.recordId?.trim();
    if (!documentId) {
      continue;
    }
    const existing = byDocumentId.get(documentId) ?? new Set<string>();
    existing.add(item.sourceItemId);
    byDocumentId.set(documentId, existing);
  }

  return [...byDocumentId.entries()]
    .map(([documentId, sourceItemIds]) => ({
      documentId,
      sourceItemIds: [...sourceItemIds].sort()
    }))
    .sort((first, second) => first.documentId.localeCompare(second.documentId));
}

async function propagateOneDocument(
  request: SourceDeletePropagationRequest,
  group: { readonly documentId: string; readonly sourceItemIds: readonly string[] }
): Promise<SourceDeletePropagationItemResult> {
  const errors: SourceDeletePropagationError[] = [];
  let deletedDocumentCount = 0;
  let deletedChunkCount = 0;
  let deletedVectorCount = 0;
  let deletedVisualVectorCount = 0;
  let prunedKnowledgeEntityCount = 0;
  let prunedKnowledgeRelationCount = 0;
  let prunedKnowledgeEvidenceAnchorCount = 0;

  const vectorCount = await safeDeleteCount({
    code: "vector_delete_failed",
    documentId: group.documentId,
    errors,
    run: async () => await request.vectorStore?.deleteVectorsForDocument(group.documentId)
  });
  deletedVectorCount += vectorCount;

  const visualVectorCount = await safeDeleteCount({
    code: "visual_vector_delete_failed",
    documentId: group.documentId,
    errors,
    run: async () =>
      await request.visualVectorStore?.deleteVisualVectorsForDocument(group.documentId)
  });
  deletedVisualVectorCount += visualVectorCount;

  const knowledge = await safePruneKnowledge({
    graphStore: request.graphStore,
    filter: request.filter,
    documentId: group.documentId,
    errors
  });
  prunedKnowledgeEntityCount += knowledge.prunedEntityCount;
  prunedKnowledgeRelationCount += knowledge.prunedRelationCount;
  prunedKnowledgeEvidenceAnchorCount += knowledge.removedEvidenceAnchorCount;

  const chunkDelete = await safeDeleteChunks({
    chunkStore: request.chunkStore,
    filter: request.filter,
    documentId: group.documentId,
    errors
  });
  deletedChunkCount += chunkDelete.deletedChunkCount;

  const documentDelete = await safeDeleteDocument({
    documentStore: request.documentStore,
    filter: request.filter,
    documentId: group.documentId,
    errors
  });
  deletedDocumentCount += documentDelete.deletedDocumentCount;

  return {
    status: errors.length > 0 ? "failed" : "succeeded",
    sourceItemIds: group.sourceItemIds,
    documentId: group.documentId,
    deletedDocumentCount,
    deletedChunkCount,
    deletedVectorCount,
    deletedVisualVectorCount,
    prunedKnowledgeEntityCount,
    prunedKnowledgeRelationCount,
    prunedKnowledgeEvidenceAnchorCount,
    errors
  };
}

function skippedItem(item: SourceSyncDeletedItem): SourceDeletePropagationItemResult {
  return {
    status: "skipped",
    sourceItemIds: [item.sourceItemId],
    deletedDocumentCount: 0,
    deletedChunkCount: 0,
    deletedVectorCount: 0,
    deletedVisualVectorCount: 0,
    prunedKnowledgeEntityCount: 0,
    prunedKnowledgeRelationCount: 0,
    prunedKnowledgeEvidenceAnchorCount: 0,
    errors: [
      {
        code: "missing_record_id",
        sourceItemId: item.sourceItemId,
        message: "Source delete item did not include the corpus record id needed for propagation."
      }
    ]
  };
}

async function safeDeleteCount(input: {
  readonly code: SourceDeletePropagationErrorCode;
  readonly documentId: string;
  readonly errors: SourceDeletePropagationError[];
  readonly run: () => Promise<number | undefined>;
}): Promise<number> {
  try {
    return (await input.run()) ?? 0;
  } catch (error) {
    input.errors.push({
      code: input.code,
      documentId: input.documentId,
      message: redactedErrorMessage(error)
    });
    return 0;
  }
}

async function safePruneKnowledge(input: {
  readonly graphStore: GraphStore | undefined;
  readonly filter: IndexFilter;
  readonly documentId: string;
  readonly errors: SourceDeletePropagationError[];
}): Promise<GraphEvidencePruneResult> {
  if (input.graphStore === undefined) {
    return emptyKnowledgePruneResult();
  }

  try {
    return input.graphStore.pruneEvidence({
      filter: input.filter,
      documentIds: [input.documentId]
    });
  } catch (error) {
    input.errors.push({
      code: "knowledge_prune_failed",
      documentId: input.documentId,
      message: redactedErrorMessage(error)
    });
    return emptyKnowledgePruneResult();
  }
}

async function safeDeleteChunks(input: {
  readonly chunkStore: ChunkStore;
  readonly filter: IndexFilter;
  readonly documentId: string;
  readonly errors: SourceDeletePropagationError[];
}): Promise<IndexChunkDeleteResult> {
  try {
    return await input.chunkStore.deleteChunksForDocument(input.documentId, input.filter);
  } catch (error) {
    input.errors.push({
      code: "chunk_delete_failed",
      documentId: input.documentId,
      message: redactedErrorMessage(error)
    });
    return {
      accepted: false,
      documentId: input.documentId,
      deletedChunkCount: 0,
      message: "Chunk delete failed."
    };
  }
}

async function safeDeleteDocument(input: {
  readonly documentStore: DocumentStore;
  readonly filter: IndexFilter;
  readonly documentId: string;
  readonly errors: SourceDeletePropagationError[];
}): Promise<IndexDocumentDeleteResult> {
  try {
    return await input.documentStore.deleteDocument(input.documentId, input.filter);
  } catch (error) {
    input.errors.push({
      code: "document_delete_failed",
      documentId: input.documentId,
      message: redactedErrorMessage(error)
    });
    return {
      accepted: false,
      documentId: input.documentId,
      deletedDocumentCount: 0,
      message: "Document delete failed."
    };
  }
}

function sourceDeletePropagationMetrics(
  requestedDeleteCount: number,
  results: readonly SourceDeletePropagationItemResult[]
): SourceDeletePropagationMetrics {
  return {
    requestedDeleteCount,
    propagatedDocumentCount: results.filter((result) => result.status === "succeeded").length,
    skippedDeleteCount: results.filter((result) => result.status === "skipped").length,
    failedDocumentCount: results.filter((result) => result.status === "failed").length,
    deletedDocumentCount: sum(results, (result) => result.deletedDocumentCount),
    deletedChunkCount: sum(results, (result) => result.deletedChunkCount),
    deletedVectorCount: sum(results, (result) => result.deletedVectorCount),
    deletedVisualVectorCount: sum(results, (result) => result.deletedVisualVectorCount),
    prunedKnowledgeEntityCount: sum(results, (result) => result.prunedKnowledgeEntityCount),
    prunedKnowledgeRelationCount: sum(results, (result) => result.prunedKnowledgeRelationCount),
    prunedKnowledgeEvidenceAnchorCount: sum(
      results,
      (result) => result.prunedKnowledgeEvidenceAnchorCount
    )
  };
}

function propagationStatus(
  results: readonly SourceDeletePropagationItemResult[]
): SourceDeletePropagationStatus {
  if (results.length === 0) {
    return "skipped";
  }
  if (results.every((result) => result.status === "skipped")) {
    return "skipped";
  }
  if (results.every((result) => result.status === "failed" || result.status === "skipped")) {
    return "failed";
  }
  if (results.some((result) => result.status !== "succeeded")) {
    return "partial";
  }
  return "succeeded";
}

function emptyKnowledgePruneResult(): GraphEvidencePruneResult {
  return {
    accepted: false,
    prunedEntityCount: 0,
    prunedRelationCount: 0,
    supersededEntityCount: 0,
    supersededRelationCount: 0,
    removedEvidenceAnchorCount: 0
  };
}

function sum<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

function redactedErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Delete propagation failed.";
  }
  return error.message.replace(
    /(bearer|api[_-]?key|token|secret)\s*[:=]\s*\S+/giu,
    "$1=[redacted]"
  );
}
