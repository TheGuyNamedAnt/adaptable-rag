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
import {
  IngestPipeline,
  type IngestPipelineCheckpoint,
  type IngestPipelineResult
} from "../ingestion/ingest-pipeline.js";
import {
  buildRetrievalReadinessReport,
  type RetrievalReadinessReport
} from "../ingestion/retrieval-readiness.js";
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
import type {
  IngestionCheckpointStore,
  IngestionJobCounts,
  IngestionJobRecord,
  IngestionJobStage,
  IngestionJobStatus,
  IngestionJobStore,
  IngestionProgressStore
} from "./ingestion-job.js";

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
  readonly jobStore?: IngestionJobStore;
  readonly checkpointStore?: IngestionCheckpointStore;
  readonly progressStore?: IngestionProgressStore;
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
  readonly readiness: RetrievalReadinessReport;
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
  private readonly jobStore: IngestionJobStore | undefined;
  private readonly checkpointStore: IngestionCheckpointStore | undefined;
  private readonly progressStore: IngestionProgressStore | undefined;
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
    this.jobStore = options.jobStore;
    this.checkpointStore = options.checkpointStore;
    this.progressStore = options.progressStore;
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
    const jobId = `${runId}_ingest`;
    await startSourceSyncIngestionJob({
      jobStore: this.jobStore,
      checkpointStore: this.checkpointStore,
      progressStore: this.progressStore,
      jobId,
      runId,
      profile: request.profile,
      source: request.source,
      connectorId: this.connector.id,
      mode: request.mode ?? "delta",
      requestedBy: request.requestedBy,
      requestedAt: startedAt,
      now: this.now
    });
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
    await recordSourceSyncLoaded({
      jobStore: this.jobStore,
      checkpointStore: this.checkpointStore,
      progressStore: this.progressStore,
      jobId,
      source: request.source,
      sync,
      recordedAt: this.now()
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
        await updateSourceSyncJobStage({
          jobStore: this.jobStore,
          checkpointStore: this.checkpointStore,
          jobId,
          status: "indexing",
          stage: "indexing",
          checkpoint: {
            phase: "delete_propagation_started",
            deletedItemCount: sync.deleted.length
          },
          recordedAt: this.now()
        });
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
          await updateSourceSyncJobStage({
            jobStore: this.jobStore,
            checkpointStore: this.checkpointStore,
            jobId,
            status: "normalizing",
            stage: "normalizing",
            checkpoint: {
              phase: "changed_records_ingest_started",
              recordCount: sync.records.length
            },
            recordedAt: this.now()
          });
          ingest = await this.ingestChangedRecords({
            request,
            records: sync.records,
            runId,
            startedAt,
            onCheckpoint: async (checkpoint) =>
              recordSourceSyncIngestCheckpoint({
                jobStore: this.jobStore,
                checkpointStore: this.checkpointStore,
                progressStore: this.progressStore,
                jobId,
                checkpoint,
                recordedAt: this.now()
              })
          });
          await recordRejectedSourceSyncRecords({
            progressStore: this.progressStore,
            jobId,
            ingest,
            recordedAt: this.now()
          });
          await recordAcceptedSourceSyncDocuments({
            progressStore: this.progressStore,
            jobId,
            ingest,
            recordedAt: this.now()
          });
          if (ingest.rejectedRecords.length > 0 || hasNormalizationErrors(ingest)) {
            warnings.push({
              code: "ingest_rejected_records",
              message: "One or more changed source records were rejected by ingestion validation."
            });
          }
        } catch {
          ingestFailed = true;
          await failSourceSyncIngestionJob({
            jobStore: this.jobStore,
            progressStore: this.progressStore,
            jobId,
            source: request.source,
            errorName: "IngestPipelineError",
            errorMessage: "Changed source records could not be ingested.",
            recordedAt: this.now()
          });
          warnings.push({
            code: "ingest_failed",
            message: "Changed source records could not be ingested."
          });
        }
      }

      if (ingest !== undefined && ingest.documents.length > 0 && ingest.chunks.length > 0) {
        await updateSourceSyncJobStage({
          jobStore: this.jobStore,
          checkpointStore: this.checkpointStore,
          jobId,
          status: "embedding",
          stage: "embedding",
          checkpoint: {
            phase: "post_ingest_started",
            documentCount: ingest.documents.length,
            chunkCount: ingest.chunks.length
          },
          recordedAt: this.now()
        });
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

    await finalizeSourceSyncIngestionJob({
      jobStore: this.jobStore,
      checkpointStore: this.checkpointStore,
      progressStore: this.progressStore,
      jobId,
      source: request.source,
      result,
      recordedAt: result.finishedAt
    });
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
    readonly onCheckpoint?: (checkpoint: IngestPipelineCheckpoint) => void | Promise<void>;
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
      overwriteMode: input.request.overwriteMode ?? "replace",
      ...(input.onCheckpoint === undefined ? {} : { onCheckpoint: input.onCheckpoint })
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

    const resultWithoutReadiness = {
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

    return {
      ...resultWithoutReadiness,
      readiness: buildRetrievalReadinessReport({
        ingest: input.ingest,
        postIngest: resultWithoutReadiness
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

async function startSourceSyncIngestionJob(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly checkpointStore: IngestionCheckpointStore | undefined;
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly runId: string;
  readonly profile: ValidatedRagProfile;
  readonly source: CorpusSourceConfig;
  readonly connectorId: string;
  readonly mode: SourceSyncMode;
  readonly requestedBy: RequestPrincipal;
  readonly requestedAt: string;
  readonly now: () => string;
}): Promise<void> {
  const existing = await input.jobStore?.get(input.jobId);
  if (existing && isActiveSourceSyncIngestionStatus(existing.status)) {
    throw new Error(`Ingestion job "${input.jobId}" is already running.`);
  }

  if (!existing) {
    await input.jobStore?.create({
      jobId: input.jobId,
      runId: input.runId,
      tenantId: input.requestedBy.tenantId,
      namespaceId: input.profile.namespaceId,
      sourceIds: [input.source.id],
      requestedAt: input.requestedAt
    });
  } else {
    await input.jobStore?.update({
      jobId: input.jobId,
      status: "queued",
      stage: "queued",
      checkpoint: {
        phase: "resume_requested",
        previousStatus: existing.status,
        previousStage: existing.stage
      },
      updatedAt: input.requestedAt
    });
  }

  const checkpoint = {
    phase: "source_sync_started",
    sourceId: input.source.id,
    connectorId: input.connectorId,
    mode: input.mode
  };
  await input.jobStore?.update({
    jobId: input.jobId,
    status: "loading_source",
    stage: "loading_source",
    startedAt: input.requestedAt,
    checkpoint,
    updatedAt: input.now()
  });
  await input.checkpointStore?.save({
    jobId: input.jobId,
    stage: "loading_source",
    checkpoint,
    recordedAt: input.now()
  });
  await input.progressStore?.updateSource({
    jobId: input.jobId,
    sourceId: input.source.id,
    status: "loading",
    loadedDocumentCount: 0,
    acceptedDocumentCount: 0,
    failedDocumentCount: 0,
    skippedDocumentCount: 0,
    startedAt: input.requestedAt,
    updatedAt: input.now()
  });
}

async function recordSourceSyncLoaded(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly checkpointStore: IngestionCheckpointStore | undefined;
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly source: CorpusSourceConfig;
  readonly sync: SourceSyncRunResult;
  readonly recordedAt: string;
}): Promise<void> {
  const checkpoint = {
    phase: "source_sync_completed",
    sourceId: input.source.id,
    syncRunId: input.sync.runId,
    mode: input.sync.mode,
    status: input.sync.status,
    returnedRecordCount: input.sync.records.length,
    deletedItemCount: input.sync.deleted.length,
    failedItemCount: input.sync.failed.length,
    skippedUnchangedCount: input.sync.metrics.skippedUnchangedCount
  };
  await updateSourceSyncJobStage({
    jobStore: input.jobStore,
    checkpointStore: input.checkpointStore,
    jobId: input.jobId,
    status: "loading_source",
    stage: "loading_source",
    checkpoint,
    recordedAt: input.recordedAt
  });
  await input.progressStore?.updateSource({
    jobId: input.jobId,
    sourceId: input.source.id,
    status: input.sync.status === "failed" ? "failed" : "loading",
    loadedDocumentCount: input.sync.records.length,
    failedDocumentCount: input.sync.failed.length,
    skippedDocumentCount: input.sync.metrics.skippedUnchangedCount,
    ...(input.sync.status === "failed" ? { finishedAt: input.recordedAt } : {}),
    updatedAt: input.recordedAt,
    ...(input.sync.status === "failed" ? { errorMessage: "Source connector failed." } : {})
  });

  for (const failed of input.sync.failed) {
    await input.progressStore?.updateDocument({
      jobId: input.jobId,
      sourceId: input.source.id,
      documentId: failed.recordId ?? failed.sourceItemId,
      status: "failed",
      retryable: failed.retryable,
      attempt: 1,
      failureStage: "loading_source",
      failurePhase: "source_sync_failed_item",
      finishedAt: input.recordedAt,
      updatedAt: input.recordedAt,
      errorMessage: failed.message
    });
  }
}

async function updateSourceSyncJobStage(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly checkpointStore: IngestionCheckpointStore | undefined;
  readonly jobId: string;
  readonly status: IngestionJobStatus;
  readonly stage: IngestionJobStage;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}): Promise<void> {
  await input.jobStore?.update({
    jobId: input.jobId,
    status: input.status,
    stage: input.stage,
    checkpoint: input.checkpoint,
    updatedAt: input.recordedAt
  });
  await input.checkpointStore?.save({
    jobId: input.jobId,
    stage: input.stage,
    checkpoint: input.checkpoint,
    recordedAt: input.recordedAt
  });
}

async function recordSourceSyncIngestCheckpoint(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly checkpointStore: IngestionCheckpointStore | undefined;
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly checkpoint: IngestPipelineCheckpoint;
  readonly recordedAt: string;
}): Promise<void> {
  await updateSourceSyncJobStage({
    jobStore: input.jobStore,
    checkpointStore: input.checkpointStore,
    jobId: input.jobId,
    status: "indexing",
    stage: "indexing",
    checkpoint: input.checkpoint,
    recordedAt: input.recordedAt
  });

  if (input.checkpoint.phase === "document_indexed") {
    await input.progressStore?.updateDocument({
      jobId: input.jobId,
      sourceId: input.checkpoint.sourceId,
      documentId: input.checkpoint.documentId,
      status: "accepted",
      finishedAt: input.recordedAt,
      updatedAt: input.recordedAt
    });
    await input.progressStore?.updateSource({
      jobId: input.jobId,
      sourceId: input.checkpoint.sourceId,
      status: "loading",
      acceptedDocumentCount: input.checkpoint.completedDocumentIds.length,
      updatedAt: input.recordedAt
    });
    return;
  }

  await input.progressStore?.updateSource({
    jobId: input.jobId,
    sourceId: input.checkpoint.sourceId,
    status: "completed",
    acceptedDocumentCount: input.checkpoint.completedDocumentIds.length,
    finishedAt: input.recordedAt,
    updatedAt: input.recordedAt
  });
}

async function recordRejectedSourceSyncRecords(input: {
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly ingest: IngestPipelineResult;
  readonly recordedAt: string;
}): Promise<void> {
  for (const rejected of input.ingest.rejectedRecords) {
    await input.progressStore?.updateDocument({
      jobId: input.jobId,
      sourceId: rejected.sourceId,
      documentId: rejected.recordId,
      status: "failed",
      retryable: false,
      attempt: 1,
      failureStage: rejectedStageToIngestionStage(rejected.rejectedStage),
      failurePhase: `${rejected.rejectedStage}_rejected_record`,
      finishedAt: input.recordedAt,
      updatedAt: input.recordedAt,
      errorMessage: rejected.reason
    });
  }
}

async function recordAcceptedSourceSyncDocuments(input: {
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly ingest: IngestPipelineResult;
  readonly recordedAt: string;
}): Promise<void> {
  for (const document of input.ingest.documents) {
    await input.progressStore?.updateDocument({
      jobId: input.jobId,
      sourceId: document.provenance.sourceId,
      documentId: document.id,
      status: "accepted",
      chunkCount: input.ingest.chunks.filter((chunk) => chunk.documentId === document.id).length,
      finishedAt: input.recordedAt,
      updatedAt: input.recordedAt
    });
  }
}

async function failSourceSyncIngestionJob(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly source: CorpusSourceConfig;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly recordedAt: string;
}): Promise<void> {
  await input.jobStore?.update({
    jobId: input.jobId,
    status: "failed",
    stage: "failed",
    finishedAt: input.recordedAt,
    checkpoint: { phase: "failed" },
    errorName: input.errorName,
    errorMessage: input.errorMessage,
    updatedAt: input.recordedAt
  });
  await input.progressStore?.updateSource({
    jobId: input.jobId,
    sourceId: input.source.id,
    status: "failed",
    finishedAt: input.recordedAt,
    updatedAt: input.recordedAt,
    errorMessage: input.errorMessage
  });
}

async function finalizeSourceSyncIngestionJob(input: {
  readonly jobStore: IngestionJobStore | undefined;
  readonly checkpointStore: IngestionCheckpointStore | undefined;
  readonly progressStore: IngestionProgressStore | undefined;
  readonly jobId: string;
  readonly source: CorpusSourceConfig;
  readonly result: SourceSyncWorkflowResult;
  readonly recordedAt: string;
}): Promise<void> {
  const status = sourceSyncJobFinalStatus(input.result);
  const counts = sourceSyncJobCounts(input.result);
  const checkpoint = {
    phase: "completed",
    workflowStatus: input.result.status,
    syncStatus: input.result.sync.status,
    ledgerSaved: input.result.ledgerSaved
  };
  await input.jobStore?.update({
    jobId: input.jobId,
    status,
    stage: status,
    finishedAt: input.recordedAt,
    checkpoint,
    counts,
    ...(status === "failed"
      ? {
          errorName: "SourceSyncWorkflowFailed",
          errorMessage: "Source sync workflow did not complete cleanly."
        }
      : {}),
    updatedAt: input.recordedAt
  });
  await input.checkpointStore?.save({
    jobId: input.jobId,
    stage: status,
    checkpoint,
    recordedAt: input.recordedAt
  });
  await input.progressStore?.updateSource({
    jobId: input.jobId,
    sourceId: input.source.id,
    status: status === "failed" ? "failed" : "completed",
    loadedDocumentCount: input.result.sync.records.length,
    acceptedDocumentCount: input.result.ingest?.documents.length ?? 0,
    failedDocumentCount:
      input.result.sync.failed.length + (input.result.ingest?.rejectedRecords.length ?? 0),
    skippedDocumentCount: input.result.sync.metrics.skippedUnchangedCount,
    finishedAt: input.recordedAt,
    updatedAt: input.recordedAt,
    ...(status === "failed"
      ? { errorMessage: "Source sync workflow did not complete cleanly." }
      : {})
  });
}

function sourceSyncJobFinalStatus(result: SourceSyncWorkflowResult): IngestionJobStatus {
  if (result.status === "failed") {
    return "failed";
  }

  if (result.status === "partial" || result.warnings.length > 0) {
    return "completed_with_warnings";
  }

  return "completed";
}

function sourceSyncJobCounts(result: SourceSyncWorkflowResult): IngestionJobCounts {
  return {
    documentsAccepted: result.ingest?.documents.length ?? 0,
    chunksAccepted: result.ingest?.chunks.length ?? 0,
    recordsRejected: result.ingest?.rejectedRecords.length ?? 0,
    recordsSkipped: result.sync.metrics.skippedUnchangedCount,
    failedDocumentCount: result.sync.failed.length + (result.ingest?.rejectedRecords.length ?? 0),
    skippedDocumentCount: result.sync.metrics.skippedUnchangedCount,
    indexWritesAccepted:
      result.ingest?.indexResults.filter((indexResult) => indexResult.accepted).length ?? 0,
    indexWritesRejected:
      result.ingest?.indexResults.filter((indexResult) => !indexResult.accepted).length ?? 0,
    adapterWarnings: (result.ingest?.adapterWarnings.length ?? 0) + result.sync.warnings.length,
    normalizationIssues: result.ingest?.normalizationIssues.length ?? 0,
    parserQualityWarnings: result.ingest?.parserQualityWarnings.length ?? 0,
    chunkingWarnings: result.ingest?.chunkingWarnings.length ?? 0
  };
}

function isActiveSourceSyncIngestionStatus(status: IngestionJobRecord["status"]): boolean {
  return [
    "queued",
    "loading_source",
    "normalizing",
    "parsing",
    "chunking",
    "embedding",
    "indexing",
    "graph_extracting"
  ].includes(status);
}

function rejectedStageToIngestionStage(
  stage: IngestPipelineResult["rejectedRecords"][number]["rejectedStage"]
): IngestionJobStage {
  return stage;
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
