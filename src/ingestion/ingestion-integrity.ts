import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import { auditPagesForOcr } from "../documents/page-ocr-audit.js";
import type { IngestPipelineResult } from "./ingest-pipeline.js";
import type { SearchableUnitType } from "./searchable-artifacts.js";

export type IngestionIntegrityStatus = "passed" | "warning" | "failed";
export type IngestionIntegritySeverity = "error" | "warning";

export type IngestionIntegrityIssueCode =
  | "documents_empty"
  | "chunks_empty"
  | "record_rejected"
  | "normalization_issue"
  | "adapter_warning"
  | "parser_quality_warning"
  | "searchable_artifact_warning"
  | "chunking_warning"
  | "index_write_rejected"
  | "layout_missing_for_complex_document"
  | "page_needs_ocr"
  | "table_not_searchable"
  | "table_rows_not_searchable"
  | "visual_asset_not_searchable"
  | "layout_relations_not_searchable"
  | "chunk_relationships_missing"
  | "vector_coverage_low"
  | "visual_vector_coverage_low"
  | "graph_knowledge_missing";

export interface IngestionIntegrityIssue {
  readonly severity: IngestionIntegritySeverity;
  readonly code: IngestionIntegrityIssueCode;
  readonly documentId?: string;
  readonly chunkId?: string;
  readonly sourceId?: string;
  readonly pageNumber?: number;
  readonly message: string;
}

export interface IngestionIntegrityPostIngestMetrics {
  readonly indexedVectorCount?: number;
  readonly indexedVisualVectorCount?: number;
  readonly indexedRelationVectorCount?: number;
  readonly candidateRelationCount?: number;
  readonly knowledgeEntityCount?: number;
  readonly knowledgeRelationCount?: number;
}

export interface IngestionIntegrityOptions {
  readonly requireLayoutForComplexDocuments?: boolean;
  readonly requireChunkRelationships?: boolean;
  readonly requireVectorCoverage?: boolean;
  readonly requireVisualCoverage?: boolean;
  readonly requireGraphCoverage?: boolean;
  readonly minimumVectorCoverageRatio?: number;
  readonly minimumVisualVectorCoverageRatio?: number;
  readonly ocrNeededSeverity?: IngestionIntegritySeverity;
  readonly parserWarningSeverity?: IngestionIntegritySeverity;
  readonly searchableArtifactWarningSeverity?: IngestionIntegritySeverity;
}

export interface IngestionIntegrityCounts {
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly bodyChunkCount: number;
  readonly derivedChunkCount: number;
  readonly pageSummaryChunkCount: number;
  readonly parserGapChunkCount: number;
  readonly pageCount: number;
  readonly pagesNeedingOcrCount: number;
  readonly tableCount: number;
  readonly tableRowCount: number;
  readonly visualAssetCount: number;
  readonly layoutRelationCount: number;
  readonly chunkRelationshipCount: number;
  readonly indexedVectorCount: number;
  readonly indexedVisualVectorCount: number;
  readonly indexedRelationVectorCount: number;
  readonly knowledgeEntityCount: number;
  readonly knowledgeRelationCount: number;
}

export interface IngestionIntegrityReport {
  readonly status: IngestionIntegrityStatus;
  readonly counts: IngestionIntegrityCounts;
  readonly searchableUnitCounts: Readonly<Record<string, number>>;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly issues: readonly IngestionIntegrityIssue[];
}

export function buildIngestionIntegrityReport(input: {
  readonly ingest: IngestPipelineResult;
  readonly postIngest?: IngestionIntegrityPostIngestMetrics;
  readonly options?: IngestionIntegrityOptions;
}): IngestionIntegrityReport {
  const options = normalizeOptions(input.options);
  const issues: IngestionIntegrityIssue[] = [];
  const documents = input.ingest.documents;
  const chunks = input.ingest.chunks;
  const searchableUnitCounts = searchableUnitCountsForChunks(chunks);
  const counts = integrityCounts(input.ingest, input.postIngest, searchableUnitCounts);

  if (counts.documentCount === 0) {
    issues.push(error("documents_empty", "No documents were accepted by ingestion."));
  }
  if (counts.chunkCount === 0) {
    issues.push(error("chunks_empty", "No chunks were accepted by ingestion."));
  }

  for (const rejected of input.ingest.rejectedRecords) {
    issues.push(
      error("record_rejected", `Record "${rejected.recordId}" was rejected: ${rejected.reason}`, {
        sourceId: rejected.sourceId
      })
    );
  }

  for (const issue of input.ingest.normalizationIssues) {
    issues.push(
      addIssue(
        issue.severity === "error" ? "error" : "warning",
        "normalization_issue",
        issue.message,
        {
          documentId: issue.recordId
        }
      )
    );
  }

  for (const warning of input.ingest.adapterWarnings) {
    issues.push(
      addIssue("warning", "adapter_warning", warning.message, {
        sourceId: warning.sourceId
      })
    );
  }

  for (const warning of input.ingest.parserQualityWarnings) {
    issues.push(
      addIssue(options.parserWarningSeverity, "parser_quality_warning", warning.message, {
        documentId: warning.documentId,
        sourceId: warning.sourceId
      })
    );
  }

  for (const warning of input.ingest.searchableArtifactWarnings ?? []) {
    issues.push(
      addIssue(
        options.searchableArtifactWarningSeverity,
        "searchable_artifact_warning",
        warning.message,
        {
          documentId: warning.documentId
        }
      )
    );
  }

  for (const warning of input.ingest.chunkingWarnings) {
    issues.push(
      addIssue("warning", "chunking_warning", warning.message, {
        documentId: warning.documentId
      })
    );
  }

  for (const indexResult of input.ingest.indexResults) {
    if (!indexResult.accepted) {
      issues.push(
        error("index_write_rejected", indexResult.message, {
          chunkId: indexResult.id
        })
      );
    }
  }

  for (const document of documents) {
    addDocumentIntegrityIssues(document, chunks, options, issues);
  }

  if (
    options.requireChunkRelationships &&
    counts.chunkCount > 1 &&
    counts.chunkRelationshipCount === 0
  ) {
    issues.push(
      error(
        "chunk_relationships_missing",
        "Multiple chunks were accepted, but no connected chunk relationships were produced."
      )
    );
  }

  addVectorCoverageIssues(counts, options, issues);
  addGraphCoverageIssues(counts, options, issues);

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    status: errorCount > 0 ? "failed" : warningCount > 0 ? "warning" : "passed",
    counts,
    searchableUnitCounts,
    issueCount: issues.length,
    errorCount,
    warningCount,
    issues
  };
}

function normalizeOptions(
  options: IngestionIntegrityOptions = {}
): Required<IngestionIntegrityOptions> {
  return {
    requireLayoutForComplexDocuments: options.requireLayoutForComplexDocuments ?? true,
    requireChunkRelationships: options.requireChunkRelationships ?? true,
    requireVectorCoverage: options.requireVectorCoverage ?? false,
    requireVisualCoverage: options.requireVisualCoverage ?? false,
    requireGraphCoverage: options.requireGraphCoverage ?? false,
    minimumVectorCoverageRatio: options.minimumVectorCoverageRatio ?? 1,
    minimumVisualVectorCoverageRatio: options.minimumVisualVectorCoverageRatio ?? 1,
    ocrNeededSeverity: options.ocrNeededSeverity ?? "error",
    parserWarningSeverity: options.parserWarningSeverity ?? "warning",
    searchableArtifactWarningSeverity: options.searchableArtifactWarningSeverity ?? "warning"
  };
}

function integrityCounts(
  ingest: IngestPipelineResult,
  postIngest: IngestionIntegrityPostIngestMetrics | undefined,
  searchableUnitCounts: Readonly<Record<string, number>>
): IngestionIntegrityCounts {
  const layoutCounts = ingest.documents.reduce(
    (totals, document) => {
      const layout = document.layout;
      return {
        pageCount: totals.pageCount + (layout?.pages.length ?? 0),
        tableCount: totals.tableCount + (layout?.tables?.length ?? 0),
        tableRowCount:
          totals.tableRowCount +
          (layout?.tables ?? []).reduce(
            (sum, table) => sum + new Set(table.cells.map((cell) => cell.rowIndex)).size,
            0
          ),
        visualAssetCount: totals.visualAssetCount + (layout?.visualAssets?.length ?? 0),
        layoutRelationCount: totals.layoutRelationCount + (layout?.relations?.length ?? 0),
        pagesNeedingOcrCount:
          totals.pagesNeedingOcrCount + auditPagesForOcr(layout).pagesNeedingOcr.length
      };
    },
    {
      pageCount: 0,
      tableCount: 0,
      tableRowCount: 0,
      visualAssetCount: 0,
      layoutRelationCount: 0,
      pagesNeedingOcrCount: 0
    }
  );

  return {
    documentCount: ingest.documents.length,
    chunkCount: ingest.chunks.length,
    bodyChunkCount: searchableUnitCounts["body_chunk"] ?? 0,
    derivedChunkCount: ingest.chunks.length - (searchableUnitCounts["body_chunk"] ?? 0),
    pageSummaryChunkCount: searchableUnitCounts["page_summary_chunk"] ?? 0,
    parserGapChunkCount: searchableUnitCounts["parser_gap_chunk"] ?? 0,
    pageCount: layoutCounts.pageCount,
    pagesNeedingOcrCount: layoutCounts.pagesNeedingOcrCount,
    tableCount: layoutCounts.tableCount,
    tableRowCount: layoutCounts.tableRowCount,
    visualAssetCount: layoutCounts.visualAssetCount,
    layoutRelationCount: layoutCounts.layoutRelationCount,
    chunkRelationshipCount: ingest.chunkRelationships.length,
    indexedVectorCount: postIngest?.indexedVectorCount ?? 0,
    indexedVisualVectorCount: postIngest?.indexedVisualVectorCount ?? 0,
    indexedRelationVectorCount: postIngest?.indexedRelationVectorCount ?? 0,
    knowledgeEntityCount: postIngest?.knowledgeEntityCount ?? 0,
    knowledgeRelationCount: postIngest?.knowledgeRelationCount ?? 0
  };
}

function addDocumentIntegrityIssues(
  document: RagDocument,
  chunks: readonly RagChunk[],
  options: Required<IngestionIntegrityOptions>,
  issues: IngestionIntegrityIssue[]
): void {
  if (
    options.requireLayoutForComplexDocuments &&
    isLayoutRiskDocument(document) &&
    !document.layout
  ) {
    issues.push(
      error(
        "layout_missing_for_complex_document",
        "Document commonly needs layout-aware parsing, but no validated layout was produced.",
        { documentId: document.id, sourceId: document.provenance.sourceId }
      )
    );
  }

  const ocrAudit = auditPagesForOcr(document.layout);
  for (const page of ocrAudit.pagesNeedingOcr) {
    issues.push(
      addIssue(
        options.ocrNeededSeverity,
        "page_needs_ocr",
        `Page ${page.pageNumber} likely needs OCR: ${page.reasons.join(", ")}.`,
        {
          documentId: document.id,
          sourceId: document.provenance.sourceId,
          pageNumber: page.pageNumber
        }
      )
    );
  }

  const documentChunks = chunks.filter((chunk) => chunk.documentId === document.id);
  addTableIntegrityIssues(document, documentChunks, issues);
  addVisualIntegrityIssues(document, documentChunks, issues);
  addLayoutRelationIntegrityIssues(document, documentChunks, issues);
}

function addTableIntegrityIssues(
  document: RagDocument,
  chunks: readonly RagChunk[],
  issues: IngestionIntegrityIssue[]
): void {
  for (const table of document.layout?.tables ?? []) {
    const tableChunks = chunks.filter((chunk) => chunk.metadata?.["tableId"] === table.id);
    if (!tableChunks.some((chunk) => chunk.metadata?.["searchableUnitType"] === "table_chunk")) {
      issues.push(
        error("table_not_searchable", `Table "${table.id}" has no searchable table chunk.`, {
          documentId: document.id,
          sourceId: document.provenance.sourceId
        })
      );
    }

    const expectedRows = new Set(table.cells.map((cell) => cell.rowIndex));
    const materializedRows = new Set(
      tableChunks
        .filter((chunk) => chunk.metadata?.["searchableUnitType"] === "table_row_chunk")
        .map((chunk) => chunk.metadata?.["tableRowIndex"])
        .filter((rowIndex): rowIndex is number => typeof rowIndex === "number")
    );
    if (materializedRows.size < expectedRows.size) {
      issues.push(
        error(
          "table_rows_not_searchable",
          `Table "${table.id}" materialized ${materializedRows.size}/${expectedRows.size} row chunk(s).`,
          { documentId: document.id, sourceId: document.provenance.sourceId }
        )
      );
    }
  }
}

function addVisualIntegrityIssues(
  document: RagDocument,
  chunks: readonly RagChunk[],
  issues: IngestionIntegrityIssue[]
): void {
  for (const asset of document.layout?.visualAssets ?? []) {
    const hasSearchableVisualChunk = chunks.some(
      (chunk) =>
        chunk.metadata?.["visualAssetId"] === asset.id &&
        ["visual_asset_chunk", "figure_caption_chunk", "table_caption_chunk"].includes(
          String(chunk.metadata?.["searchableUnitType"] ?? "")
        )
    );
    if (!hasSearchableVisualChunk) {
      issues.push(
        addIssue(
          "warning",
          "visual_asset_not_searchable",
          `Visual asset "${asset.id}" has no caption/fallback searchable chunk.`,
          {
            documentId: document.id,
            sourceId: document.provenance.sourceId,
            pageNumber: asset.pageNumber
          }
        )
      );
    }
  }
}

function addLayoutRelationIntegrityIssues(
  document: RagDocument,
  chunks: readonly RagChunk[],
  issues: IngestionIntegrityIssue[]
): void {
  const relationCount = document.layout?.relations?.length ?? 0;
  if (relationCount === 0) {
    return;
  }

  const relationChunkCount = chunks.filter(
    (chunk) => chunk.metadata?.["searchableUnitType"] === "layout_relation_chunk"
  ).length;
  if (relationChunkCount === 0) {
    issues.push(
      addIssue(
        "warning",
        "layout_relations_not_searchable",
        `Document has ${relationCount} layout relation(s), but no searchable relation chunks.`,
        { documentId: document.id, sourceId: document.provenance.sourceId }
      )
    );
  }
}

function addVectorCoverageIssues(
  counts: IngestionIntegrityCounts,
  options: Required<IngestionIntegrityOptions>,
  issues: IngestionIntegrityIssue[]
): void {
  if (options.requireVectorCoverage && counts.chunkCount > 0) {
    const ratio = counts.indexedVectorCount / counts.chunkCount;
    if (ratio < options.minimumVectorCoverageRatio) {
      issues.push(
        error(
          "vector_coverage_low",
          `Text vector coverage ${counts.indexedVectorCount}/${counts.chunkCount} is below ${options.minimumVectorCoverageRatio}.`
        )
      );
    }
  }

  if (options.requireVisualCoverage && counts.visualAssetCount > 0) {
    const ratio = counts.indexedVisualVectorCount / counts.visualAssetCount;
    if (ratio < options.minimumVisualVectorCoverageRatio) {
      issues.push(
        error(
          "visual_vector_coverage_low",
          `Visual vector coverage ${counts.indexedVisualVectorCount}/${counts.visualAssetCount} is below ${options.minimumVisualVectorCoverageRatio}.`
        )
      );
    }
  }
}

function addGraphCoverageIssues(
  counts: IngestionIntegrityCounts,
  options: Required<IngestionIntegrityOptions>,
  issues: IngestionIntegrityIssue[]
): void {
  if (
    options.requireGraphCoverage &&
    counts.documentCount > 0 &&
    counts.knowledgeEntityCount === 0 &&
    counts.knowledgeRelationCount === 0
  ) {
    issues.push(
      error(
        "graph_knowledge_missing",
        "Graph/entity ingestion was required, but no knowledge entities or relations were produced."
      )
    );
  }
}

function searchableUnitCountsForChunks(
  chunks: readonly RagChunk[]
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) {
    const unitType = searchableUnitTypeForChunk(chunk);
    counts[unitType] = (counts[unitType] ?? 0) + 1;
  }
  return counts;
}

function searchableUnitTypeForChunk(chunk: RagChunk): SearchableUnitType | "body_chunk" {
  const value = chunk.metadata?.["searchableUnitType"];
  return typeof value === "string" && value.trim().length > 0
    ? (value as SearchableUnitType)
    : "body_chunk";
}

function isLayoutRiskDocument(document: RagDocument): boolean {
  const contentType = document.metadata?.["contentType"];
  return (
    typeof contentType === "string" &&
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ].includes(contentType)
  );
}

function error(
  code: IngestionIntegrityIssueCode,
  message: string,
  ids: Pick<IngestionIntegrityIssue, "documentId" | "chunkId" | "sourceId" | "pageNumber"> = {}
): IngestionIntegrityIssue {
  return addIssue("error", code, message, ids);
}

function addIssue(
  severity: IngestionIntegritySeverity,
  code: IngestionIntegrityIssueCode,
  message: string,
  ids: Pick<IngestionIntegrityIssue, "documentId" | "chunkId" | "sourceId" | "pageNumber"> = {}
): IngestionIntegrityIssue {
  return {
    severity,
    code,
    ...(ids.documentId === undefined ? {} : { documentId: ids.documentId }),
    ...(ids.chunkId === undefined ? {} : { chunkId: ids.chunkId }),
    ...(ids.sourceId === undefined ? {} : { sourceId: ids.sourceId }),
    ...(ids.pageNumber === undefined ? {} : { pageNumber: ids.pageNumber }),
    message
  };
}
