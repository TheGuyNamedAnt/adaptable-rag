import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import type { CorpusAdapter, CorpusLoadRequest, CorpusLoadResult } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { CorpusRecord } from "../corpus/corpus-record.js";
import {
  EmbeddingIndexer,
  type EmbeddingIndexResult,
  type EmbeddingIndexWarning
} from "../embeddings/embedding-indexer.js";
import type { EmbeddingAdapter } from "../embeddings/embedding-types.js";
import {
  LayoutRelationIndexer,
  type LayoutRelationIndexResult,
  type LayoutRelationIndexWarning
} from "../embeddings/layout-relation-indexer.js";
import {
  VisualEmbeddingIndexer,
  type VisualEmbeddingIndexResult,
  type VisualEmbeddingIndexWarning
} from "../embeddings/visual-embedding-indexer.js";
import type { VisualEmbeddingAdapter } from "../embeddings/visual-embedding-types.js";
import type { GraphIngestionResult, GraphIngestionRunner } from "../graph/graph-ingestion.js";
import type { GraphOntology } from "../graph/graph-types.js";
import type { GraphStore } from "../graph/in-memory-graph-store.js";
import { IngestPipeline, type IngestPipelineResult } from "../ingestion/ingest-pipeline.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { DocumentStore } from "../indexing/document-store.js";
import type { IndexFilter, IndexOverwriteMode } from "../indexing/index-types.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import type { SourceConnector, SourceSyncMode } from "../sync/source-connector.js";
import type { SourceSyncLedger, SourceSyncLedgerStore } from "../sync/sync-ledger.js";
import { SourceSyncRunner, type SourceSyncRunResult } from "../sync/sync-runner.js";
import {
  propagateSourceDeletes,
  type SourceDeletePropagationResult
} from "./source-delete-propagation.js";

export type SourceSyncWorkflowStatus = "succeeded" | "partial" | "failed" | "skipped";

export type SourceSyncWorkflowWarningCode =
  | "source_sync_failed"
  | "delete_propagation_failed"
  | "ingest_failed"
  | "ingest_rejected_records"
  | "post_ingest_failed"
  | "post_ingest_warnings"
  | "ledger_save_skipped"
  | "ledger_save_failed";

export type SourceSyncWorkflowPostIngestStatus = "succeeded" | "partial" | "failed" | "skipped";

export type SourceSyncWorkflowPostIngestStage =
  | "embedding"
  | "layout_relation_embedding"
  | "visual_embedding"
  | "knowledge";

export interface SourceSyncWorkflowRunnerOptions {
  readonly connector: SourceConnector;
  readonly ledgerStore?: SourceSyncLedgerStore;
  readonly documentStore: DocumentStore;
  readonly chunkStore: ChunkStore;
  readonly vectorStore?: VectorStore;
  readonly embeddingAdapter?: EmbeddingAdapter;
  readonly visualVectorStore?: VisualVectorStore;
  readonly visualEmbeddingAdapter?: VisualEmbeddingAdapter;
  readonly graphStore?: GraphStore;
  readonly knowledgeIngestion?: SourceSyncWorkflowKnowledgeIngestionOptions;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly now?: () => string;
}

export interface SourceSyncWorkflowKnowledgeIngestionOptions {
  readonly runner: GraphIngestionRunner;
  readonly ontology: GraphOntology;
  readonly approvalFilter?: IndexFilter;
  readonly enabled?: boolean;
}

export interface SourceSyncWorkflowRequest {
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly requestedBy: RequestPrincipal;
  readonly filter?: IndexFilter;
  readonly mode?: SourceSyncMode;
  readonly previousLedger?: SourceSyncLedger;
  readonly runId?: string;
  readonly requestedAt?: string;
  readonly deleteMissingItems?: boolean;
  readonly overwriteMode?: IndexOverwriteMode;
}

export interface SourceSyncWorkflowWarning {
  readonly code: SourceSyncWorkflowWarningCode;
  readonly message: string;
}

export interface SourceSyncWorkflowMetrics {
  readonly syncedRecordCount: number;
  readonly syncedDeleteCount: number;
  readonly syncFailedItemCount: number;
  readonly ingestedDocumentCount: number;
  readonly ingestedChunkCount: number;
  readonly rejectedRecordCount: number;
  readonly indexedVectorCount: number;
  readonly indexedRelationVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
  readonly propagatedDeleteCount: number;
  readonly deletedDocumentCount: number;
  readonly deletedChunkCount: number;
  readonly ledgerSaved: boolean;
}

export interface SourceSyncWorkflowPostIngestWarning {
  readonly stage: SourceSyncWorkflowPostIngestStage;
  readonly code: string;
  readonly message: string;
  readonly chunkId?: string;
  readonly documentId?: string;
  readonly relationId?: string;
}

export interface SourceSyncWorkflowPostIngestMetrics {
  readonly indexedVectorCount: number;
  readonly indexedRelationVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
  readonly knowledgeApprovedCount: number;
}

export interface SourceSyncWorkflowPostIngestResult {
  readonly status: SourceSyncWorkflowPostIngestStatus;
  readonly embedding?: EmbeddingIndexResult;
  readonly layoutRelations?: LayoutRelationIndexResult;
  readonly visualEmbedding?: VisualEmbeddingIndexResult;
  readonly knowledge?: GraphIngestionResult;
  readonly warnings: readonly SourceSyncWorkflowPostIngestWarning[];
  readonly metrics: SourceSyncWorkflowPostIngestMetrics;
}

export interface SourceSyncWorkflowResult {
  readonly status: SourceSyncWorkflowStatus;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly sync: SourceSyncRunResult;
  readonly deletePropagation?: SourceDeletePropagationResult;
  readonly ingest?: IngestPipelineResult;
  readonly postIngest?: SourceSyncWorkflowPostIngestResult;
  readonly ledger: SourceSyncLedger;
  readonly ledgerSaved: boolean;
  readonly warnings: readonly SourceSyncWorkflowWarning[];
  readonly metrics: SourceSyncWorkflowMetrics;
}

export class SourceSyncWorkflowRunner {
  private readonly connector: SourceConnector;
  private readonly ledgerStore: SourceSyncLedgerStore | undefined;
  private readonly documentStore: DocumentStore;
  private readonly chunkStore: ChunkStore;
  private readonly vectorStore: VectorStore | undefined;
  private readonly embeddingAdapter: EmbeddingAdapter | undefined;
  private readonly visualVectorStore: VisualVectorStore | undefined;
  private readonly visualEmbeddingAdapter: VisualEmbeddingAdapter | undefined;
  private readonly graphStore: GraphStore | undefined;
  private readonly knowledgeIngestion: SourceSyncWorkflowKnowledgeIngestionOptions | undefined;
  private readonly chunkingPolicy: ChunkingPolicy | undefined;
  private readonly now: () => string;

  constructor(options: SourceSyncWorkflowRunnerOptions) {
    this.connector = options.connector;
    this.ledgerStore = options.ledgerStore;
    this.documentStore = options.documentStore;
    this.chunkStore = options.chunkStore;
    this.vectorStore = options.vectorStore;
    this.embeddingAdapter = options.embeddingAdapter;
    this.visualVectorStore = options.visualVectorStore;
    this.visualEmbeddingAdapter = options.visualEmbeddingAdapter;
    this.graphStore = options.graphStore;
    this.knowledgeIngestion = options.knowledgeIngestion;
    this.chunkingPolicy = options.chunkingPolicy;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(request: SourceSyncWorkflowRequest): Promise<SourceSyncWorkflowResult> {
    const startedAt = request.requestedAt ?? this.now();
    const runId = request.runId ?? `source_sync_workflow_${safeTimestamp(startedAt)}`;
    const previousLedger = request.previousLedger ?? (await this.loadPreviousLedger(request));
    const sync = await new SourceSyncRunner({
      connector: this.connector,
      now: this.now
    }).sync({
      profile: request.profile,
      source: request.source,
      requestedBy: request.requestedBy,
      runId: `${runId}_sync`,
      requestedAt: startedAt,
      ...(previousLedger === undefined ? {} : { previousLedger }),
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.deleteMissingItems === undefined
        ? {}
        : { deleteMissingItems: request.deleteMissingItems })
    });

    const warnings: SourceSyncWorkflowWarning[] = [];
    let deletePropagation: SourceDeletePropagationResult | undefined;
    let ingest: IngestPipelineResult | undefined;
    let postIngest: SourceSyncWorkflowPostIngestResult | undefined;
    let ingestFailed = false;
    let ledgerSaved = false;

    if (sync.status === "failed") {
      warnings.push({
        code: "source_sync_failed",
        message:
          "Source connector failed, so downstream delete propagation and ingestion were skipped."
      });
    } else {
      if (sync.deleted.length > 0) {
        deletePropagation = await propagateSourceDeletes({
          deleted: sync.deleted,
          filter: request.filter ?? workflowFilter(request),
          documentStore: this.documentStore,
          chunkStore: this.chunkStore,
          propagationId: `${runId}_delete`,
          requestedAt: startedAt,
          now: this.now,
          ...(this.vectorStore === undefined ? {} : { vectorStore: this.vectorStore }),
          ...(this.visualVectorStore === undefined
            ? {}
            : { visualVectorStore: this.visualVectorStore }),
          ...(this.graphStore === undefined ? {} : { graphStore: this.graphStore })
        });
        if (deletePropagation.errors.length > 0) {
          warnings.push({
            code: "delete_propagation_failed",
            message: "One or more source delete tombstones could not be propagated to indexed data."
          });
        }
      }

      if (sync.records.length > 0) {
        try {
          ingest = await this.ingestChangedRecords({
            request,
            records: sync.records,
            runId,
            startedAt
          });
          if (ingest.rejectedRecords.length > 0 || hasNormalizationErrors(ingest)) {
            warnings.push({
              code: "ingest_rejected_records",
              message: "One or more changed source records were rejected by ingestion validation."
            });
          }
        } catch {
          ingestFailed = true;
          warnings.push({
            code: "ingest_failed",
            message: "Changed source records could not be ingested."
          });
        }
      }

      if (ingest !== undefined && ingest.documents.length > 0 && ingest.chunks.length > 0) {
        postIngest = await this.indexPostIngestArtifacts({
          request,
          ingest,
          runId,
          startedAt
        });
        if (postIngest.status === "failed") {
          warnings.push({
            code: "post_ingest_failed",
            message:
              "One or more configured post-ingest indexing steps failed after changed records were ingested."
          });
        } else if (postIngest.status === "partial") {
          warnings.push({
            code: "post_ingest_warnings",
            message: "One or more configured post-ingest indexing steps completed with warnings."
          });
        }
      }
    }

    const safeToSaveLedger = shouldSaveLedger({
      sync,
      deletePropagation,
      ingest,
      postIngest,
      ingestFailed
    });
    if (this.ledgerStore && safeToSaveLedger) {
      try {
        await this.ledgerStore.save(sync.ledger);
        ledgerSaved = true;
      } catch {
        warnings.push({
          code: "ledger_save_failed",
          message: "Source sync workflow completed, but the sync ledger could not be saved."
        });
      }
    } else if (this.ledgerStore && !safeToSaveLedger) {
      warnings.push({
        code: "ledger_save_skipped",
        message: "The sync ledger was not saved because downstream indexing did not finish cleanly."
      });
    }

    const result: SourceSyncWorkflowResult = {
      status: workflowStatus({
        sync,
        deletePropagation,
        ingest,
        postIngest,
        ingestFailed,
        ledgerSaveFailed: this.ledgerStore !== undefined && safeToSaveLedger && !ledgerSaved
      }),
      runId,
      startedAt,
      finishedAt: this.now(),
      sync,
      ...(deletePropagation === undefined ? {} : { deletePropagation }),
      ...(ingest === undefined ? {} : { ingest }),
      ...(postIngest === undefined ? {} : { postIngest }),
      ledger: sync.ledger,
      ledgerSaved,
      warnings,
      metrics: workflowMetrics({
        sync,
        deletePropagation,
        ingest,
        postIngest,
        ledgerSaved
      })
    };

    return result;
  }

  private async loadPreviousLedger(
    request: SourceSyncWorkflowRequest
  ): Promise<SourceSyncLedger | undefined> {
    return this.ledgerStore?.load({
      connectorId: this.connector.id,
      sourceId: request.source.id,
      namespaceId: request.profile.namespaceId
    });
  }

  private async ingestChangedRecords(input: {
    readonly request: SourceSyncWorkflowRequest;
    readonly records: readonly CorpusRecord[];
    readonly runId: string;
    readonly startedAt: string;
  }): Promise<IngestPipelineResult> {
    const adapterRegistry = new CorpusAdapterRegistry([
      new OneShotSourceSyncAdapter({
        adapterId: input.request.source.adapter,
        sourceId: input.request.source.id,
        records: input.records
      })
    ]);
    const pipeline = new IngestPipeline({
      adapterRegistry,
      documentStore: this.documentStore,
      chunkStore: this.chunkStore,
      now: this.now,
      ...(this.chunkingPolicy === undefined ? {} : { chunkingPolicy: this.chunkingPolicy })
    });

    return pipeline.ingest({
      profile: input.request.profile,
      requestedBy: input.request.requestedBy,
      sourceIds: [input.request.source.id],
      runId: `${input.runId}_ingest`,
      requestedAt: input.startedAt,
      overwriteMode: input.request.overwriteMode ?? "replace"
    });
  }

  private async indexPostIngestArtifacts(input: {
    readonly request: SourceSyncWorkflowRequest;
    readonly ingest: IngestPipelineResult;
    readonly runId: string;
    readonly startedAt: string;
  }): Promise<SourceSyncWorkflowPostIngestResult> {
    let embedding: EmbeddingIndexResult | undefined;
    let layoutRelations: LayoutRelationIndexResult | undefined;
    let visualEmbedding: VisualEmbeddingIndexResult | undefined;
    let knowledge: GraphIngestionResult | undefined;
    const warnings: SourceSyncWorkflowPostIngestWarning[] = [];

    if (this.vectorStore && this.embeddingAdapter) {
      try {
        embedding = await new EmbeddingIndexer({
          adapter: this.embeddingAdapter,
          vectorStore: this.vectorStore,
          now: () => input.startedAt
        }).indexChunks({
          chunks: input.ingest.chunks,
          requestedAt: input.startedAt,
          overwriteMode: input.request.overwriteMode ?? "replace"
        });
        warnings.push(...embedding.warnings.map(embeddingWarning));

        layoutRelations = await new LayoutRelationIndexer({
          adapter: this.embeddingAdapter,
          vectorStore: this.vectorStore,
          now: () => input.startedAt
        }).indexRelations({
          documents: input.ingest.documents,
          chunks: input.ingest.chunks,
          requestedAt: input.startedAt,
          overwriteMode: input.request.overwriteMode ?? "replace"
        });
        warnings.push(...layoutRelations.warnings.map(layoutRelationWarning));
      } catch (error) {
        warnings.push({
          stage: "embedding",
          code: "post_ingest_exception",
          message: `Embedding post-ingest step failed: ${errorName(error)}.`
        });
      }
    }

    if (this.visualVectorStore && this.visualEmbeddingAdapter) {
      try {
        visualEmbedding = await new VisualEmbeddingIndexer({
          adapter: this.visualEmbeddingAdapter,
          visualVectorStore: this.visualVectorStore,
          now: () => input.startedAt
        }).indexChunks({
          documents: input.ingest.documents,
          chunks: input.ingest.chunks,
          requestedAt: input.startedAt,
          overwriteMode: input.request.overwriteMode ?? "replace"
        });
        warnings.push(...visualEmbedding.warnings.map(visualEmbeddingWarning));
      } catch (error) {
        warnings.push({
          stage: "visual_embedding",
          code: "post_ingest_exception",
          message: `Visual embedding post-ingest step failed: ${errorName(error)}.`
        });
      }
    }

    if (this.knowledgeIngestion?.enabled !== false) {
      const knowledgeIngestion = this.knowledgeIngestion;
      if (knowledgeIngestion !== undefined) {
        try {
          knowledge = await knowledgeIngestion.runner.ingest({
            profile: {
              id: input.request.profile.id,
              namespaceId: input.request.profile.namespaceId
            },
            ontology: knowledgeIngestion.ontology,
            documents: input.ingest.documents,
            chunks: input.ingest.chunks,
            approvalFilter:
              knowledgeIngestion.approvalFilter ??
              input.request.filter ??
              workflowFilter(input.request),
            ingestionId: `${input.runId}_knowledge`,
            requestedAt: input.startedAt
          });
          if (knowledge.status === "failed") {
            warnings.push({
              stage: "knowledge",
              code: "knowledge_ingestion_failed",
              message: "Knowledge-map ingestion failed for the changed source records."
            });
          }
        } catch (error) {
          warnings.push({
            stage: "knowledge",
            code: "post_ingest_exception",
            message: `Knowledge post-ingest step failed: ${errorName(error)}.`
          });
        }
      }
    }

    return {
      status: postIngestStatus({
        embedding,
        layoutRelations,
        visualEmbedding,
        knowledge,
        warnings
      }),
      ...(embedding === undefined ? {} : { embedding }),
      ...(layoutRelations === undefined ? {} : { layoutRelations }),
      ...(visualEmbedding === undefined ? {} : { visualEmbedding }),
      ...(knowledge === undefined ? {} : { knowledge }),
      warnings,
      metrics: postIngestMetrics({
        embedding,
        layoutRelations,
        visualEmbedding,
        knowledge
      })
    };
  }
}

class OneShotSourceSyncAdapter implements CorpusAdapter {
  readonly id: string;
  readonly description = "One-shot adapter for records returned by a source sync workflow.";
  private readonly sourceId: string;
  private readonly records: readonly CorpusRecord[];

  constructor(input: {
    readonly adapterId: string;
    readonly sourceId: string;
    readonly records: readonly CorpusRecord[];
  }) {
    this.id = input.adapterId;
    this.sourceId = input.sourceId;
    this.records = input.records;
  }

  async load(_request: CorpusLoadRequest): Promise<CorpusLoadResult> {
    return {
      sourceId: this.sourceId,
      records: this.records,
      warnings: []
    };
  }
}

function workflowFilter(request: SourceSyncWorkflowRequest): IndexFilter {
  return {
    namespaceId: request.profile.namespaceId,
    tenantId: request.requestedBy.tenantId,
    principal: request.requestedBy,
    sourceIds: [request.source.id]
  };
}

function shouldSaveLedger(input: {
  readonly sync: SourceSyncRunResult;
  readonly deletePropagation: SourceDeletePropagationResult | undefined;
  readonly ingest: IngestPipelineResult | undefined;
  readonly postIngest: SourceSyncWorkflowPostIngestResult | undefined;
  readonly ingestFailed: boolean;
}): boolean {
  if (input.sync.status === "failed") {
    return true;
  }

  if (input.ingestFailed) {
    return false;
  }

  if (input.deletePropagation && input.deletePropagation.errors.length > 0) {
    return false;
  }

  if (
    input.postIngest &&
    (input.postIngest.status === "failed" || input.postIngest.status === "partial")
  ) {
    return false;
  }

  if (input.sync.records.length > 0) {
    if (!input.ingest) {
      return false;
    }
    if (input.ingest.rejectedRecords.length > 0 || hasNormalizationErrors(input.ingest)) {
      return false;
    }
    const ingestedDocumentIds = new Set(input.ingest.documents.map((document) => document.id));
    if (input.sync.records.some((record) => !ingestedDocumentIds.has(record.id))) {
      return false;
    }
  }

  return true;
}

function workflowStatus(input: {
  readonly sync: SourceSyncRunResult;
  readonly deletePropagation: SourceDeletePropagationResult | undefined;
  readonly ingest: IngestPipelineResult | undefined;
  readonly postIngest: SourceSyncWorkflowPostIngestResult | undefined;
  readonly ingestFailed: boolean;
  readonly ledgerSaveFailed: boolean;
}): SourceSyncWorkflowStatus {
  if (input.sync.status === "failed") {
    return "failed";
  }

  const downstreamFailed =
    input.ingestFailed ||
    input.ledgerSaveFailed ||
    (input.deletePropagation !== undefined && input.deletePropagation.status === "failed") ||
    (input.postIngest !== undefined && input.postIngest.status === "failed") ||
    (input.ingest !== undefined &&
      (input.ingest.rejectedRecords.length > 0 || hasNormalizationErrors(input.ingest)));

  if (downstreamFailed) {
    return completedAnyDownstreamWork(input) ? "partial" : "failed";
  }

  if (
    input.sync.status === "partial" ||
    input.deletePropagation?.status === "partial" ||
    input.deletePropagation?.status === "skipped" ||
    input.postIngest?.status === "partial"
  ) {
    return "partial";
  }

  if (input.sync.records.length === 0 && input.sync.deleted.length === 0) {
    return "skipped";
  }

  return "succeeded";
}

function completedAnyDownstreamWork(input: {
  readonly deletePropagation: SourceDeletePropagationResult | undefined;
  readonly ingest: IngestPipelineResult | undefined;
}): boolean {
  return (
    (input.ingest?.documents.length ?? 0) > 0 ||
    (input.ingest?.chunks.length ?? 0) > 0 ||
    (input.deletePropagation?.metrics.deletedDocumentCount ?? 0) > 0 ||
    (input.deletePropagation?.metrics.deletedChunkCount ?? 0) > 0
  );
}

function workflowMetrics(input: {
  readonly sync: SourceSyncRunResult;
  readonly deletePropagation: SourceDeletePropagationResult | undefined;
  readonly ingest: IngestPipelineResult | undefined;
  readonly postIngest: SourceSyncWorkflowPostIngestResult | undefined;
  readonly ledgerSaved: boolean;
}): SourceSyncWorkflowMetrics {
  return {
    syncedRecordCount: input.sync.records.length,
    syncedDeleteCount: input.sync.deleted.length,
    syncFailedItemCount: input.sync.failed.length,
    ingestedDocumentCount: input.ingest?.documents.length ?? 0,
    ingestedChunkCount: input.ingest?.chunks.length ?? 0,
    rejectedRecordCount: input.ingest?.rejectedRecords.length ?? 0,
    indexedVectorCount: input.postIngest?.metrics.indexedVectorCount ?? 0,
    indexedRelationVectorCount: input.postIngest?.metrics.indexedRelationVectorCount ?? 0,
    indexedVisualVectorCount: input.postIngest?.metrics.indexedVisualVectorCount ?? 0,
    knowledgeEntityCount: input.postIngest?.metrics.knowledgeEntityCount ?? 0,
    knowledgeRelationCount: input.postIngest?.metrics.knowledgeRelationCount ?? 0,
    propagatedDeleteCount: input.deletePropagation?.metrics.propagatedDocumentCount ?? 0,
    deletedDocumentCount: input.deletePropagation?.metrics.deletedDocumentCount ?? 0,
    deletedChunkCount: input.deletePropagation?.metrics.deletedChunkCount ?? 0,
    ledgerSaved: input.ledgerSaved
  };
}

function hasNormalizationErrors(result: IngestPipelineResult): boolean {
  return result.normalizationIssues.some((issue) => issue.severity === "error");
}

function postIngestStatus(input: {
  readonly embedding: EmbeddingIndexResult | undefined;
  readonly layoutRelations: LayoutRelationIndexResult | undefined;
  readonly visualEmbedding: VisualEmbeddingIndexResult | undefined;
  readonly knowledge: GraphIngestionResult | undefined;
  readonly warnings: readonly SourceSyncWorkflowPostIngestWarning[];
}): SourceSyncWorkflowPostIngestStatus {
  const metrics = postIngestMetrics(input);
  const completedWork =
    metrics.indexedVectorCount > 0 ||
    metrics.indexedRelationVectorCount > 0 ||
    metrics.indexedVisualVectorCount > 0 ||
    metrics.knowledgeEntityCount > 0 ||
    metrics.knowledgeRelationCount > 0;
  const hardFailure =
    input.knowledge?.status === "failed" ||
    input.warnings.some(
      (warning) =>
        warning.code === "embedding_failed" ||
        warning.code === "visual_embedding_failed" ||
        warning.code === "knowledge_ingestion_failed" ||
        warning.code === "post_ingest_exception"
    );

  if (hardFailure) {
    return completedWork ? "partial" : "failed";
  }

  if (input.warnings.length > 0) {
    return "partial";
  }

  return completedWork ? "succeeded" : "skipped";
}

function postIngestMetrics(input: {
  readonly embedding: EmbeddingIndexResult | undefined;
  readonly layoutRelations: LayoutRelationIndexResult | undefined;
  readonly visualEmbedding: VisualEmbeddingIndexResult | undefined;
  readonly knowledge: GraphIngestionResult | undefined;
}): SourceSyncWorkflowPostIngestMetrics {
  return {
    indexedVectorCount: input.embedding?.indexedVectorCount ?? 0,
    indexedRelationVectorCount: input.layoutRelations?.indexedRelationVectorCount ?? 0,
    indexedVisualVectorCount: input.visualEmbedding?.indexedVisualVectorCount ?? 0,
    knowledgeEntityCount: input.knowledge?.trace.entityCount ?? 0,
    knowledgeRelationCount: input.knowledge?.trace.relationCount ?? 0,
    knowledgeApprovedCount: input.knowledge?.trace.approvedCount ?? 0
  };
}

function embeddingWarning(warning: EmbeddingIndexWarning): SourceSyncWorkflowPostIngestWarning {
  return {
    stage: "embedding",
    code: warning.code,
    message: warning.message,
    ...(warning.chunkId === undefined ? {} : { chunkId: warning.chunkId })
  };
}

function layoutRelationWarning(
  warning: LayoutRelationIndexWarning
): SourceSyncWorkflowPostIngestWarning {
  return {
    stage: "layout_relation_embedding",
    code: warning.code,
    message: warning.message,
    ...(warning.documentId === undefined ? {} : { documentId: warning.documentId }),
    ...(warning.relationId === undefined ? {} : { relationId: warning.relationId })
  };
}

function visualEmbeddingWarning(
  warning: VisualEmbeddingIndexWarning
): SourceSyncWorkflowPostIngestWarning {
  return {
    stage: "visual_embedding",
    code: warning.code,
    message: warning.message,
    ...(warning.chunkId === undefined ? {} : { chunkId: warning.chunkId }),
    ...(warning.documentId === undefined ? {} : { documentId: warning.documentId })
  };
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
