import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type { GraphExtractionBatch, GraphOntology } from "./graph-types.js";
import { assertValidGraphExtractionBatch, type GraphValidationIssue } from "./graph-validation.js";

export type GraphExtractionStatus = "succeeded" | "failed";

export interface GraphExtractionRequest {
  readonly profile: {
    readonly id: string;
    readonly namespaceId: string;
  };
  readonly ontology: GraphOntology;
  readonly documents: readonly RagDocument[];
  readonly chunks: readonly RagChunk[];
  readonly extractionId?: string;
  readonly requestedAt?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface GraphExtractionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface GraphExtractionTrace {
  readonly extractionId: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly ontologyId: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly status: GraphExtractionStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly validationErrorCount: number;
}

export type GraphExtractionResult =
  | {
      readonly status: "succeeded";
      readonly batch: GraphExtractionBatch;
      readonly validationIssues: readonly GraphValidationIssue[];
      readonly trace: GraphExtractionTrace;
    }
  | {
      readonly status: "failed";
      readonly failure: GraphExtractionFailure;
      readonly validationIssues: readonly GraphValidationIssue[];
      readonly trace: GraphExtractionTrace;
    };

export interface GraphExtractor {
  readonly id: string;
  readonly supportedOntologyIds: readonly string[];
  extract(request: GraphExtractionRequest): Promise<GraphExtractionResult>;
}

export async function runGraphExtractor(
  extractor: GraphExtractor,
  request: GraphExtractionRequest,
  options: { readonly now?: () => string } = {}
): Promise<GraphExtractionResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = request.requestedAt ?? now();
  const extractionId =
    request.extractionId ?? `graph_extraction_${startedAt.replace(/[^0-9a-z]/gi, "")}`;

  if (!extractor.supportedOntologyIds.includes(request.ontology.id)) {
    return failedResult({
      request,
      extractionId,
      startedAt,
      finishedAt: now(),
      code: "unsupported_ontology",
      message: `Graph extractor "${extractor.id}" does not support ontology "${request.ontology.id}".`
    });
  }

  try {
    const result = await extractor.extract({
      ...request,
      extractionId,
      requestedAt: startedAt
    });

    if (result.status === "failed") {
      return result;
    }

    assertValidGraphExtractionBatch(result.batch);
    return result;
  } catch (error) {
    return failedResult({
      request,
      extractionId,
      startedAt,
      finishedAt: now(),
      code: "extractor_failed",
      message:
        error instanceof Error
          ? "Graph extractor failed before returning a valid extraction batch."
          : "Graph extractor failed with an unknown error."
    });
  }
}

export function buildGraphExtractionTrace(input: {
  readonly request: GraphExtractionRequest;
  readonly extractionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: GraphExtractionStatus;
  readonly entityCount?: number;
  readonly relationCount?: number;
  readonly validationErrorCount?: number;
}): GraphExtractionTrace {
  return {
    extractionId: input.extractionId,
    profileId: input.request.profile.id,
    namespaceId: input.request.profile.namespaceId,
    ontologyId: input.request.ontology.id,
    documentCount: input.request.documents.length,
    chunkCount: input.request.chunks.length,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    entityCount: input.entityCount ?? 0,
    relationCount: input.relationCount ?? 0,
    validationErrorCount: input.validationErrorCount ?? 0
  };
}

function failedResult(input: {
  readonly request: GraphExtractionRequest;
  readonly extractionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly code: string;
  readonly message: string;
}): GraphExtractionResult {
  return {
    status: "failed",
    failure: {
      code: input.code,
      message: input.message,
      retryable: input.code !== "unsupported_ontology"
    },
    validationIssues: [],
    trace: buildGraphExtractionTrace({
      request: input.request,
      extractionId: input.extractionId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: "failed"
    })
  };
}
