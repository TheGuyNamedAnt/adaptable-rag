import type { RagDocument } from "../documents/document.js";

interface ParserRouterAttemptTraceShape {
  readonly status?: string;
}

interface ParserRouterTraceShape {
  readonly selectedParserId?: string;
  readonly selectedTier?: string;
  readonly attempts: readonly ParserRouterAttemptTraceShape[];
}

export type ParserQualityWarningCode =
  | "parser_score_below_threshold"
  | "parser_failed_result_selected"
  | "parser_fallback_selected"
  | "parser_visual_selected_for_text_like_document"
  | "parser_failed_attempts"
  | "parser_rejected_attempts"
  | "parser_table_structure_missing"
  | "parser_visual_assets_missing"
  | "parser_layout_missing_for_complex_document"
  | "parser_markdown_selected_for_layout_risk"
  | "parser_page_text_coverage_low";

export interface ParserQualityWarning {
  readonly documentId: string;
  readonly sourceId: string;
  readonly code: ParserQualityWarningCode;
  readonly message: string;
}

export interface ParserQualityThresholds {
  readonly minimumSelectedScore: number;
  readonly minimumTracedDocumentsForTesting: number;
  readonly recommendedTracedDocumentsForBaseline: number;
}

export interface ParserQualityReadiness {
  readonly status: "insufficient" | "ready";
  readonly tracedDocumentCount: number;
  readonly minimumTracedDocumentsForTesting: number;
  readonly recommendedTracedDocumentsForBaseline: number;
  readonly message: string;
}

export interface ParserQualitySummary {
  readonly documentCount: number;
  readonly tracedDocumentCount: number;
  readonly untracedDocumentCount: number;
  readonly averageSelectedScore?: number;
  readonly lowScoreDocumentCount: number;
  readonly failedResultSelectedCount: number;
  readonly fallbackSelectedCount: number;
  readonly visualSelectedForTextLikeDocumentCount: number;
  readonly failedAttemptCount: number;
  readonly rejectedAttemptCount: number;
  readonly skippedCandidateCount: number;
  readonly tableStructureMissingCount: number;
  readonly visualAssetsMissingCount: number;
  readonly layoutMissingForComplexDocumentCount: number;
  readonly markdownSelectedForLayoutRiskCount: number;
  readonly pageTrackedDocumentCount: number;
  readonly lowPageTextCoverageDocumentCount: number;
  readonly emptyPageCount: number;
  readonly warningCount: number;
  readonly readiness: ParserQualityReadiness;
}

export interface ParserQualityAnalysisResult {
  readonly summary: ParserQualitySummary;
  readonly warnings: readonly ParserQualityWarning[];
}

const DEFAULT_THRESHOLDS: ParserQualityThresholds = {
  minimumSelectedScore: 80,
  minimumTracedDocumentsForTesting: 30,
  recommendedTracedDocumentsForBaseline: 100
};

export function analyzeParserQualityForDocuments(
  documents: readonly RagDocument[],
  thresholds: ParserQualityThresholds = DEFAULT_THRESHOLDS
): ParserQualityAnalysisResult {
  const warnings: ParserQualityWarning[] = [];
  let tracedDocumentCount = 0;
  let selectedScoreTotal = 0;
  let lowScoreDocumentCount = 0;
  let failedResultSelectedCount = 0;
  let fallbackSelectedCount = 0;
  let visualSelectedForTextLikeDocumentCount = 0;
  let failedAttemptCount = 0;
  let rejectedAttemptCount = 0;
  let skippedCandidateCount = 0;
  let tableStructureMissingCount = 0;
  let visualAssetsMissingCount = 0;
  let layoutMissingForComplexDocumentCount = 0;
  let markdownSelectedForLayoutRiskCount = 0;
  let pageTrackedDocumentCount = 0;
  let lowPageTextCoverageDocumentCount = 0;
  let emptyPageCount = 0;

  for (const document of documents) {
    if (document.metadata?.["parserFailed"] === true) {
      failedResultSelectedCount += 1;
      warnings.push(
        warning(
          document,
          "parser_failed_result_selected",
          "Selected parser result was marked as failed; downstream retrieval should not trust this extraction."
        )
      );
    }

    const trace = parserRouterTraceForDocument(document);
    if (trace) {
      tracedDocumentCount += 1;
      const selectedScore = numericMetadata(document, "parserRouterSelectedScore");
      let selectedScoreBelowThreshold = selectedScore === undefined;
      if (selectedScore !== undefined) {
        selectedScoreTotal += selectedScore;
        if (selectedScore < thresholds.minimumSelectedScore) {
          selectedScoreBelowThreshold = true;
          lowScoreDocumentCount += 1;
          warnings.push(
            warning(
              document,
              "parser_score_below_threshold",
              `Parser selected score ${selectedScore} below threshold ${thresholds.minimumSelectedScore}.`
            )
          );
        }
      }

      if (trace.selectedTier === "fallback") {
        fallbackSelectedCount += 1;
        warnings.push(
          warning(
            document,
            "parser_fallback_selected",
            `Parser router selected fallback parser "${trace.selectedParserId ?? "unknown"}".`
          )
        );
      }

      if (trace.selectedTier === "visual_local" && isTextLikeDocument(document)) {
        visualSelectedForTextLikeDocumentCount += 1;
        warnings.push(
          warning(
            document,
            "parser_visual_selected_for_text_like_document",
            `Parser router selected visual parser "${trace.selectedParserId ?? "unknown"}" for text-like content.`
          )
        );
      }

      const failedAttempts = trace.attempts.filter((attempt) => attempt.status === "failed");
      const rejectedAttempts = trace.attempts.filter((attempt) => attempt.status === "rejected");
      const skippedAttempts = trace.attempts.filter((attempt) => attempt.status === "skipped");
      failedAttemptCount += failedAttempts.length;
      rejectedAttemptCount += rejectedAttempts.length;
      skippedCandidateCount += skippedAttempts.length;

      if (failedAttempts.length > 0) {
        warnings.push(
          warning(
            document,
            "parser_failed_attempts",
            `Parser router had ${failedAttempts.length} failed attempt(s) before selecting "${trace.selectedParserId ?? "unknown"}".`
          )
        );
      }

      if (
        rejectedAttempts.length > 0 &&
        (selectedScoreBelowThreshold ||
          trace.selectedTier === "fallback" ||
          failedAttempts.length > 0)
      ) {
        warnings.push(
          warning(
            document,
            "parser_rejected_attempts",
            `Parser router rejected ${rejectedAttempts.length} attempt(s) before selecting "${trace.selectedParserId ?? "unknown"}".`
          )
        );
      }
    }

    if (hasTableLikeText(document) && !hasStructuredTables(document)) {
      tableStructureMissingCount += 1;
      warnings.push(
        warning(
          document,
          "parser_table_structure_missing",
          "Document contains table-like text, but the selected parser emitted no structured tables."
        )
      );
    }

    if (hasVisualReferenceText(document) && !hasVisualAssets(document)) {
      visualAssetsMissingCount += 1;
      warnings.push(
        warning(
          document,
          "parser_visual_assets_missing",
          "Document references figures, charts, diagrams, screenshots, or images, but the selected parser emitted no visual assets."
        )
      );
    }

    if (isLayoutRiskDocument(document) && !document.layout) {
      layoutMissingForComplexDocumentCount += 1;
      warnings.push(
        warning(
          document,
          "parser_layout_missing_for_complex_document",
          "Document content type commonly needs layout-aware parsing, but the selected parser emitted no layout."
        )
      );
    }

    if (isMarkdownParser(trace?.selectedParserId) && isLayoutRiskDocument(document)) {
      markdownSelectedForLayoutRiskCount += 1;
      warnings.push(
        warning(
          document,
          "parser_markdown_selected_for_layout_risk",
          `Markdown parser "${trace?.selectedParserId ?? "unknown"}" was selected for a layout-risk document.`
        )
      );
    }

    const pageCompleteness = pageCompletenessForDocument(document);
    if (pageCompleteness) {
      pageTrackedDocumentCount += 1;
      emptyPageCount += pageCompleteness.emptyPageCount;
      if (pageCompleteness.textCoverageRatio < 0.8) {
        lowPageTextCoverageDocumentCount += 1;
        warnings.push(
          warning(
            document,
            "parser_page_text_coverage_low",
            `Parser extracted text for ${pageCompleteness.pagesWithText}/${pageCompleteness.pageCount} page(s).`
          )
        );
      }
    }
  }

  const averageSelectedScore =
    tracedDocumentCount === 0 ? undefined : Math.round(selectedScoreTotal / tracedDocumentCount);
  const readiness = parserQualityReadiness(tracedDocumentCount, thresholds);

  return {
    summary: {
      documentCount: documents.length,
      tracedDocumentCount,
      untracedDocumentCount: documents.length - tracedDocumentCount,
      ...(averageSelectedScore === undefined ? {} : { averageSelectedScore }),
      lowScoreDocumentCount,
      failedResultSelectedCount,
      fallbackSelectedCount,
      visualSelectedForTextLikeDocumentCount,
      failedAttemptCount,
      rejectedAttemptCount,
      skippedCandidateCount,
      tableStructureMissingCount,
      visualAssetsMissingCount,
      layoutMissingForComplexDocumentCount,
      markdownSelectedForLayoutRiskCount,
      pageTrackedDocumentCount,
      lowPageTextCoverageDocumentCount,
      emptyPageCount,
      warningCount: warnings.length,
      readiness
    },
    warnings
  };
}

interface PageCompleteness {
  readonly pageCount: number;
  readonly pagesWithText: number;
  readonly emptyPageCount: number;
  readonly textCoverageRatio: number;
}

function pageCompletenessForDocument(document: RagDocument): PageCompleteness | undefined {
  if (document.layout) {
    const pageNumbers = new Set(document.layout.pages.map((page) => page.pageNumber));
    const pagesWithText = new Set(
      document.layout.regions.flatMap((region) => (region.text?.trim() ? [region.pageNumber] : []))
    );
    return pageCompleteness(pageNumbers.size, pagesWithText.size);
  }

  const pageCount = numericMetadata(document, "pageCount");
  const pagesWithText = numericMetadata(document, "pagesWithText");
  if (pageCount === undefined || pagesWithText === undefined) {
    return undefined;
  }
  return pageCompleteness(pageCount, pagesWithText);
}

function pageCompleteness(pageCount: number, pagesWithText: number): PageCompleteness | undefined {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    return undefined;
  }
  const safePagesWithText = Math.max(0, Math.min(pageCount, Math.floor(pagesWithText)));
  return {
    pageCount,
    pagesWithText: safePagesWithText,
    emptyPageCount: pageCount - safePagesWithText,
    textCoverageRatio: safePagesWithText / pageCount
  };
}

function hasStructuredTables(document: RagDocument): boolean {
  return (document.layout?.tables?.length ?? 0) > 0;
}

function hasVisualAssets(document: RagDocument): boolean {
  return (document.layout?.visualAssets?.length ?? 0) > 0;
}

function hasTableLikeText(document: RagDocument): boolean {
  const contentType = contentTypeForDocument(document);
  const lines = document.body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const pipeTableRows = lines.filter((line) => line.includes("|"));
  const pipeCounts = new Set(pipeTableRows.map((line) => line.split("|").length));
  if (pipeTableRows.length >= 2 && pipeCounts.size <= 2) {
    return true;
  }

  if (isStructuredMarkupContentType(contentType)) {
    return false;
  }

  const commaRows = lines.filter((line) => line.split(",").length >= 3);
  if (commaRows.length >= 3) {
    return true;
  }

  return /\b(cap table|capitalization table|balance sheet|income statement|row total|column total)\b/iu.test(
    document.body
  );
}

function hasVisualReferenceText(document: RagDocument): boolean {
  return /\b(fig\.?|figure|chart|diagram|screenshot)\s*\d*\b|\b(see|shown|pictured|displayed)\s+(below|above|in|as)\b|\b(see|shown)\s+(the\s+)?(figure|chart|diagram|screenshot|image)\b/iu.test(
    document.body
  );
}

function isLayoutRiskDocument(document: RagDocument): boolean {
  const contentType = contentTypeForDocument(document);
  if (!contentType) {
    return false;
  }

  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ].includes(contentType);
}

function isMarkdownParser(parserId: string | undefined): boolean {
  return parserId === "markitdown-command-markdown-parser" || parserId === "markdown-parser";
}

function parserQualityReadiness(
  tracedDocumentCount: number,
  thresholds: ParserQualityThresholds
): ParserQualityReadiness {
  if (tracedDocumentCount >= thresholds.minimumTracedDocumentsForTesting) {
    return {
      status: "ready",
      tracedDocumentCount,
      minimumTracedDocumentsForTesting: thresholds.minimumTracedDocumentsForTesting,
      recommendedTracedDocumentsForBaseline: thresholds.recommendedTracedDocumentsForBaseline,
      message:
        tracedDocumentCount >= thresholds.recommendedTracedDocumentsForBaseline
          ? "Enough traced documents for stable parser-quality baseline testing."
          : "Enough traced documents for parser-quality testing; collect more for a stable baseline."
    };
  }

  return {
    status: "insufficient",
    tracedDocumentCount,
    minimumTracedDocumentsForTesting: thresholds.minimumTracedDocumentsForTesting,
    recommendedTracedDocumentsForBaseline: thresholds.recommendedTracedDocumentsForBaseline,
    message: `Need at least ${thresholds.minimumTracedDocumentsForTesting} traced parser documents before parser-quality statistics are reliable for testing.`
  };
}

function parserRouterTraceForDocument(document: RagDocument): ParserRouterTraceShape | undefined {
  const value = document.metadata?.["parserRouterTraceJson"];
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ParserRouterTraceShape>;
    if (!Array.isArray(parsed.attempts)) {
      return undefined;
    }
    return parsed as ParserRouterTraceShape;
  } catch {
    return undefined;
  }
}

function numericMetadata(document: RagDocument, key: string): number | undefined {
  const value = document.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTextLikeDocument(document: RagDocument): boolean {
  const contentType = contentTypeForDocument(document);
  if (typeof contentType !== "string") {
    return false;
  }

  return (
    contentType.startsWith("text/") ||
    ["application/json", "application/x-ndjson", "application/yaml", "application/xml"].includes(
      contentType
    )
  );
}

function contentTypeForDocument(document: RagDocument): string | undefined {
  const contentType = document.metadata?.["contentType"];
  return typeof contentType === "string" ? contentType : undefined;
}

function isStructuredMarkupContentType(contentType: string | undefined): boolean {
  return [
    "application/json",
    "application/x-ndjson",
    "application/yaml",
    "application/xml",
    "text/xml"
  ].includes(contentType ?? "");
}

function warning(
  document: RagDocument,
  code: ParserQualityWarningCode,
  message: string
): ParserQualityWarning {
  return {
    documentId: document.id,
    sourceId: document.provenance.sourceId,
    code,
    message
  };
}
