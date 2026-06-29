import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { IndexFilter } from "../indexing/index-types.js";
import type { GraphApprovalRunResult, GraphApprovalRunner } from "./graph-approval.js";
import {
  runGraphExtractor,
  type GraphExtractionResult,
  type GraphExtractor
} from "./graph-extractor.js";
import {
  checkGraphIntegrity,
  type GraphIntegrityOptions,
  type GraphIntegrityResult
} from "./graph-integrity.js";
import type { GraphOntology } from "./graph-types.js";
import type { GraphStore, GraphStoreWriteResult } from "./in-memory-graph-store.js";

export type GraphIngestionStatus = "succeeded" | "skipped" | "failed";

export interface GraphIngestionProfileContext {
  readonly id: string;
  readonly namespaceId: string;
}

export interface GraphIngestionRequest {
  readonly profile: GraphIngestionProfileContext;
  readonly ontology: GraphOntology;
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly approvalFilter?: IndexFilter;
  readonly ingestionId?: string;
  readonly requestedAt?: string;
}

export interface GraphIngestionTrace {
  readonly ingestionId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly ontologyId: string;
  readonly status: GraphIngestionStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly extractionStatus?: GraphExtractionResult["status"];
  readonly graphIntegrityStatus?: "passed" | "failed";
  readonly graphIntegrityIssueCount?: number;
  readonly graphIntegrityErrorCount?: number;
  readonly graphIntegrityWarningCount?: number;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly storedEntityCount: number;
  readonly storedRelationCount: number;
  readonly approvalDecisionCount: number;
  readonly approvedCount: number;
  readonly rejectedCount: number;
  readonly needsReviewCount: number;
}

export interface GraphIngestionResult {
  readonly status: GraphIngestionStatus;
  readonly extraction?: GraphExtractionResult;
  readonly graphIntegrity?: GraphIntegrityResult;
  readonly storeWrite?: GraphStoreWriteResult;
  readonly approval?: GraphApprovalRunResult;
  readonly trace: GraphIngestionTrace;
}

export interface GraphIngestionIntegrityOptions extends GraphIntegrityOptions {
  readonly enabled?: boolean;
}

export interface GraphIngestionRunnerOptions {
  readonly extractor: GraphExtractor;
  readonly graphStore: GraphStore;
  readonly approvalRunner?: GraphApprovalRunner;
  readonly graphIntegrity?: GraphIngestionIntegrityOptions;
  readonly now?: () => string;
}

export class GraphIngestionRunner {
  private readonly extractor: GraphExtractor;
  private readonly graphStore: GraphStore;
  private readonly approvalRunner: GraphApprovalRunner | undefined;
  private readonly graphIntegrityEnabled: boolean;
  private readonly graphIntegrityOptions: GraphIntegrityOptions;
  private readonly now: () => string;

  constructor(options: GraphIngestionRunnerOptions) {
    this.extractor = options.extractor;
    this.graphStore = options.graphStore;
    this.approvalRunner = options.approvalRunner;
    const { enabled = true, ...graphIntegrityOptions } = options.graphIntegrity ?? {};
    this.graphIntegrityEnabled = enabled;
    this.graphIntegrityOptions = graphIntegrityOptions;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ingest(request: GraphIngestionRequest): Promise<GraphIngestionResult> {
    const startedAt = request.requestedAt ?? this.now();
    const ingestionId =
      request.ingestionId ?? `graph_ingestion_${startedAt.replace(/[^0-9a-z]/gi, "")}`;

    if (request.documents.length === 0 || request.chunks.length === 0) {
      return {
        status: "skipped",
        trace: buildTrace({
          request,
          ingestionId,
          startedAt,
          finishedAt: this.now(),
          status: "skipped"
        })
      };
    }

    const extraction = await runGraphExtractor(
      this.extractor,
      {
        profile: request.profile,
        ontology: request.ontology,
        documents: request.documents,
        chunks: request.chunks,
        extractionId: `${ingestionId}_extraction`,
        requestedAt: startedAt
      },
      { now: this.now }
    );

    if (extraction.status === "failed") {
      return {
        status: "failed",
        extraction,
        trace: buildTrace({
          request,
          ingestionId,
          startedAt,
          finishedAt: this.now(),
          status: "failed",
          extraction
        })
      };
    }

    const graphIntegrity = this.graphIntegrityEnabled
      ? checkGraphIntegrity({
          batch: extraction.batch,
          chunks: request.chunks,
          options: this.graphIntegrityOptions
        })
      : undefined;
    if (graphIntegrity?.valid === false) {
      return {
        status: "failed",
        extraction,
        graphIntegrity,
        trace: buildTrace({
          request,
          ingestionId,
          startedAt,
          finishedAt: this.now(),
          status: "failed",
          extraction,
          graphIntegrity
        })
      };
    }

    const storeWrite = this.graphStore.addExtractionBatch(extraction.batch);
    const approval =
      storeWrite.accepted && this.approvalRunner && request.approvalFilter
        ? this.approvalRunner.approve({
            filter: request.approvalFilter,
            runId: `${ingestionId}_approval`,
            requestedAt: startedAt
          })
        : undefined;

    return {
      status: storeWrite.accepted ? "succeeded" : "failed",
      extraction,
      ...(graphIntegrity === undefined ? {} : { graphIntegrity }),
      storeWrite,
      ...(approval === undefined ? {} : { approval }),
      trace: buildTrace({
        request,
        ingestionId,
        startedAt,
        finishedAt: this.now(),
        status: storeWrite.accepted ? "succeeded" : "failed",
        extraction,
        ...(graphIntegrity === undefined ? {} : { graphIntegrity }),
        storeWrite,
        ...(approval === undefined ? {} : { approval })
      })
    };
  }
}

function buildTrace(input: {
  readonly request: GraphIngestionRequest;
  readonly ingestionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: GraphIngestionStatus;
  readonly extraction?: GraphExtractionResult;
  readonly graphIntegrity?: GraphIntegrityResult;
  readonly storeWrite?: GraphStoreWriteResult;
  readonly approval?: GraphApprovalRunResult;
}): GraphIngestionTrace {
  const extractionEntityCount =
    input.extraction?.status === "succeeded" ? input.extraction.batch.entities.length : 0;
  const extractionRelationCount =
    input.extraction?.status === "succeeded" ? input.extraction.batch.relations.length : 0;

  return {
    ingestionId: input.ingestionId,
    profileId: input.request.profile.id,
    namespaceId: input.request.profile.namespaceId,
    ontologyId: input.request.ontology.id,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    documentCount: input.request.documents.length,
    chunkCount: input.request.chunks.length,
    ...(input.extraction === undefined ? {} : { extractionStatus: input.extraction.status }),
    ...(input.graphIntegrity === undefined
      ? {}
      : {
          graphIntegrityStatus: input.graphIntegrity.valid ? "passed" : "failed",
          graphIntegrityIssueCount: input.graphIntegrity.issues.length,
          graphIntegrityErrorCount: input.graphIntegrity.errors.length,
          graphIntegrityWarningCount: input.graphIntegrity.warnings.length
        }),
    entityCount: extractionEntityCount,
    relationCount: extractionRelationCount,
    storedEntityCount: input.storeWrite?.entityCount ?? 0,
    storedRelationCount: input.storeWrite?.relationCount ?? 0,
    approvalDecisionCount: input.approval?.decisions.length ?? 0,
    approvedCount: input.approval?.approvedCount ?? 0,
    rejectedCount: input.approval?.rejectedCount ?? 0,
    needsReviewCount: input.approval?.needsReviewCount ?? 0
  };
}
