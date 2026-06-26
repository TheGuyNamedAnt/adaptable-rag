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
  | "parser_fallback_selected"
  | "parser_visual_selected_for_text_like_document"
  | "parser_failed_attempts"
  | "parser_rejected_attempts";

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
  readonly fallbackSelectedCount: number;
  readonly visualSelectedForTextLikeDocumentCount: number;
  readonly failedAttemptCount: number;
  readonly rejectedAttemptCount: number;
  readonly skippedCandidateCount: number;
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
  let fallbackSelectedCount = 0;
  let visualSelectedForTextLikeDocumentCount = 0;
  let failedAttemptCount = 0;
  let rejectedAttemptCount = 0;
  let skippedCandidateCount = 0;

  for (const document of documents) {
    const trace = parserRouterTraceForDocument(document);
    if (!trace) {
      continue;
    }

    tracedDocumentCount += 1;
    const selectedScore = numericMetadata(document, "parserRouterSelectedScore");
    if (selectedScore !== undefined) {
      selectedScoreTotal += selectedScore;
      if (selectedScore < thresholds.minimumSelectedScore) {
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

    if (rejectedAttempts.length > 0) {
      warnings.push(
        warning(
          document,
          "parser_rejected_attempts",
          `Parser router rejected ${rejectedAttempts.length} attempt(s) before selecting "${trace.selectedParserId ?? "unknown"}".`
        )
      );
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
      fallbackSelectedCount,
      visualSelectedForTextLikeDocumentCount,
      failedAttemptCount,
      rejectedAttemptCount,
      skippedCandidateCount,
      warningCount: warnings.length,
      readiness
    },
    warnings
  };
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
  const contentType = document.metadata?.["contentType"];
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
