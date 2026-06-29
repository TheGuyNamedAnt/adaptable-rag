import type { VectorGenerationInventoryEntry } from "./vector-generation-lifecycle.js";

export type StorageScaleOperationResult<T> = T | Promise<T>;

export type StorageScaleTopology = "embedded" | "database" | "hosted";

export type ScaleFeatureMode = "unsupported" | "sync" | "async" | "external";

export type ScalePartitionKey =
  | "tenant_id"
  | "namespace_id"
  | "source_id"
  | "document_id"
  | "embedding_config_hash"
  | "dimensions";

export interface ScaleFeatureCapability {
  readonly supported: boolean;
  readonly mode: ScaleFeatureMode;
  readonly reason: string;
}

export interface StorageScaleCapabilities {
  readonly topology: StorageScaleTopology;
  readonly stats: ScaleFeatureCapability;
  readonly generationInventory: ScaleFeatureCapability;
  readonly readinessCheck: ScaleFeatureCapability;
  readonly metadataFiltering: ScaleFeatureCapability;
  readonly batchUpsert: ScaleFeatureCapability;
  readonly deleteByDocument: ScaleFeatureCapability;
  readonly deleteByFilter: ScaleFeatureCapability;
  readonly cursorPagination: ScaleFeatureCapability;
  readonly partitioning: ScaleFeatureCapability;
  readonly annIndex: ScaleFeatureCapability;
  readonly resumableBackfill: ScaleFeatureCapability;
  readonly partitionKeys: readonly ScalePartitionKey[];
}

export interface VectorGenerationInventoryProvider {
  vectorGenerationInventory(): StorageScaleOperationResult<
    readonly VectorGenerationInventoryEntry[]
  >;
}

export function isVectorGenerationInventoryProvider(
  value: unknown
): value is VectorGenerationInventoryProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { vectorGenerationInventory?: unknown }).vectorGenerationInventory ===
      "function"
  );
}

export function supportedScaleFeature(
  mode: Exclude<ScaleFeatureMode, "unsupported">,
  reason: string
): ScaleFeatureCapability {
  return {
    supported: true,
    mode,
    reason
  };
}

export function unsupportedScaleFeature(reason: string): ScaleFeatureCapability {
  return {
    supported: false,
    mode: "unsupported",
    reason
  };
}

export const LOCAL_INDEX_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  topology: "embedded",
  stats: supportedScaleFeature("sync", "Local indexes can count in-process documents and chunks."),
  generationInventory: unsupportedScaleFeature(
    "Document/chunk indexes do not own vector generations."
  ),
  readinessCheck: unsupportedScaleFeature(
    "Local indexes have no external storage readiness check."
  ),
  metadataFiltering: supportedScaleFeature("sync", "Filters are evaluated in-process."),
  batchUpsert: supportedScaleFeature(
    "sync",
    "Documents and chunks can be indexed in local batches."
  ),
  deleteByDocument: supportedScaleFeature(
    "sync",
    "Documents and their chunks can be deleted locally."
  ),
  deleteByFilter: unsupportedScaleFeature(
    "Bulk filter deletion is not exposed by the local contract."
  ),
  cursorPagination: unsupportedScaleFeature(
    "Local list operations are bounded by the caller limit."
  ),
  partitioning: unsupportedScaleFeature("Embedded stores do not partition data."),
  annIndex: unsupportedScaleFeature("Document/chunk indexes do not own vector ANN indexes."),
  resumableBackfill: unsupportedScaleFeature(
    "Backfill resumption belongs to the ingestion job layer."
  ),
  partitionKeys: []
};

export const SQLITE_INDEX_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  ...LOCAL_INDEX_SCALE_CAPABILITIES,
  topology: "embedded",
  readinessCheck: supportedScaleFeature(
    "sync",
    "SQLite readiness can verify local schema and FTS availability."
  ),
  metadataFiltering: supportedScaleFeature(
    "sync",
    "Filters are pushed into local SQLite reads where possible."
  )
};

export const POSTGRES_INDEX_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  topology: "database",
  stats: supportedScaleFeature("async", "Postgres computes document/chunk counts with SQL."),
  generationInventory: unsupportedScaleFeature(
    "Document/chunk indexes do not own vector generations."
  ),
  readinessCheck: supportedScaleFeature(
    "async",
    "Postgres readiness can verify schema and indexes."
  ),
  metadataFiltering: supportedScaleFeature(
    "async",
    "Tenant, namespace, and access filters are pushed to SQL."
  ),
  batchUpsert: supportedScaleFeature("async", "Batch APIs run inside database transactions."),
  deleteByDocument: supportedScaleFeature(
    "async",
    "Document deletes cascade through indexed chunks."
  ),
  deleteByFilter: unsupportedScaleFeature(
    "Bulk filter deletion is not exposed by the index contract yet."
  ),
  cursorPagination: unsupportedScaleFeature(
    "Cursor pagination is not exposed by the index contract yet."
  ),
  partitioning: unsupportedScaleFeature(
    "Portable partition keys exist, but table partitions are not wired yet."
  ),
  annIndex: unsupportedScaleFeature("Document/chunk indexes do not own vector ANN indexes."),
  resumableBackfill: unsupportedScaleFeature(
    "Backfill resumption belongs to the ingestion job layer."
  ),
  partitionKeys: ["tenant_id", "namespace_id", "source_id", "document_id"]
};

export const LOCAL_VECTOR_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  topology: "embedded",
  stats: supportedScaleFeature("sync", "Local vector stores can count in-process vectors."),
  generationInventory: supportedScaleFeature(
    "sync",
    "Generation inventory is derived from a bounded local snapshot."
  ),
  readinessCheck: unsupportedScaleFeature("Local vector stores have no external readiness check."),
  metadataFiltering: supportedScaleFeature("sync", "Vector filters are evaluated in-process."),
  batchUpsert: supportedScaleFeature("sync", "Chunk vectors can be indexed in local batches."),
  deleteByDocument: supportedScaleFeature("sync", "Vectors can be deleted by document id."),
  deleteByFilter: unsupportedScaleFeature(
    "Bulk filter deletion is not exposed by the vector contract yet."
  ),
  cursorPagination: unsupportedScaleFeature(
    "Cursor pagination is not exposed by the vector contract yet."
  ),
  partitioning: unsupportedScaleFeature("Embedded stores do not partition data."),
  annIndex: unsupportedScaleFeature("Embedded stores use exact similarity, not ANN indexes."),
  resumableBackfill: unsupportedScaleFeature(
    "Backfill resumption belongs to the ingestion job layer."
  ),
  partitionKeys: []
};

export const POSTGRES_VECTOR_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  topology: "database",
  stats: supportedScaleFeature("async", "Postgres computes vector counts with SQL."),
  generationInventory: supportedScaleFeature(
    "async",
    "Postgres groups vector generations in SQL without loading full snapshots."
  ),
  readinessCheck: supportedScaleFeature(
    "async",
    "Postgres vector readiness verifies pgvector, identity indexes, dimensions, and ANN indexes."
  ),
  metadataFiltering: supportedScaleFeature(
    "async",
    "Tenant, namespace, embedding identity, and dimension filters are pushed to SQL."
  ),
  batchUpsert: supportedScaleFeature(
    "async",
    "Chunk vectors can be written in transactional batches."
  ),
  deleteByDocument: supportedScaleFeature("async", "Vectors can be deleted by document id."),
  deleteByFilter: unsupportedScaleFeature(
    "Bulk filter deletion is not exposed by the vector contract yet."
  ),
  cursorPagination: unsupportedScaleFeature(
    "Cursor pagination is not exposed by the vector contract yet."
  ),
  partitioning: unsupportedScaleFeature(
    "Portable partition keys exist, but table partitions are not wired yet."
  ),
  annIndex: supportedScaleFeature(
    "async",
    "Dimension-specific pgvector ANN indexes can be verified."
  ),
  resumableBackfill: unsupportedScaleFeature(
    "Backfill resumption belongs to the ingestion job layer."
  ),
  partitionKeys: ["tenant_id", "namespace_id", "embedding_config_hash", "dimensions"]
};

export const HOSTED_VECTOR_SCALE_CAPABILITIES: StorageScaleCapabilities = {
  topology: "hosted",
  stats: supportedScaleFeature(
    "external",
    "Counts are available only when the hosted transport exposes a count operation."
  ),
  generationInventory: unsupportedScaleFeature(
    "Hosted transports do not expose portable generation inventory yet."
  ),
  readinessCheck: unsupportedScaleFeature("Hosted vector readiness is vendor-specific today."),
  metadataFiltering: supportedScaleFeature(
    "external",
    "Tenant, namespace, and embedding identity are sent as vendor metadata filters."
  ),
  batchUpsert: supportedScaleFeature(
    "external",
    "Batch writes are delegated to the hosted vector vendor."
  ),
  deleteByDocument: supportedScaleFeature(
    "external",
    "Document deletion is delegated to the hosted vendor."
  ),
  deleteByFilter: unsupportedScaleFeature("Portable hosted delete-by-filter is not exposed yet."),
  cursorPagination: unsupportedScaleFeature(
    "Portable hosted cursor pagination is not exposed yet."
  ),
  partitioning: supportedScaleFeature(
    "external",
    "Hosted vendors usually map partitioning to namespaces, collections, or metadata filters."
  ),
  annIndex: supportedScaleFeature(
    "external",
    "ANN behavior is owned by the hosted vector backend."
  ),
  resumableBackfill: unsupportedScaleFeature(
    "Backfill resumption belongs to the ingestion job layer."
  ),
  partitionKeys: ["tenant_id", "namespace_id", "embedding_config_hash", "dimensions"]
};
