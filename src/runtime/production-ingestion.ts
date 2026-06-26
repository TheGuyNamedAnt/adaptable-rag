import { readFileSync } from "node:fs";
import path from "node:path";

import type { ChunkingWarning } from "../chunking/chunker.js";
import type { CorpusAdapter, CorpusAdapterWarning } from "../corpus/adapter.js";
import { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import {
  APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID,
  ApprovedKnowledgeArtifactCorpusAdapter,
  type ApprovedKnowledgeArtifactSourceConfig
} from "../corpus/approved-knowledge-artifact-adapter.js";
import type { CorpusNormalizationIssue } from "../corpus/normalize.js";
import {
  LOCAL_FILES_ADAPTER_ID,
  LocalFilesCorpusAdapter,
  type LocalFilesAccessScopeConfig,
  type LocalFilesSourceConfig
} from "../corpus/local-files-adapter.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { isSourceKind } from "../documents/provenance.js";
import {
  isSourceSensitivity,
  isTrustTier,
  type SourceSensitivity,
  type TrustTier
} from "../documents/trust-tier.js";
import type { EmbeddingIndexWarning } from "../embeddings/embedding-indexer.js";
import type { LayoutRelationIndexWarning } from "../embeddings/layout-relation-indexer.js";
import {
  VisualEmbeddingIndexer,
  type VisualEmbeddingIndexWarning
} from "../embeddings/visual-embedding-indexer.js";
import { BatchEmbeddingIndexer } from "../embeddings/batch-embedding-indexer.js";
import {
  IngestPipeline,
  type IngestPipelineResumeState,
  type IngestPipelineResult
} from "../ingestion/ingest-pipeline.js";
import type { IndexOperationResult, IndexOverwriteMode } from "../indexing/index-types.js";
import {
  PostgresIngestionCheckpointStore,
  PostgresIngestionJobStore,
  PostgresIngestionProgressStore,
  type CreateIngestionJobInput,
  type IngestionCheckpointStore,
  type IngestionJobRecord,
  type IngestionJobStage,
  type IngestionJobStore,
  type IngestionProgressStore
} from "./ingestion-job.js";
import type { VectorStore } from "../indexing/vector-store.js";
import type { VisualVectorStore } from "../indexing/visual-vector-store.js";
import { DeepDocJsonParser } from "../parsing/deepdoc-json-parser.js";
import {
  createBestCombinedLocalParserRouter,
  createLocalDocumentParserRouter,
  type LocalDocumentParserPreset
} from "../parsing/local-parser-presets.js";
import type { DocumentParser } from "../parsing/parser.js";
import type { ParserQualitySummary, ParserQualityWarning } from "../ingestion/parser-quality.js";
import type { CorpusSourceConfig } from "../profiles/profile.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import { FetchProviderTransport } from "../shared/fetch-provider-transport.js";
import type { ProviderTransport } from "../shared/provider-boundary.js";
import type { ProviderEnv } from "../shared/provider-runtime-config.js";
import {
  hasProviderRuntimeEnv,
  loadProviderRuntimeConfigFromEnv
} from "../shared/provider-runtime-config.js";
import type {
  RagSupportApprovedKnowledgeArtifact,
  RagSupportApprovedKnowledgeArtifactVisibility
} from "../support-bridge/approval-ledger.js";
import type {
  RagKnownIssueStatus,
  RagSupportEventSourceSystem,
  RagSupportEvidenceRef
} from "../support-bridge/support-event.js";
import {
  ProductionRagConfigError,
  ProductionRagRequestError,
  type ProductionRagApp
} from "./production-app.js";

export interface ProductionLocalFilesIngestionConfig {
  readonly sources: readonly LocalFilesSourceConfig[];
}

export interface ProductionApprovedKnowledgeArtifactsIngestionConfig {
  readonly sources: readonly ApprovedKnowledgeArtifactSourceConfig[];
}

export interface ProductionIngestionConfig {
  readonly localFiles: ProductionLocalFilesIngestionConfig;
  readonly approvedKnowledgeArtifacts?: ProductionApprovedKnowledgeArtifactsIngestionConfig;
}

export interface LoadProductionIngestionConfigFromEnvOptions {
  readonly env?: ProviderEnv;
  readonly cwd?: string;
  readonly defaults?: ProductionIngestionConfig;
}

export interface ProductionIngestRuntimeOptions {
  readonly app: ProductionRagApp;
  readonly config?: ProductionIngestionConfig;
  readonly adapterExtensions?: readonly ProductionCorpusAdapterExtension[];
  readonly parserExtensions?: readonly ProductionDocumentParserExtension[];
  readonly parserPrefix?: string;
  readonly parserTransport?: ProviderTransport;
  readonly env?: ProviderEnv;
  readonly cwd?: string;
  readonly now?: () => string;
  readonly jobStore?: IngestionJobStore;
  readonly checkpointStore?: IngestionCheckpointStore;
  readonly progressStore?: IngestionProgressStore;
}

export interface ProductionCorpusAdapterExtension {
  readonly adapter: CorpusAdapter;
}

export interface ProductionDocumentParserExtension {
  readonly parser: DocumentParser;
}

export interface ProductionIngestRuntime {
  ingest(input: ProductionRagIngestInput): Promise<ProductionRagIngestResponse>;
}

export interface ProductionRagIngestInput {
  readonly tenantId: string;
  readonly namespaceId?: string;
  readonly principal: unknown;
  readonly sourceIds?: readonly string[];
  readonly overwriteMode?: IndexOverwriteMode;
  readonly runId?: string;
  readonly requestedAt?: string;
}

export interface ProductionRagIngestResponse {
  readonly status: "completed";
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly loadedSourceIds: readonly string[];
  readonly counts: ProductionRagIngestCounts;
  readonly index: {
    readonly storageKind: string;
    readonly durable: boolean;
    readonly documentCount: number;
    readonly chunkCount: number;
  };
  readonly vector?: ProductionRagIngestVectorSummary;
  readonly visualVector?: ProductionRagIngestVisualVectorSummary;
  readonly parserQuality: ParserQualitySummary;
  readonly warnings: ProductionRagIngestWarnings;
  readonly artifacts: ProductionRagIngestArtifacts;
}

export interface ProductionRagIngestArtifacts {
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
}

export interface ProductionRagIngestCounts {
  readonly documentsAccepted: number;
  readonly chunksAccepted: number;
  readonly recordsRejected: number;
  readonly indexWritesAccepted: number;
  readonly indexWritesRejected: number;
  readonly adapterWarnings: number;
  readonly normalizationIssues: number;
  readonly parserQualityWarnings: number;
  readonly chunkingWarnings: number;
}

export type ProductionRagIngestVectorSummary =
  | {
      readonly status: "skipped";
      readonly reason:
        | "vector_store_not_configured"
        | "embedding_adapter_not_configured"
        | "no_chunks";
    }
  | {
      readonly status: "indexed";
      readonly provider: string;
      readonly modelName: string;
      readonly dimensions: number;
      readonly indexedVectorCount: number;
      readonly indexedRelationVectorCount: number;
      readonly candidateRelationCount: number;
      readonly vectorCount: number;
      readonly warningCount: number;
    };

export type ProductionRagIngestVisualVectorSummary =
  | {
      readonly status: "skipped";
      readonly reason:
        | "visual_vector_store_not_configured"
        | "visual_embedding_adapter_not_configured"
        | "no_chunks"
        | "no_visual_chunks";
    }
  | {
      readonly status: "indexed";
      readonly provider: string;
      readonly modelName: string;
      readonly dimensions: number;
      readonly candidateChunkCount: number;
      readonly candidateVisualAssetCount: number;
      readonly indexedVisualVectorCount: number;
      readonly visualVectorCount: number;
      readonly skippedChunkCount: number;
      readonly warningCount: number;
    };

export interface ProductionRagIngestWarnings {
  readonly adapter: readonly CorpusAdapterWarning[];
  readonly normalization: readonly CorpusNormalizationIssue[];
  readonly parserQuality: readonly ParserQualityWarning[];
  readonly chunking: readonly ChunkingWarning[];
  readonly index: readonly ProductionRagIngestIndexWarning[];
  readonly embedding: readonly ProductionRagIngestEmbeddingWarning[];
  readonly visualEmbedding: readonly ProductionRagIngestVisualEmbeddingWarning[];
}

export interface ProductionRagIngestIndexWarning {
  readonly id: string;
  readonly message: string;
}

export interface ProductionRagIngestEmbeddingWarning {
  readonly code: EmbeddingIndexWarning["code"] | LayoutRelationIndexWarning["code"];
  readonly chunkId?: string;
  readonly documentId?: string;
  readonly relationId?: string;
}

export interface ProductionRagIngestVisualEmbeddingWarning {
  readonly code: VisualEmbeddingIndexWarning["code"];
  readonly chunkId?: string;
  readonly documentId?: string;
}

interface NormalizedProductionIngestRequest {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly principal: RequestPrincipal;
  readonly sourceIds?: readonly string[];
  readonly overwriteMode: IndexOverwriteMode;
  readonly runId?: string;
  readonly requestedAt?: string;
}

interface EmbeddingIndexSummary {
  readonly vector: ProductionRagIngestVectorSummary;
  readonly warnings: readonly ProductionRagIngestEmbeddingWarning[];
}

interface VisualEmbeddingIndexSummary {
  readonly visualVector: ProductionRagIngestVisualVectorSummary;
  readonly warnings: readonly ProductionRagIngestVisualEmbeddingWarning[];
}

export function loadProductionIngestionConfigFromEnv(
  options: LoadProductionIngestionConfigFromEnvOptions = {}
): ProductionIngestionConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const defaults = options.defaults ?? emptyProductionIngestionConfig();
  const localFilesPath = readEnv(env, "RAG_LOCAL_FILES_SOURCES_PATH");
  const approvedKnowledgeArtifactsPath = readEnv(env, "RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH");

  const localFiles =
    localFilesPath === undefined
      ? defaults.localFiles
      : localFilesConfigFromPath(localFilesPath, cwd);
  const approvedKnowledgeArtifacts =
    approvedKnowledgeArtifactsPath === undefined
      ? (defaults.approvedKnowledgeArtifacts ?? { sources: [] })
      : approvedKnowledgeArtifactsConfigFromPath(approvedKnowledgeArtifactsPath, cwd);

  return {
    localFiles,
    approvedKnowledgeArtifacts
  };
}

function emptyProductionIngestionConfig(): ProductionIngestionConfig {
  return {
    localFiles: {
      sources: []
    },
    approvedKnowledgeArtifacts: {
      sources: []
    }
  };
}

function localFilesConfigFromPath(
  localFilesPath: string,
  cwd: string
): ProductionLocalFilesIngestionConfig {
  const resolvedPath = resolveConfigPath(localFilesPath, cwd);
  const parsed = readJsonFile(resolvedPath, "RAG_LOCAL_FILES_SOURCES_PATH");
  return {
    sources: parseLocalFilesSourcesPayload(parsed, path.dirname(resolvedPath))
  };
}

function approvedKnowledgeArtifactsConfigFromPath(
  approvedKnowledgeArtifactsPath: string,
  cwd: string
): ProductionApprovedKnowledgeArtifactsIngestionConfig {
  const resolvedPath = resolveConfigPath(approvedKnowledgeArtifactsPath, cwd);
  const parsed = readJsonFile(resolvedPath, "RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH");
  return {
    sources: parseApprovedKnowledgeArtifactSourcesPayload(parsed, path.dirname(resolvedPath))
  };
}

export type IngestionJobRunnerOptions = ProductionIngestRuntimeOptions;

export class IngestionJobRunner implements ProductionIngestRuntime {
  private readonly options: ProductionIngestRuntimeOptions;
  private readonly config: ProductionIngestionConfig;
  private readonly now: () => string;
  private readonly jobStore: IngestionJobStore | undefined;
  private readonly checkpointStore: IngestionCheckpointStore | undefined;
  private readonly progressStore: IngestionProgressStore | undefined;
  private readonly adapterExtensions: readonly ProductionCorpusAdapterExtension[];
  private readonly parserExtensions: readonly ProductionDocumentParserExtension[];

  constructor(options: IngestionJobRunnerOptions) {
    this.options = options;
    this.config =
      options.config ??
      loadProductionIngestionConfigFromEnv({
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd })
      });
    this.now = options.now ?? (() => new Date().toISOString());
    this.jobStore = options.jobStore ?? defaultIngestionJobStore(options);
    this.checkpointStore = options.checkpointStore ?? defaultIngestionCheckpointStore(options);
    this.progressStore = options.progressStore ?? defaultIngestionProgressStore(options);
    this.adapterExtensions = normalizeAdapterExtensions(options.adapterExtensions ?? []);
    this.parserExtensions = normalizeParserExtensions([
      ...(options.parserExtensions ?? []),
      ...localParserExtensionsFromEnv(options),
      ...parserExtensionsFromEnv(options)
    ]);
  }

  async ingest(input: ProductionRagIngestInput): Promise<ProductionRagIngestResponse> {
    return this.run(input);
  }

  async run(input: ProductionRagIngestInput): Promise<ProductionRagIngestResponse> {
    const app = this.options.app;
    const now = this.now;
    const jobStore = this.jobStore;
    const checkpointStore = this.checkpointStore;
    const progressStore = this.progressStore;
    const request = normalizeProductionIngestInput(app, input);
    const jobId =
      request.runId ?? `ingest_${(request.requestedAt ?? now()).replace(/[^0-9a-z]/gi, "")}`;
    const existingJob = await startIngestionJob(jobStore, {
      jobId,
      runId: jobId,
      tenantId: request.tenantId,
      namespaceId: request.namespaceId,
      sourceIds: request.sourceIds ?? [],
      requestedAt: request.requestedAt ?? now()
    });
    const resumeState = resumeStateFromJob(existingJob);
    await jobStore?.update({
      jobId,
      status: "loading_source",
      stage: "loading_source",
      startedAt: request.requestedAt ?? now(),
      checkpoint: {
        phase: "selected_sources_pending",
        ...resumeState
      },
      updatedAt: now()
    });
    const sources = selectedSources(app, request.sourceIds);
    await jobStore?.update({
      jobId,
      status: "loading_source",
      stage: "loading_source",
      checkpoint: {
        phase: "selected_sources",
        sourceIds: sources.map((source) => source.id),
        ...resumeState
      },
      updatedAt: now()
    });
    const adapterRegistry = adapterRegistryForSources(
      sources,
      this.config,
      this.adapterExtensions,
      this.parserExtensions
    );
    for (const source of sources) {
      await progressStore?.updateSource({
        jobId,
        sourceId: source.id,
        status: "queued",
        updatedAt: now()
      });
    }
    const pipeline = new IngestPipeline({
      adapterRegistry,
      documentStore: app.chunkStore,
      chunkStore: app.chunkStore,
      now
    });
    try {
      await jobStore?.update({
        jobId,
        status: "normalizing",
        stage: "normalizing",
        checkpoint: { phase: "core_ingestion_started" },
        updatedAt: now()
      });
      await saveCheckpoint(checkpointStore, {
        jobId,
        stage: "normalizing",
        checkpoint: { phase: "core_ingestion_started" },
        recordedAt: now()
      });
      const ingestResult = await pipeline.ingest({
        profile: app.profile,
        requestedBy: request.principal,
        sourceIds: sources.map((source) => source.id),
        overwriteMode: request.overwriteMode,
        runId: jobId,
        resumeState,
        onCheckpoint: async (checkpoint) => {
          const stage = stageForPipelineCheckpoint(checkpoint.phase);
          await jobStore?.update({
            jobId,
            status: stage,
            stage,
            checkpoint,
            updatedAt: now()
          });
          await saveCheckpoint(checkpointStore, {
            jobId,
            stage,
            checkpoint,
            recordedAt: now()
          });
          if (checkpoint.phase === "document_indexed") {
            await progressStore?.updateDocument({
              jobId,
              sourceId: checkpoint.sourceId,
              documentId: checkpoint.documentId,
              status: "accepted",
              finishedAt: now(),
              updatedAt: now()
            });
            await progressStore?.updateSource({
              jobId,
              sourceId: checkpoint.sourceId,
              status: "loading",
              acceptedDocumentCount: checkpoint.completedDocumentIds.filter((documentId) =>
                documentId.trim()
              ).length,
              updatedAt: now()
            });
          }
          if (checkpoint.phase === "source_completed") {
            await progressStore?.updateSource({
              jobId,
              sourceId: checkpoint.sourceId,
              status: "completed",
              acceptedDocumentCount: checkpoint.completedDocumentIds.length,
              finishedAt: now(),
              updatedAt: now()
            });
          }
        },
        ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt })
      });
      await jobStore?.update({
        jobId,
        status: "embedding",
        stage: "embedding",
        checkpoint: {
          phase: "core_ingestion_completed",
          documentCount: ingestResult.documents.length,
          chunkCount: ingestResult.chunks.length,
          rejectedRecordCount: ingestResult.rejectedRecords.length
        },
        updatedAt: now()
      });
      const vector = await maybeIndexEmbeddings({
        app,
        ingestResult,
        overwriteMode: request.overwriteMode,
        requestedAt: ingestResult.startedAt
      });
      await jobStore?.update({
        jobId,
        status: "embedding",
        stage: "visual_embedding",
        checkpoint: { phase: "embedding_completed", vectorStatus: vector.vector.status },
        updatedAt: now()
      });
      const visualVector = await maybeIndexVisualEmbeddings({
        app,
        ingestResult,
        overwriteMode: request.overwriteMode,
        requestedAt: ingestResult.startedAt
      });

      const summary = await summarizeIngestResult(app, ingestResult, vector, visualVector);
      const finalStatus = ingestCompletedStatus(summary);
      await jobStore?.update({
        jobId,
        status: finalStatus,
        stage: finalStatus,
        finishedAt: summary.finishedAt,
        checkpoint: { phase: "completed" },
        counts: summary.counts,
        updatedAt: summary.finishedAt
      });
      return summary;
    } catch (error) {
      await jobStore?.update({
        jobId,
        status: "failed",
        stage: "failed",
        finishedAt: now(),
        checkpoint: { phase: "failed" },
        errorName: error instanceof Error ? error.name : "IngestionError",
        errorMessage: error instanceof Error ? error.message : "Production ingestion failed.",
        updatedAt: now()
      });
      throw error;
    }
  }
}

export function createProductionIngestRuntime(
  options: ProductionIngestRuntimeOptions
): ProductionIngestRuntime {
  return new IngestionJobRunner(options);
}

async function startIngestionJob(
  jobStore: IngestionJobStore | undefined,
  input: CreateIngestionJobInput
): Promise<IngestionJobRecord | undefined> {
  if (!jobStore) {
    return undefined;
  }

  const existing = await jobStore.get(input.jobId);
  if (!existing) {
    await jobStore.create(input);
    return undefined;
  }

  if (isActiveIngestionStatus(existing.status)) {
    throw new Error(`Ingestion job "${input.jobId}" is already running.`);
  }

  await jobStore.update({
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
  return existing;
}

function isActiveIngestionStatus(status: IngestionJobRecord["status"]): boolean {
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

function stageForPipelineCheckpoint(
  phase: "document_indexed" | "source_completed"
): Extract<IngestionJobStage, "indexing" | "loading_source"> {
  return phase === "document_indexed" ? "indexing" : "loading_source";
}

async function saveCheckpoint(
  checkpointStore: IngestionCheckpointStore | undefined,
  input: {
    readonly jobId: string;
    readonly stage: IngestionJobStage;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly recordedAt: string;
  }
): Promise<void> {
  await checkpointStore?.save(input);
}

function ingestCompletedStatus(
  summary: ProductionRagIngestResponse
): Extract<IngestionJobRecord["status"], "completed" | "completed_with_warnings"> {
  const warningCount =
    summary.counts.adapterWarnings +
    summary.counts.normalizationIssues +
    summary.counts.parserQualityWarnings +
    summary.counts.chunkingWarnings +
    summary.counts.indexWritesRejected +
    (summary.vector?.status === "indexed" ? summary.vector.warningCount : 0) +
    (summary.visualVector?.status === "indexed" ? summary.visualVector.warningCount : 0);
  return warningCount > 0 || summary.counts.recordsRejected > 0
    ? "completed_with_warnings"
    : "completed";
}

function resumeStateFromJob(job: IngestionJobRecord | undefined): IngestPipelineResumeState {
  if (!job || job.status === "completed") {
    return {};
  }

  return {
    completedSourceIds: stringArrayFromCheckpoint(job.checkpoint.completedSourceIds),
    completedDocumentIds: stringArrayFromCheckpoint(job.checkpoint.completedDocumentIds)
  };
}

function stringArrayFromCheckpoint(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function defaultIngestionJobStore(
  options: ProductionIngestRuntimeOptions
): IngestionJobStore | undefined {
  const storage = options.app.config?.storage?.index;
  if (!storage || storage.kind !== "postgres") {
    return undefined;
  }

  return new PostgresIngestionJobStore({
    connectionString: storage.connectionString,
    ...(storage.schema === undefined ? {} : { schema: storage.schema })
  });
}

function defaultIngestionCheckpointStore(
  options: ProductionIngestRuntimeOptions
): IngestionCheckpointStore | undefined {
  const storage = options.app.config?.storage?.index;
  if (!storage || storage.kind !== "postgres") {
    return undefined;
  }

  return new PostgresIngestionCheckpointStore({
    connectionString: storage.connectionString,
    ...(storage.schema === undefined ? {} : { schema: storage.schema })
  });
}

function defaultIngestionProgressStore(
  options: ProductionIngestRuntimeOptions
): IngestionProgressStore | undefined {
  const storage = options.app.config?.storage?.index;
  if (!storage || storage.kind !== "postgres") {
    return undefined;
  }

  return new PostgresIngestionProgressStore({
    connectionString: storage.connectionString,
    ...(storage.schema === undefined ? {} : { schema: storage.schema })
  });
}

function normalizeProductionIngestInput(
  app: ProductionRagApp,
  input: ProductionRagIngestInput
): NormalizedProductionIngestRequest {
  if (!isRecord(input)) {
    throw new ProductionRagRequestError("Ingest request must be an object.");
  }

  const tenantId = requiredString(input.tenantId, "tenantId");
  const namespaceId = optionalString(input.namespaceId, "namespaceId") ?? app.profile.namespaceId;
  const principal = normalizePrincipal(input.principal, namespaceId, tenantId);
  const sourceIds = optionalStringArray(input.sourceIds, "sourceIds");
  if (sourceIds !== undefined && sourceIds.length === 0) {
    throw new ProductionRagRequestError("sourceIds must contain at least one source id.");
  }
  const overwriteMode = optionalOverwriteMode(input.overwriteMode) ?? "reject";
  const runId = optionalString(input.runId, "runId");
  const requestedAt = optionalString(input.requestedAt, "requestedAt");

  return {
    tenantId,
    namespaceId,
    principal,
    ...(sourceIds === undefined ? {} : { sourceIds }),
    overwriteMode,
    ...(runId === undefined ? {} : { runId }),
    ...(requestedAt === undefined ? {} : { requestedAt })
  };
}

function normalizePrincipal(
  value: unknown,
  namespaceId: string,
  tenantId: string
): RequestPrincipal {
  if (!isRecord(value)) {
    throw new ProductionRagRequestError("principal must be an object.");
  }

  const principal: RequestPrincipal = {
    userId: requiredString(value["userId"], "principal.userId"),
    tenantId: requiredString(value["tenantId"], "principal.tenantId"),
    namespaceIds: requiredStringArray(value["namespaceIds"], "principal.namespaceIds"),
    teamIds: optionalStringArray(value["teamIds"], "principal.teamIds") ?? [],
    roles: optionalStringArray(value["roles"], "principal.roles") ?? [],
    tags: optionalStringArray(value["tags"], "principal.tags") ?? []
  };

  if (principal.tenantId !== tenantId) {
    throw new ProductionRagRequestError("principal.tenantId must match tenantId.");
  }

  if (!principal.namespaceIds.includes(namespaceId)) {
    throw new ProductionRagRequestError("principal.namespaceIds must include namespaceId.");
  }

  return principal;
}

function selectedSources(
  app: ProductionRagApp,
  sourceIds: readonly string[] | undefined
): readonly CorpusSourceConfig[] {
  const enabledSources = app.profile.corpusSources.filter((source) => source.enabled);
  if (sourceIds === undefined) {
    return enabledSources;
  }

  const selected = enabledSources.filter((source) => sourceIds.includes(source.id));
  const selectedIds = new Set(selected.map((source) => source.id));
  const missing = sourceIds.filter((sourceId) => !selectedIds.has(sourceId));

  if (missing.length > 0) {
    throw new ProductionRagRequestError(`Unknown or disabled source ids: ${missing.join(", ")}.`);
  }

  return selected;
}

function adapterRegistryForSources(
  sources: readonly CorpusSourceConfig[],
  config: ProductionIngestionConfig,
  adapterExtensions: readonly ProductionCorpusAdapterExtension[],
  parserExtensions: readonly ProductionDocumentParserExtension[]
): CorpusAdapterRegistry {
  const adapterIds = uniqueSorted(sources.map((source) => source.adapter));
  const registry = new CorpusAdapterRegistry();
  const extensionByAdapterId = new Map(
    adapterExtensions.map((extension) => [extension.adapter.id, extension.adapter])
  );

  for (const adapterId of adapterIds) {
    if (adapterId === LOCAL_FILES_ADAPTER_ID) {
      const localSources = localFilesSourcesForProfileSources(sources, config.localFiles.sources);
      registry.register(
        new LocalFilesCorpusAdapter({
          sources: localSources,
          parsers: parsersForLocalFilesSources(localSources, parserExtensions)
        })
      );
      continue;
    }

    if (adapterId === APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID) {
      registry.register(
        new ApprovedKnowledgeArtifactCorpusAdapter({
          sources: approvedKnowledgeArtifactSourcesForProfileSources(
            sources,
            config.approvedKnowledgeArtifacts?.sources ?? []
          )
        })
      );
      continue;
    }

    const extension = extensionByAdapterId.get(adapterId);
    if (!extension) {
      throw new ProductionRagConfigError(
        `Corpus adapter "${adapterId}" is not registered with the production ingestion runtime.`
      );
    }

    registry.register(extension);
  }

  return registry;
}

function normalizeParserExtensions(
  extensions: readonly ProductionDocumentParserExtension[]
): readonly ProductionDocumentParserExtension[] {
  const seen = new Set<string>();

  return extensions.map((extension, index) => {
    if (!extension.parser.id.trim()) {
      throw new ProductionRagConfigError(`parserExtensions[${index}].parser.id is required.`);
    }

    if (seen.has(extension.parser.id)) {
      throw new ProductionRagConfigError(`Duplicate parser extension id "${extension.parser.id}".`);
    }
    seen.add(extension.parser.id);

    return extension;
  });
}

function normalizeAdapterExtensions(
  extensions: readonly ProductionCorpusAdapterExtension[]
): readonly ProductionCorpusAdapterExtension[] {
  const seen = new Set<string>();

  return extensions.map((extension, index) => {
    if (!extension.adapter.id.trim()) {
      throw new ProductionRagConfigError(`adapterExtensions[${index}].adapter.id is required.`);
    }

    if (
      extension.adapter.id === LOCAL_FILES_ADAPTER_ID ||
      extension.adapter.id === APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID
    ) {
      throw new ProductionRagConfigError(
        `adapterExtensions[${index}] cannot override built-in adapter "${extension.adapter.id}".`
      );
    }

    if (seen.has(extension.adapter.id)) {
      throw new ProductionRagConfigError(
        `Duplicate adapter extension id "${extension.adapter.id}".`
      );
    }
    seen.add(extension.adapter.id);

    return extension;
  });
}

function parserExtensionsFromEnv(
  options: ProductionIngestRuntimeOptions
): readonly ProductionDocumentParserExtension[] {
  const env = options.env ?? process.env;
  const prefix = options.parserPrefix ?? "RAG_PARSER";
  if (!hasProviderRuntimeEnv(env, prefix)) {
    return [];
  }

  const loaded = loadProviderRuntimeConfigFromEnv({
    env,
    prefix
  });

  return [
    {
      parser: new DeepDocJsonParser({
        config: loaded.config,
        secrets: loaded.secrets,
        transport:
          options.parserTransport ??
          options.app.runtime.providerAdapters.transport ??
          new FetchProviderTransport()
      })
    }
  ];
}

function localParserExtensionsFromEnv(
  options: ProductionIngestRuntimeOptions
): readonly ProductionDocumentParserExtension[] {
  const env = options.env ?? process.env;
  const rawPreset = env.RAG_LOCAL_PARSER_PRESET?.trim();
  if (rawPreset === "disabled") {
    return [];
  }

  const parserId = env.RAG_LOCAL_PARSER_ID?.trim() || "best-local-parser";
  const preset = rawPreset || "best_combined";
  if (preset === "best_combined") {
    return [{ parser: createBestCombinedLocalParserRouter({ parserId }) }];
  }

  if (isLocalDocumentParserPreset(preset)) {
    return [{ parser: createLocalDocumentParserRouter({ parserId, preset }) }];
  }

  throw new ProductionRagConfigError(
    `Unsupported RAG_LOCAL_PARSER_PRESET "${rawPreset}". Expected disabled, best_combined, balanced, plain_text_first, ocr_heavy, table_heavy, structure_heavy, or visual_heavy.`
  );
}

function isLocalDocumentParserPreset(value: string): value is LocalDocumentParserPreset {
  return [
    "balanced",
    "plain_text_first",
    "ocr_heavy",
    "table_heavy",
    "structure_heavy",
    "visual_heavy"
  ].includes(value);
}

function localFilesSourcesForProfileSources(
  sources: readonly CorpusSourceConfig[],
  configuredSources: readonly LocalFilesSourceConfig[]
): readonly LocalFilesSourceConfig[] {
  const localProfileSourceIds = new Set(
    sources.filter((source) => source.adapter === LOCAL_FILES_ADAPTER_ID).map((source) => source.id)
  );
  const bySourceId = new Map(configuredSources.map((source) => [source.sourceId, source]));
  const missing = [...localProfileSourceIds].filter((sourceId) => !bySourceId.has(sourceId));

  if (missing.length > 0) {
    throw new ProductionRagConfigError(
      `RAG_LOCAL_FILES_SOURCES_PATH is missing config for local-files source ids: ${missing.join(
        ", "
      )}.`
    );
  }

  return [...localProfileSourceIds].map((sourceId) => bySourceId.get(sourceId)!);
}

function approvedKnowledgeArtifactSourcesForProfileSources(
  sources: readonly CorpusSourceConfig[],
  configuredSources: readonly ApprovedKnowledgeArtifactSourceConfig[]
): readonly ApprovedKnowledgeArtifactSourceConfig[] {
  const profileSourceIds = new Set(
    sources
      .filter((source) => source.adapter === APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID)
      .map((source) => source.id)
  );
  const bySourceId = new Map(configuredSources.map((source) => [source.sourceId, source]));
  const missing = [...profileSourceIds].filter((sourceId) => !bySourceId.has(sourceId));

  if (missing.length > 0) {
    throw new ProductionRagConfigError(
      `RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH is missing config for approved knowledge source ids: ${missing.join(
        ", "
      )}.`
    );
  }

  return [...profileSourceIds].map((sourceId) => bySourceId.get(sourceId)!);
}

function parsersForLocalFilesSources(
  sources: readonly LocalFilesSourceConfig[],
  parserExtensions: readonly ProductionDocumentParserExtension[]
): readonly DocumentParser[] {
  const parserIds = uniqueSorted(
    sources
      .filter((source) => source.parserMode !== "disabled")
      .map((source) => source.parserId)
      .filter((parserId): parserId is string => parserId !== undefined)
  );

  const needsAutoParsers = sources.some(
    (source) => source.parserMode !== "disabled" && source.parserId === undefined
  );
  if (parserIds.length === 0 && !needsAutoParsers) {
    return [];
  }

  const byParserId = new Map(
    parserExtensions.map((extension) => [extension.parser.id, extension.parser])
  );
  const missing = parserIds.filter((parserId) => !byParserId.has(parserId));
  if (missing.length > 0) {
    throw new ProductionRagConfigError(
      `Local-files parser ids are not registered with the production ingestion runtime: ${missing.join(
        ", "
      )}.`
    );
  }

  const selected = new Map<string, DocumentParser>();
  for (const parserId of parserIds) {
    selected.set(parserId, byParserId.get(parserId)!);
  }
  if (needsAutoParsers) {
    for (const extension of parserExtensions) {
      selected.set(extension.parser.id, extension.parser);
    }
  }

  return [...selected.values()];
}

async function maybeIndexEmbeddings(input: {
  readonly app: ProductionRagApp;
  readonly ingestResult: IngestPipelineResult;
  readonly overwriteMode: IndexOverwriteMode;
  readonly requestedAt: string;
}): Promise<EmbeddingIndexSummary> {
  if (input.app.vectorStore === undefined) {
    return {
      vector: {
        status: "skipped",
        reason: "vector_store_not_configured"
      },
      warnings: []
    };
  }

  const embeddingAdapter = input.app.runtime.providerAdapters.embeddingAdapter;
  if (embeddingAdapter === undefined) {
    return {
      vector: {
        status: "skipped",
        reason: "embedding_adapter_not_configured"
      },
      warnings: []
    };
  }

  if (input.ingestResult.chunks.length === 0) {
    return {
      vector: {
        status: "skipped",
        reason: "no_chunks"
      },
      warnings: []
    };
  }

  const result = await new BatchEmbeddingIndexer({
    adapter: embeddingAdapter,
    vectorStore: input.app.vectorStore,
    now: () => input.requestedAt
  }).index({
    documents: input.ingestResult.documents,
    chunks: input.ingestResult.chunks,
    requestedAt: input.requestedAt,
    overwriteMode: input.overwriteMode
  });
  const vectorCount = await vectorCountFor(input.app.vectorStore);
  const warnings = [
    ...result.text.warnings.map(
      (warning): ProductionRagIngestEmbeddingWarning => ({
        code: warning.code,
        ...(warning.chunkId === undefined ? {} : { chunkId: warning.chunkId })
      })
    ),
    ...result.relations.warnings.map(
      (warning): ProductionRagIngestEmbeddingWarning => ({
        code: warning.code,
        ...(warning.documentId === undefined ? {} : { documentId: warning.documentId }),
        ...(warning.relationId === undefined ? {} : { relationId: warning.relationId })
      })
    )
  ];

  return {
    vector: {
      status: "indexed",
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      indexedVectorCount: result.indexedVectorCount,
      indexedRelationVectorCount: result.indexedRelationVectorCount,
      candidateRelationCount: result.candidateRelationCount,
      vectorCount,
      warningCount: warnings.length
    },
    warnings
  };
}

async function maybeIndexVisualEmbeddings(input: {
  readonly app: ProductionRagApp;
  readonly ingestResult: IngestPipelineResult;
  readonly overwriteMode: IndexOverwriteMode;
  readonly requestedAt: string;
}): Promise<VisualEmbeddingIndexSummary> {
  if (input.app.visualVectorStore === undefined) {
    return {
      visualVector: {
        status: "skipped",
        reason: "visual_vector_store_not_configured"
      },
      warnings: []
    };
  }

  const visualEmbeddingAdapter = input.app.visualEmbeddingAdapter;
  if (visualEmbeddingAdapter === undefined) {
    return {
      visualVector: {
        status: "skipped",
        reason: "visual_embedding_adapter_not_configured"
      },
      warnings: []
    };
  }

  if (input.ingestResult.chunks.length === 0) {
    return {
      visualVector: {
        status: "skipped",
        reason: "no_chunks"
      },
      warnings: []
    };
  }

  const indexer = new VisualEmbeddingIndexer({
    adapter: visualEmbeddingAdapter,
    visualVectorStore: input.app.visualVectorStore,
    now: () => input.requestedAt
  });
  const result = await indexer.indexChunks({
    documents: input.ingestResult.documents,
    chunks: input.ingestResult.chunks,
    requestedAt: input.requestedAt,
    overwriteMode: input.overwriteMode
  });
  const warnings = result.warnings.map((warning) => ({
    code: warning.code,
    ...(warning.chunkId === undefined ? {} : { chunkId: warning.chunkId }),
    ...(warning.documentId === undefined ? {} : { documentId: warning.documentId })
  }));

  if (result.candidateChunkCount === 0 && result.indexedVisualVectorCount === 0) {
    return {
      visualVector: {
        status: "skipped",
        reason: "no_visual_chunks"
      },
      warnings
    };
  }

  const visualVectorCount = await visualVectorCountFor(input.app.visualVectorStore);

  return {
    visualVector: {
      status: "indexed",
      provider: result.provider,
      modelName: result.modelName,
      dimensions: result.dimensions,
      candidateChunkCount: result.candidateChunkCount,
      candidateVisualAssetCount: result.candidateVisualAssetCount,
      indexedVisualVectorCount: result.indexedVisualVectorCount,
      visualVectorCount,
      skippedChunkCount: result.skippedChunkCount,
      warningCount: result.warnings.length
    },
    warnings
  };
}

async function summarizeIngestResult(
  app: ProductionRagApp,
  result: IngestPipelineResult,
  embedding: EmbeddingIndexSummary,
  visualEmbedding: VisualEmbeddingIndexSummary
): Promise<ProductionRagIngestResponse> {
  const indexStats = await app.chunkStore.stats();
  const rejectedIndexResults = result.indexResults.filter((indexResult) => !indexResult.accepted);

  const response: Omit<ProductionRagIngestResponse, "artifacts"> = {
    status: "completed",
    runId: result.runId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    loadedSourceIds: result.loadedSourceIds,
    counts: {
      documentsAccepted: result.documents.length,
      chunksAccepted: result.chunks.length,
      recordsRejected: result.rejectedRecords.length,
      indexWritesAccepted: result.indexResults.filter((indexResult) => indexResult.accepted).length,
      indexWritesRejected: rejectedIndexResults.length,
      adapterWarnings: result.adapterWarnings.length,
      normalizationIssues: result.normalizationIssues.length,
      parserQualityWarnings: result.parserQualityWarnings.length,
      chunkingWarnings: result.chunkingWarnings.length
    },
    index: {
      storageKind: app.chunkStore.capabilities.storageKind,
      durable: app.chunkStore.capabilities.durable,
      documentCount: indexStats.documentCount,
      chunkCount: indexStats.chunkCount
    },
    vector: embedding.vector,
    visualVector: visualEmbedding.visualVector,
    parserQuality: result.parserQuality,
    warnings: {
      adapter: result.adapterWarnings,
      normalization: result.normalizationIssues,
      parserQuality: result.parserQualityWarnings,
      chunking: result.chunkingWarnings,
      index: rejectedIndexResults.map(redactIndexWarning),
      embedding: embedding.warnings,
      visualEmbedding: visualEmbedding.warnings
    }
  };

  Object.defineProperty(response, "artifacts", {
    value: {
      documents: result.documents,
      chunks: result.chunks
    },
    enumerable: false
  });

  return response as ProductionRagIngestResponse;
}

function redactIndexWarning(result: IndexOperationResult): ProductionRagIngestIndexWarning {
  return {
    id: result.id,
    message: result.message
  };
}

async function vectorCountFor(vectorStore: VectorStore): Promise<number> {
  return await vectorStore.vectorCount();
}

async function visualVectorCountFor(visualVectorStore: VisualVectorStore): Promise<number> {
  return await visualVectorStore.visualVectorCount();
}

function parseLocalFilesSourcesPayload(
  value: unknown,
  baseDirectory: string
): readonly LocalFilesSourceConfig[] {
  const rawSources = Array.isArray(value)
    ? value
    : isRecord(value)
      ? requiredArray(value["sources"], "sources")
      : undefined;

  if (rawSources === undefined) {
    throw new ProductionRagConfigError(
      "RAG_LOCAL_FILES_SOURCES_PATH must contain an array or an object with a sources array."
    );
  }

  const sources = rawSources.map((source, index) =>
    parseLocalFilesSourceConfig(source, `sources[${index}]`, baseDirectory)
  );
  const duplicateSourceIds = duplicates(sources.map((source) => source.sourceId));
  if (duplicateSourceIds.length > 0) {
    throw new ProductionRagConfigError(
      `Duplicate local-files source ids: ${duplicateSourceIds.join(", ")}.`
    );
  }

  return sources;
}

function parseApprovedKnowledgeArtifactSourcesPayload(
  value: unknown,
  baseDirectory: string
): readonly ApprovedKnowledgeArtifactSourceConfig[] {
  const rawSources = Array.isArray(value)
    ? value
    : isRecord(value)
      ? requiredArray(value["sources"], "sources")
      : undefined;

  if (rawSources === undefined) {
    throw new ProductionRagConfigError(
      "RAG_APPROVED_KNOWLEDGE_ARTIFACTS_PATH must contain an array or an object with a sources array."
    );
  }

  const sources = rawSources.map((source, index) =>
    parseApprovedKnowledgeArtifactSourceConfig(source, `sources[${index}]`, baseDirectory)
  );
  const duplicateSourceIds = duplicates(sources.map((source) => source.sourceId));
  if (duplicateSourceIds.length > 0) {
    throw new ProductionRagConfigError(
      `Duplicate approved knowledge source ids: ${duplicateSourceIds.join(", ")}.`
    );
  }

  return sources;
}

function parseApprovedKnowledgeArtifactSourceConfig(
  value: unknown,
  label: string,
  baseDirectory: string
): ApprovedKnowledgeArtifactSourceConfig {
  const record = requiredRecord(value, label);
  const sourceId = requiredConfigString(record["sourceId"], `${label}.sourceId`);
  const ledgerPath = optionalConfigString(record["ledgerPath"], `${label}.ledgerPath`);
  const ledgerPaths = optionalConfigStringArray(record["ledgerPaths"], `${label}.ledgerPaths`);
  const directArtifacts = optionalApprovedArtifacts(record["artifacts"], `${label}.artifacts`);
  const artifacts = [
    ...(directArtifacts ?? []),
    ...approvedArtifactsFromLedgerPaths(
      [...(ledgerPath === undefined ? [] : [ledgerPath]), ...(ledgerPaths ?? [])],
      baseDirectory,
      label
    )
  ];

  if (artifacts.length === 0) {
    throw new ProductionRagConfigError(
      `${label} must include at least one approved artifact or approval ledger path.`
    );
  }

  const duplicateArtifactIds = duplicates(artifacts.map((artifact) => artifact.artifactId));
  if (duplicateArtifactIds.length > 0) {
    throw new ProductionRagConfigError(
      `${label} contains duplicate approved artifact ids: ${duplicateArtifactIds.join(", ")}.`
    );
  }

  const artifactIds = optionalConfigStringArray(record["artifactIds"], `${label}.artifactIds`);
  const maxArtifacts = optionalPositiveInteger(record["maxArtifacts"], `${label}.maxArtifacts`);
  const pathPrefix = optionalConfigString(record["pathPrefix"], `${label}.pathPrefix`);
  const originUriBase = optionalConfigString(record["originUriBase"], `${label}.originUriBase`);
  const owner = optionalConfigString(record["owner"], `${label}.owner`);
  const accessScope = optionalAccessScope(record["accessScope"], `${label}.accessScope`);
  const capturedAt = optionalConfigString(record["capturedAt"], `${label}.capturedAt`);
  const metadata = optionalMetadata(record["metadata"], `${label}.metadata`);

  return {
    sourceId,
    artifacts,
    ...(artifactIds === undefined ? {} : { artifactIds }),
    ...(maxArtifacts === undefined ? {} : { maxArtifacts }),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(originUriBase === undefined ? {} : { originUriBase }),
    ...(owner === undefined ? {} : { owner }),
    ...(accessScope === undefined ? {} : { accessScope }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function approvedArtifactsFromLedgerPaths(
  ledgerPaths: readonly string[],
  baseDirectory: string,
  label: string
): readonly RagSupportApprovedKnowledgeArtifact[] {
  return ledgerPaths.flatMap((ledgerPath, index) => {
    const resolvedPath = resolveConfigPath(ledgerPath, baseDirectory);
    const parsed = readJsonFile(resolvedPath, `${label}.ledgerPaths[${index}]`);
    const ledger = requiredRecord(parsed, `${label}.ledgerPaths[${index}]`);
    const approvedArtifacts = requiredArray(
      ledger["approvedArtifacts"],
      `${label}.ledgerPaths[${index}].approvedArtifacts`
    );

    return approvedArtifacts.map((artifact, artifactIndex) =>
      parseApprovedArtifact(
        artifact,
        `${label}.ledgerPaths[${index}].approvedArtifacts[${artifactIndex}]`
      )
    );
  });
}

function optionalApprovedArtifacts(
  value: unknown,
  label: string
): readonly RagSupportApprovedKnowledgeArtifact[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredArray(value, label).map((artifact, index) =>
    parseApprovedArtifact(artifact, `${label}[${index}]`)
  );
}

function parseApprovedArtifact(value: unknown, label: string): RagSupportApprovedKnowledgeArtifact {
  const record = requiredRecord(value, label);
  const corpusAdmission = requiredRecord(record["corpusAdmission"], `${label}.corpusAdmission`);
  const ingestionHint = requiredRecord(record["ingestionHint"], `${label}.ingestionHint`);

  return {
    artifactId: requiredConfigString(record["artifactId"], `${label}.artifactId`),
    artifactKey: requiredConfigString(record["artifactKey"], `${label}.artifactKey`),
    status: requiredLiteralString(record["status"], `${label}.status`, "approved_for_ingestion"),
    kind: requiredConfigString(
      record["kind"],
      `${label}.kind`
    ) as RagSupportApprovedKnowledgeArtifact["kind"],
    title: requiredConfigString(record["title"], `${label}.title`),
    body: requiredConfigString(record["body"], `${label}.body`),
    bodyHash: requiredConfigString(record["bodyHash"], `${label}.bodyHash`),
    visibility: requiredAllowedString(record["visibility"], `${label}.visibility`, [
      "internal",
      "customer_safe",
      "public"
    ]) as RagSupportApprovedKnowledgeArtifactVisibility,
    ...(optionalConfigString(record["profileId"], `${label}.profileId`) === undefined
      ? {}
      : { profileId: optionalConfigString(record["profileId"], `${label}.profileId`)! }),
    ...(optionalConfigString(record["namespaceId"], `${label}.namespaceId`) === undefined
      ? {}
      : { namespaceId: optionalConfigString(record["namespaceId"], `${label}.namespaceId`)! }),
    ...(optionalConfigString(record["targetId"], `${label}.targetId`) === undefined
      ? {}
      : { targetId: optionalConfigString(record["targetId"], `${label}.targetId`)! }),
    ...(optionalConfigString(record["knownIssueStatus"], `${label}.knownIssueStatus`) === undefined
      ? {}
      : {
          knownIssueStatus: optionalConfigString(
            record["knownIssueStatus"],
            `${label}.knownIssueStatus`
          )! as RagKnownIssueStatus
        }),
    sourceCandidateId: requiredConfigString(
      record["sourceCandidateId"],
      `${label}.sourceCandidateId`
    ),
    sourceCandidateKey: requiredConfigString(
      record["sourceCandidateKey"],
      `${label}.sourceCandidateKey`
    ),
    sourceEventIds: requiredConfigStringArray(record["sourceEventIds"], `${label}.sourceEventIds`),
    sourceIdempotencyKeys: requiredConfigStringArray(
      record["sourceIdempotencyKeys"],
      `${label}.sourceIdempotencyKeys`
    ),
    sourceTicketIds: requiredConfigStringArray(
      record["sourceTicketIds"],
      `${label}.sourceTicketIds`
    ),
    runIds: requiredConfigStringArray(record["runIds"], `${label}.runIds`),
    traceIds: requiredConfigStringArray(record["traceIds"], `${label}.traceIds`),
    payloadHashes: requiredConfigStringArray(record["payloadHashes"], `${label}.payloadHashes`),
    evidenceRefs: requiredArray(record["evidenceRefs"], `${label}.evidenceRefs`).map(
      (evidenceRef, index) => parseEvidenceRef(evidenceRef, `${label}.evidenceRefs[${index}]`)
    ),
    approvedAt: requiredConfigString(record["approvedAt"], `${label}.approvedAt`),
    approvalDecisionId: requiredConfigString(
      record["approvalDecisionId"],
      `${label}.approvalDecisionId`
    ),
    reviewerIdHash: requiredConfigString(record["reviewerIdHash"], `${label}.reviewerIdHash`),
    approvalSummary: requiredConfigString(record["approvalSummary"], `${label}.approvalSummary`),
    corpusAdmission: {
      currentRuntimeAnswerable: requiredLiteralBoolean(
        corpusAdmission["currentRuntimeAnswerable"],
        `${label}.corpusAdmission.currentRuntimeAnswerable`,
        false
      ),
      approvedForIngestion: requiredLiteralBoolean(
        corpusAdmission["approvedForIngestion"],
        `${label}.corpusAdmission.approvedForIngestion`,
        true
      ),
      answerableAfterIngestion: requiredLiteralBoolean(
        corpusAdmission["answerableAfterIngestion"],
        `${label}.corpusAdmission.answerableAfterIngestion`,
        true
      ),
      requiredNextGate: requiredLiteralString(
        corpusAdmission["requiredNextGate"],
        `${label}.corpusAdmission.requiredNextGate`,
        "corpus_ingestion"
      ),
      reason: requiredConfigString(corpusAdmission["reason"], `${label}.corpusAdmission.reason`)
    },
    ingestionHint: {
      sourceId: requiredConfigString(ingestionHint["sourceId"], `${label}.ingestionHint.sourceId`),
      sourceKind: requiredLiteralString(
        ingestionHint["sourceKind"],
        `${label}.ingestionHint.sourceKind`,
        "derived_summary"
      ),
      trustTier: requiredLiteralString(
        ingestionHint["trustTier"],
        `${label}.ingestionHint.trustTier`,
        "generated_or_derived"
      ),
      sensitivity: requiredAllowedString(
        ingestionHint["sensitivity"],
        `${label}.ingestionHint.sensitivity`,
        ["internal", "public"]
      ) as RagSupportApprovedKnowledgeArtifact["ingestionHint"]["sensitivity"],
      adapter: requiredLiteralString(
        ingestionHint["adapter"],
        `${label}.ingestionHint.adapter`,
        APPROVED_KNOWLEDGE_ARTIFACT_ADAPTER_ID
      )
    },
    metadata: optionalNullableMetadata(record["metadata"], `${label}.metadata`) ?? {}
  };
}

function parseEvidenceRef(
  value: unknown,
  label: string
): RagSupportApprovedKnowledgeArtifact["evidenceRefs"][number] {
  const record = requiredRecord(value, label);
  const sourceSystem = optionalConfigString(record["sourceSystem"], `${label}.sourceSystem`);
  const artifactPath = optionalConfigString(record["artifactPath"], `${label}.artifactPath`);
  const ticketId = optionalConfigString(record["ticketId"], `${label}.ticketId`);
  const runId = optionalConfigString(record["runId"], `${label}.runId`);
  const traceId = optionalConfigString(record["traceId"], `${label}.traceId`);
  const reviewId = optionalConfigString(record["reviewId"], `${label}.reviewId`);

  let evidenceRef: RagSupportEvidenceRef = {
    refId: requiredConfigString(record["refId"], `${label}.refId`),
    kind: requiredConfigString(record["kind"], `${label}.kind`) as RagSupportEvidenceRef["kind"],
    sensitivity: requiredConfigString(
      record["sensitivity"],
      `${label}.sensitivity`
    ) as RagSupportEvidenceRef["sensitivity"],
    customerSafe: requiredBoolean(record["customerSafe"], `${label}.customerSafe`)
  };

  if (sourceSystem !== undefined) {
    evidenceRef = { ...evidenceRef, sourceSystem: sourceSystem as RagSupportEventSourceSystem };
  }
  if (artifactPath !== undefined) {
    evidenceRef = { ...evidenceRef, artifactPath };
  }
  if (ticketId !== undefined) {
    evidenceRef = { ...evidenceRef, ticketId };
  }
  if (runId !== undefined) {
    evidenceRef = { ...evidenceRef, runId };
  }
  if (traceId !== undefined) {
    evidenceRef = { ...evidenceRef, traceId };
  }
  if (reviewId !== undefined) {
    evidenceRef = { ...evidenceRef, reviewId };
  }

  return evidenceRef;
}

function parseLocalFilesSourceConfig(
  value: unknown,
  label: string,
  baseDirectory: string
): LocalFilesSourceConfig {
  const record = requiredRecord(value, label);
  const sourceId = requiredConfigString(record["sourceId"], `${label}.sourceId`);
  const rootDir = resolveConfigPath(
    requiredConfigString(record["rootDir"], `${label}.rootDir`),
    baseDirectory
  );
  const files = optionalConfigStringArray(record["files"], `${label}.files`);
  const recursive = optionalBoolean(record["recursive"], `${label}.recursive`);
  const includeExtensions = optionalConfigStringArray(
    record["includeExtensions"],
    `${label}.includeExtensions`
  );
  const excludeDirectories = optionalConfigStringArray(
    record["excludeDirectories"],
    `${label}.excludeDirectories`
  );
  const includeHidden = optionalBoolean(record["includeHidden"], `${label}.includeHidden`);
  const followSymlinks = optionalBoolean(record["followSymlinks"], `${label}.followSymlinks`);
  const maxFileBytes = optionalPositiveInteger(record["maxFileBytes"], `${label}.maxFileBytes`);
  const parserMode = optionalLocalFilesParserMode(record["parserMode"], `${label}.parserMode`);
  const parserId = optionalConfigString(record["parserId"], `${label}.parserId`);
  const parserRequireLayout = optionalBoolean(
    record["parserRequireLayout"],
    `${label}.parserRequireLayout`
  );
  const sourceKind = optionalSourceKind(record["sourceKind"], `${label}.sourceKind`);
  const trustTier = optionalTrustTier(record["trustTier"], `${label}.trustTier`);
  const sensitivity = optionalSourceSensitivity(record["sensitivity"], `${label}.sensitivity`);
  const accessScope = optionalAccessScope(record["accessScope"], `${label}.accessScope`);
  const capturedAt = optionalConfigString(record["capturedAt"], `${label}.capturedAt`);
  const owner = optionalConfigString(record["owner"], `${label}.owner`);
  const originUriBase = optionalConfigString(record["originUriBase"], `${label}.originUriBase`);
  const metadata = optionalMetadata(record["metadata"], `${label}.metadata`);

  return {
    sourceId,
    rootDir,
    ...(files === undefined ? {} : { files }),
    ...(recursive === undefined ? {} : { recursive }),
    ...(includeExtensions === undefined ? {} : { includeExtensions }),
    ...(excludeDirectories === undefined ? {} : { excludeDirectories }),
    ...(includeHidden === undefined ? {} : { includeHidden }),
    ...(followSymlinks === undefined ? {} : { followSymlinks }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(parserMode === undefined ? {} : { parserMode }),
    ...(parserId === undefined ? {} : { parserId }),
    ...(parserRequireLayout === undefined ? {} : { parserRequireLayout }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
    ...(trustTier === undefined ? {} : { trustTier }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    ...(accessScope === undefined ? {} : { accessScope }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(owner === undefined ? {} : { owner }),
    ...(originUriBase === undefined ? {} : { originUriBase }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function optionalLocalFilesParserMode(
  value: unknown,
  label: string
): LocalFilesSourceConfig["parserMode"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = optionalConfigString(value, label);
  if (parsed === "auto" || parsed === "disabled") {
    return parsed;
  }

  throw new ProductionRagConfigError(`${label} must be "auto" or "disabled".`);
}

function optionalAccessScope(
  value: unknown,
  label: string
): LocalFilesAccessScopeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, label);
  const tenantId = optionalConfigString(record["tenantId"], `${label}.tenantId`);
  const namespaceId = optionalConfigString(record["namespaceId"], `${label}.namespaceId`);
  const teamIds = optionalConfigStringArray(record["teamIds"], `${label}.teamIds`);
  const userIds = optionalConfigStringArray(record["userIds"], `${label}.userIds`);
  const roles = optionalConfigStringArray(record["roles"], `${label}.roles`);
  const tags = optionalConfigStringArray(record["tags"], `${label}.tags`);

  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(teamIds === undefined ? {} : { teamIds }),
    ...(userIds === undefined ? {} : { userIds }),
    ...(roles === undefined ? {} : { roles }),
    ...(tags === undefined ? {} : { tags })
  };
}

function optionalMetadata(
  value: unknown,
  label: string
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, label);
  const metadata: Record<string, string | number | boolean> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new ProductionRagConfigError(`${label}.${key} must be a string, number, or boolean.`);
    }
    metadata[key] = entry;
  }

  return metadata;
}

function optionalNullableMetadata(
  value: unknown,
  label: string
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requiredRecord(value, label);
  const metadata: Record<string, string | number | boolean | null> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new ProductionRagConfigError(
        `${label}.${key} must be a string, number, boolean, or null.`
      );
    }
    metadata[key] = entry;
  }

  return metadata;
}

function optionalOverwriteMode(value: unknown): IndexOverwriteMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "reject" || value === "replace") {
    return value;
  }

  throw new ProductionRagRequestError("overwriteMode must be reject or replace.");
}

function optionalSourceKind(value: unknown, label: string): LocalFilesSourceConfig["sourceKind"] {
  if (value === undefined) {
    return undefined;
  }

  const parsed = requiredConfigString(value, label);
  if (!isSourceKind(parsed)) {
    throw new ProductionRagConfigError(`${label} is not a supported source kind.`);
  }

  return parsed;
}

function optionalTrustTier(value: unknown, label: string): TrustTier | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = requiredConfigString(value, label);
  if (!isTrustTier(parsed)) {
    throw new ProductionRagConfigError(`${label} is not a supported trust tier.`);
  }

  return parsed;
}

function optionalSourceSensitivity(value: unknown, label: string): SourceSensitivity | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = requiredConfigString(value, label);
  if (!isSourceSensitivity(parsed)) {
    throw new ProductionRagConfigError(`${label} is not a supported source sensitivity.`);
  }

  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductionRagRequestError(`${label} is required.`);
  }

  return value.trim();
}

function requiredConfigString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductionRagConfigError(`${label} is required.`);
  }

  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, label);
}

function optionalConfigString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredConfigString(value, label);
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  const values = optionalStringArray(value, label);
  if (values === undefined || values.length === 0) {
    throw new ProductionRagRequestError(`${label} must contain at least one string.`);
  }

  return values;
}

function requiredConfigStringArray(value: unknown, label: string): readonly string[] {
  const values = optionalConfigStringArray(value, label);
  if (values === undefined || values.length === 0) {
    throw new ProductionRagConfigError(`${label} must contain at least one string.`);
  }

  return values;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ProductionRagRequestError(`${label} must be an array of strings.`);
  }

  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function optionalConfigStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ProductionRagConfigError(`${label} must be an array of strings.`);
  }

  return value.map((entry, index) => requiredConfigString(entry, `${label}[${index}]`));
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ProductionRagConfigError(`${label} must be a boolean.`);
  }

  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProductionRagConfigError(`${label} must be a positive integer.`);
  }

  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProductionRagConfigError(`${label} must be a boolean.`);
  }

  return value;
}

function requiredLiteralBoolean<const T extends boolean>(
  value: unknown,
  label: string,
  expected: T
): T {
  const parsed = requiredBoolean(value, label);
  if (parsed !== expected) {
    throw new ProductionRagConfigError(`${label} must be ${expected}.`);
  }

  return expected;
}

function requiredAllowedString(value: unknown, label: string, allowed: readonly string[]): string {
  const parsed = requiredConfigString(value, label);
  if (!allowed.includes(parsed)) {
    throw new ProductionRagConfigError(`${label} must be one of: ${allowed.join(", ")}.`);
  }

  return parsed;
}

function requiredLiteralString<const T extends string>(
  value: unknown,
  label: string,
  expected: T
): T {
  const parsed = requiredConfigString(value, label);
  if (parsed !== expected) {
    throw new ProductionRagConfigError(`${label} must be "${expected}".`);
  }

  return expected;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ProductionRagConfigError(`${label} must be an array.`);
  }

  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProductionRagConfigError(`${label} must be an object.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new ProductionRagConfigError(
      `${label} could not be read as JSON: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

function readEnv(env: ProviderEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function resolveConfigPath(value: string, baseDirectory: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
      continue;
    }
    seen.add(value);
  }

  return [...duplicated].sort();
}
