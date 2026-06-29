import type { ChunkVector, VectorSnapshot } from "./vector-store.js";
import type { VisualChunkVector, VisualVectorSnapshot } from "./visual-vector-store.js";

export interface VectorGenerationInventoryEntry {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingConfigHash: string;
  readonly embeddingIndexConfigHash?: string;
  readonly vectorCount: number;
  readonly documentCount: number;
}

export interface VectorGenerationCleanupPlan {
  readonly deleteVectorIds: readonly string[];
  readonly keepVectorIds: readonly string[];
  readonly deleteCount: number;
  readonly keepCount: number;
}

export function vectorGenerationInventory(
  snapshot: VectorSnapshot | VisualVectorSnapshot
): readonly VectorGenerationInventoryEntry[] {
  const vectors = snapshot.vectors.map((entry) =>
    "vector" in entry ? entry.vector : entry.visualVector
  );
  const grouped = new Map<
    string,
    { readonly vector: ChunkVector | VisualChunkVector; count: number; documents: Set<string> }
  >();

  for (const vector of vectors) {
    const key = generationKey(vector);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.documents.add(vector.documentId);
    } else {
      grouped.set(key, {
        vector,
        count: 1,
        documents: new Set([vector.documentId])
      });
    }
  }

  return [...grouped.values()]
    .map((entry): VectorGenerationInventoryEntry => {
      const embeddingIndexConfigHash = metadataString(
        entry.vector.metadata,
        "embeddingIndexConfigHash"
      );
      return {
        tenantId: entry.vector.tenantId,
        namespaceId: entry.vector.namespaceId,
        embeddingProvider: entry.vector.embeddingProvider ?? "unknown",
        embeddingModel: entry.vector.embeddingModel,
        embeddingConfigHash: entry.vector.embeddingConfigHash ?? "unknown",
        ...(embeddingIndexConfigHash === undefined ? {} : { embeddingIndexConfigHash }),
        vectorCount: entry.count,
        documentCount: entry.documents.size
      };
    })
    .sort(compareInventoryEntries);
}

export function planVectorGenerationCleanup(
  snapshot: VectorSnapshot | VisualVectorSnapshot,
  options: {
    readonly keepEmbeddingConfigHashes: readonly string[];
    readonly tenantId?: string;
    readonly namespaceId?: string;
  }
): VectorGenerationCleanupPlan {
  const keepHashes = new Set(options.keepEmbeddingConfigHashes);
  const vectors = snapshot.vectors.map((entry) =>
    "vector" in entry ? entry.vector : entry.visualVector
  );
  const deleteVectorIds: string[] = [];
  const keepVectorIds: string[] = [];

  for (const vector of vectors) {
    const inScope =
      (options.tenantId === undefined || vector.tenantId === options.tenantId) &&
      (options.namespaceId === undefined || vector.namespaceId === options.namespaceId);
    const shouldDelete = inScope && !keepHashes.has(vector.embeddingConfigHash ?? "unknown");

    if (shouldDelete) {
      deleteVectorIds.push(vector.id);
    } else {
      keepVectorIds.push(vector.id);
    }
  }

  return {
    deleteVectorIds: deleteVectorIds.sort(),
    keepVectorIds: keepVectorIds.sort(),
    deleteCount: deleteVectorIds.length,
    keepCount: keepVectorIds.length
  };
}

function generationKey(vector: ChunkVector | VisualChunkVector): string {
  return JSON.stringify({
    tenantId: vector.tenantId,
    namespaceId: vector.namespaceId,
    embeddingProvider: vector.embeddingProvider ?? "unknown",
    embeddingModel: vector.embeddingModel,
    embeddingConfigHash: vector.embeddingConfigHash ?? "unknown",
    embeddingIndexConfigHash: metadataString(vector.metadata, "embeddingIndexConfigHash")
  });
}

function metadataString(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function compareInventoryEntries(
  first: VectorGenerationInventoryEntry,
  second: VectorGenerationInventoryEntry
): number {
  return (
    first.tenantId.localeCompare(second.tenantId) ||
    first.namespaceId.localeCompare(second.namespaceId) ||
    first.embeddingProvider.localeCompare(second.embeddingProvider) ||
    first.embeddingModel.localeCompare(second.embeddingModel) ||
    first.embeddingConfigHash.localeCompare(second.embeddingConfigHash) ||
    (first.embeddingIndexConfigHash ?? "").localeCompare(second.embeddingIndexConfigHash ?? "")
  );
}
