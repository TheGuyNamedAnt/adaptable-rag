import type { IngestPipelineResult } from "./ingest-pipeline.js";
import { auditPagesForOcr } from "../documents/page-ocr-audit.js";

export interface RetrievalReadinessReport {
  readonly textIndexReady: boolean;
  readonly vectorIndexReady: boolean;
  readonly visualIndexReady: boolean;
  readonly graphReady: boolean;
  readonly connectedChunkExpansionReady: boolean;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly bodyChunkCount: number;
  readonly derivedChunkCount: number;
  readonly searchableUnitCounts: Readonly<Record<string, number>>;
  readonly layoutDocumentCount: number;
  readonly pageCount: number;
  readonly pagesNeedingOcrCount: number;
  readonly parserQualityWarningCount: number;
  readonly searchableArtifactWarningCount: number;
  readonly chunkRelationshipCount: number;
  readonly indexedVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
  readonly warningCodes: readonly string[];
}

export function buildRetrievalReadinessReport(input: {
  readonly ingest?: IngestPipelineResult;
  readonly postIngest?: {
    readonly status: string;
    readonly metrics: {
      readonly indexedVectorCount: number;
      readonly indexedVisualVectorCount: number;
      readonly knowledgeEntityCount: number;
      readonly knowledgeRelationCount: number;
    };
  };
}): RetrievalReadinessReport {
  const documentCount = input.ingest?.documents.length ?? 0;
  const chunkCount = input.ingest?.chunks.length ?? 0;
  const searchableUnitCounts = searchableUnitCountsForChunks(input.ingest?.chunks ?? []);
  const bodyChunkCount = searchableUnitCounts["body_chunk"] ?? 0;
  const derivedChunkCount = chunkCount - bodyChunkCount;
  const parserQualityWarningCount = input.ingest?.parserQualityWarnings.length ?? 0;
  const searchableArtifactWarningCount = input.ingest?.searchableArtifactWarnings?.length ?? 0;
  const layoutDocumentCount =
    input.ingest?.documents.filter((document) => document.layout).length ?? 0;
  const pageAuditCounts = pageAuditCountsForIngest(input.ingest);
  const chunkRelationshipCount = input.ingest?.chunkRelationships.length ?? 0;
  const indexedVectorCount = input.postIngest?.metrics.indexedVectorCount ?? 0;
  const indexedVisualVectorCount = input.postIngest?.metrics.indexedVisualVectorCount ?? 0;
  const knowledgeEntityCount = input.postIngest?.metrics.knowledgeEntityCount ?? 0;
  const knowledgeRelationCount = input.postIngest?.metrics.knowledgeRelationCount ?? 0;
  const warningCodes = readinessWarningCodes({
    chunkCount,
    derivedChunkCount,
    layoutDocumentCount,
    pagesNeedingOcrCount: pageAuditCounts.pagesNeedingOcrCount,
    parserQualityWarningCount,
    searchableArtifactWarningCount,
    chunkRelationshipCount,
    ...(input.postIngest?.status === undefined
      ? {}
      : { postIngestStatus: input.postIngest.status }),
    indexedVectorCount,
    indexedVisualVectorCount,
    knowledgeEntityCount,
    knowledgeRelationCount
  });

  return {
    textIndexReady: chunkCount > 0,
    vectorIndexReady: indexedVectorCount > 0,
    visualIndexReady: indexedVisualVectorCount > 0,
    graphReady: knowledgeEntityCount > 0 || knowledgeRelationCount > 0,
    connectedChunkExpansionReady: chunkRelationshipCount > 0,
    documentCount,
    chunkCount,
    bodyChunkCount,
    derivedChunkCount,
    searchableUnitCounts,
    layoutDocumentCount,
    pageCount: pageAuditCounts.pageCount,
    pagesNeedingOcrCount: pageAuditCounts.pagesNeedingOcrCount,
    parserQualityWarningCount,
    searchableArtifactWarningCount,
    chunkRelationshipCount,
    indexedVectorCount,
    indexedVisualVectorCount,
    knowledgeEntityCount,
    knowledgeRelationCount,
    warningCodes
  };
}

function readinessWarningCodes(input: {
  readonly chunkCount: number;
  readonly derivedChunkCount: number;
  readonly layoutDocumentCount: number;
  readonly pagesNeedingOcrCount: number;
  readonly parserQualityWarningCount: number;
  readonly searchableArtifactWarningCount: number;
  readonly chunkRelationshipCount: number;
  readonly postIngestStatus?: string;
  readonly indexedVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
}): readonly string[] {
  const warnings: string[] = [];
  if (input.chunkCount === 0) {
    warnings.push("text_index_empty");
  }
  if (input.layoutDocumentCount > 0 && input.derivedChunkCount === 0) {
    warnings.push("derived_searchable_units_empty");
  }
  if (input.pagesNeedingOcrCount > 0) {
    warnings.push("pages_need_ocr");
  }
  if (input.parserQualityWarningCount > 0) {
    warnings.push("parser_quality_warnings");
  }
  if (input.searchableArtifactWarningCount > 0) {
    warnings.push("searchable_artifact_warnings");
  }
  if (input.chunkCount > 1 && input.chunkRelationshipCount === 0) {
    warnings.push("connected_chunk_relationships_missing");
  }
  if (input.postIngestStatus === "failed" || input.postIngestStatus === "partial") {
    warnings.push(`post_ingest_${input.postIngestStatus}`);
  }
  if (input.indexedVectorCount === 0) {
    warnings.push("vector_index_empty");
  }
  if (input.indexedVisualVectorCount === 0) {
    warnings.push("visual_index_empty");
  }
  if (input.knowledgeEntityCount === 0 && input.knowledgeRelationCount === 0) {
    warnings.push("graph_knowledge_empty");
  }
  return [...new Set(warnings)].sort();
}

function searchableUnitCountsForChunks(
  chunks: readonly NonNullable<IngestPipelineResult["chunks"]>[number][]
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) {
    const unitType = searchableUnitTypeForChunk(chunk);
    counts[unitType] = (counts[unitType] ?? 0) + 1;
  }
  return counts;
}

function searchableUnitTypeForChunk(
  chunk: NonNullable<IngestPipelineResult["chunks"]>[number]
): string {
  const value = chunk.metadata?.["searchableUnitType"];
  return typeof value === "string" && value.trim().length > 0 ? value : "body_chunk";
}

function pageAuditCountsForIngest(ingest: IngestPipelineResult | undefined): {
  readonly pageCount: number;
  readonly pagesNeedingOcrCount: number;
} {
  if (!ingest) {
    return { pageCount: 0, pagesNeedingOcrCount: 0 };
  }

  return ingest.documents.reduce(
    (counts, document) => {
      const audit = auditPagesForOcr(document.layout);
      return {
        pageCount: counts.pageCount + audit.pageCount,
        pagesNeedingOcrCount: counts.pagesNeedingOcrCount + audit.pagesNeedingOcr.length
      };
    },
    { pageCount: 0, pagesNeedingOcrCount: 0 }
  );
}
