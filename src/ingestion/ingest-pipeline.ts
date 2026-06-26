import type { ChunkingPolicy } from "../chunking/chunk-policy.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import { ChunkingPolicyError, chunkDocument, type ChunkingWarning } from "../chunking/chunker.js";
import type { CorpusAdapterWarning } from "../corpus/adapter.js";
import type { CorpusAdapterRegistry } from "../corpus/adapter-registry.js";
import type { RejectedCorpusRecord } from "../corpus/corpus-record.js";
import { normalizeCorpusRecords, type CorpusNormalizationIssue } from "../corpus/normalize.js";
import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { ChunkStore } from "../indexing/chunk-store.js";
import type { DocumentStore } from "../indexing/document-store.js";
import type { IndexOperationResult, IndexOverwriteMode } from "../indexing/index-types.js";
import type { ValidatedRagProfile } from "../profiles/profile-validation.js";
import type { RequestPrincipal } from "../security/access-scope.js";
import { BatchIndexWriter } from "./batch-index-writer.js";
import {
  analyzeParserQualityForDocuments,
  type ParserQualitySummary,
  type ParserQualityWarning
} from "./parser-quality.js";

export interface IngestPipelineRequest {
  readonly profile: ValidatedRagProfile;
  readonly requestedBy: RequestPrincipal;
  readonly sourceIds?: readonly string[];
  readonly runId?: string;
  readonly requestedAt?: string;
  readonly overwriteMode?: IndexOverwriteMode;
  readonly resumeState?: IngestPipelineResumeState;
  readonly onCheckpoint?: (checkpoint: IngestPipelineCheckpoint) => void | Promise<void>;
}

export interface IngestPipelineResumeState {
  readonly completedSourceIds?: readonly string[];
  readonly completedDocumentIds?: readonly string[];
}

export type IngestPipelineCheckpoint =
  | {
      readonly phase: "source_completed";
      readonly sourceId: string;
      readonly completedSourceIds: readonly string[];
      readonly completedDocumentIds: readonly string[];
    }
  | {
      readonly phase: "document_indexed";
      readonly sourceId: string;
      readonly documentId: string;
      readonly completedSourceIds: readonly string[];
      readonly completedDocumentIds: readonly string[];
    };

export interface IngestPipelineResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly loadedSourceIds: readonly string[];
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly rejectedRecords: readonly RejectedCorpusRecord[];
  readonly normalizationIssues: readonly CorpusNormalizationIssue[];
  readonly adapterWarnings: readonly CorpusAdapterWarning[];
  readonly parserQuality: ParserQualitySummary;
  readonly parserQualityWarnings: readonly ParserQualityWarning[];
  readonly chunkingWarnings: readonly ChunkingWarning[];
  readonly indexResults: readonly IndexOperationResult[];
}

export interface IngestPipelineOptions {
  readonly adapterRegistry: CorpusAdapterRegistry;
  readonly documentStore: DocumentStore;
  readonly chunkStore: ChunkStore;
  readonly chunkingPolicy?: ChunkingPolicy;
  readonly now?: () => string;
}

export class IngestPipeline {
  private readonly adapterRegistry: CorpusAdapterRegistry;
  private readonly indexWriter: BatchIndexWriter;
  private readonly chunkingPolicy: ChunkingPolicy;
  private readonly now: () => string;

  constructor(options: IngestPipelineOptions) {
    this.adapterRegistry = options.adapterRegistry;
    this.indexWriter = new BatchIndexWriter({
      documentStore: options.documentStore,
      chunkStore: options.chunkStore
    });
    this.chunkingPolicy = options.chunkingPolicy ?? DEFAULT_CHUNKING_POLICY;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ingest(request: IngestPipelineRequest): Promise<IngestPipelineResult> {
    const startedAt = request.requestedAt ?? this.now();
    const runId = request.runId ?? `ingest_${startedAt.replace(/[^0-9a-z]/gi, "")}`;
    const sources = request.profile.corpusSources.filter(
      (source) => source.enabled && (!request.sourceIds || request.sourceIds.includes(source.id))
    );
    const loadedSourceIds: string[] = [];
    const documents: RagDocument[] = [];
    const chunks: RagChunk[] = [];
    const rejectedRecords: RejectedCorpusRecord[] = [];
    const normalizationIssues: CorpusNormalizationIssue[] = [];
    const adapterWarnings: CorpusAdapterWarning[] = [];
    const chunkingWarnings: ChunkingWarning[] = [];
    const indexResults: IndexOperationResult[] = [];
    const completedSourceIds = new Set(request.resumeState?.completedSourceIds ?? []);
    const completedDocumentIds = new Set(request.resumeState?.completedDocumentIds ?? []);

    for (const source of sources) {
      if (completedSourceIds.has(source.id)) {
        loadedSourceIds.push(source.id);
        continue;
      }

      const adapter = this.adapterRegistry.getRequired(source.adapter);
      const loaded = await adapter.load({
        profile: request.profile,
        source,
        requestedBy: request.requestedBy,
        runId,
        requestedAt: startedAt
      });
      loadedSourceIds.push(source.id);
      adapterWarnings.push(...loaded.warnings);

      if (loaded.sourceId !== source.id) {
        adapterWarnings.push({
          sourceId: source.id,
          code: "source_id_mismatch",
          message: `Adapter returned sourceId "${loaded.sourceId}" for configured source "${source.id}".`
        });
      }

      const normalized = normalizeCorpusRecords(loaded.records, {
        profile: request.profile,
        source,
        requestedBy: request.requestedBy,
        ingestedAt: startedAt
      });
      normalizationIssues.push(...normalized.issues);
      rejectedRecords.push(...normalized.rejectedRecords);

      for (const document of normalized.documents) {
        if (completedDocumentIds.has(document.id)) {
          continue;
        }

        let chunked: ReturnType<typeof chunkDocument>;
        try {
          chunked = chunkDocument({
            document,
            policy: this.chunkingPolicy
          });
        } catch (error) {
          if (!isDocumentChunkLimitError(error, document.id)) {
            throw error;
          }

          const message =
            error instanceof Error ? error.message : "Document exceeded chunking policy.";
          rejectedRecords.push({
            recordId: document.id,
            sourceId: document.provenance.sourceId,
            reason: message
          });
          chunkingWarnings.push({
            documentId: document.id,
            code: "max_chunks_per_document_exceeded",
            message
          });
          continue;
        }

        const writeResult = await this.indexWriter.write({
          documents: [
            {
              document,
              chunks: chunked.chunks
            }
          ],
          overwriteMode: request.overwriteMode ?? "reject",
          indexedAt: startedAt
        });
        indexResults.push(...writeResult.indexResults);

        if (writeResult.failedDocuments.length > 0) {
          const failure = writeResult.failedDocuments[0];
          const message = failure?.message ?? "Document chunks failed index validation.";
          rejectedRecords.push({
            recordId: document.id,
            sourceId: document.provenance.sourceId,
            reason: message
          });
          chunkingWarnings.push({
            documentId: document.id,
            code: "chunk_index_validation_failed",
            message
          });
          continue;
        }

        if (writeResult.acceptedDocuments.length === 0) {
          continue;
        }

        documents.push(document);
        chunkingWarnings.push(...chunked.warnings);
        chunks.push(...writeResult.acceptedChunks);
        completedDocumentIds.add(document.id);
        await request.onCheckpoint?.({
          phase: "document_indexed",
          sourceId: source.id,
          documentId: document.id,
          completedSourceIds: [...completedSourceIds],
          completedDocumentIds: [...completedDocumentIds]
        });
      }

      completedSourceIds.add(source.id);
      await request.onCheckpoint?.({
        phase: "source_completed",
        sourceId: source.id,
        completedSourceIds: [...completedSourceIds],
        completedDocumentIds: [...completedDocumentIds]
      });
    }

    const parserQuality = analyzeParserQualityForDocuments(documents);

    return {
      runId,
      startedAt,
      finishedAt: this.now(),
      loadedSourceIds,
      documents,
      chunks,
      rejectedRecords,
      normalizationIssues,
      adapterWarnings,
      parserQuality: parserQuality.summary,
      parserQualityWarnings: parserQuality.warnings,
      chunkingWarnings,
      indexResults
    };
  }
}

function isDocumentChunkLimitError(
  error: unknown,
  documentId: string
): error is ChunkingPolicyError {
  return (
    error instanceof ChunkingPolicyError &&
    error.issues.some((issue) => issue.includes(`Document "${documentId}" would create`))
  );
}
