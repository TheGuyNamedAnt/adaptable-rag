import type { RagDocument } from "../documents/document.js";
import type { ParserEscalationRecommendation } from "./parser-escalation-policy.js";
import type { ParserQualityWarning, ParserQualityWarningCode } from "./parser-quality.js";

interface ParserRouterAttemptTraceShape {
  readonly parserId?: string;
  readonly tier?: string;
  readonly status?: string;
  readonly qualityScore?: number;
  readonly reasons?: readonly string[];
}

interface ParserRouterTraceShape {
  readonly selectedParserId?: string;
  readonly selectedTier?: string;
  readonly attempts: readonly ParserRouterAttemptTraceShape[];
}

export interface ParserDecisionAttemptTrace {
  readonly parserId?: string;
  readonly tier?: string;
  readonly status?: string;
  readonly qualityScore?: number;
  readonly reasons?: readonly string[];
}

export interface ParserDecisionTrace {
  readonly documentId: string;
  readonly sourceId: string;
  readonly selectedParserId?: string;
  readonly selectedTier?: string;
  readonly selectedScore?: number;
  readonly attemptCount: number;
  readonly failedAttemptCount: number;
  readonly rejectedAttemptCount: number;
  readonly skippedAttemptCount: number;
  readonly warningCodes: readonly ParserQualityWarningCode[];
  readonly escalationReasons: readonly string[];
  readonly escalationTargetParserIds: readonly string[];
  readonly needsEscalation: boolean;
  readonly attempts: readonly ParserDecisionAttemptTrace[];
}

export interface ParserDecisionTraceInput {
  readonly documents: readonly RagDocument[];
  readonly warnings: readonly ParserQualityWarning[];
  readonly escalationRecommendations?: readonly ParserEscalationRecommendation[];
}

export function buildParserDecisionTraces(
  input: ParserDecisionTraceInput
): readonly ParserDecisionTrace[] {
  const warningsByDocumentId = groupByDocumentId(input.warnings);
  const recommendationsByDocumentId = new Map(
    (input.escalationRecommendations ?? []).map((recommendation) => [
      recommendation.documentId,
      recommendation
    ])
  );

  return input.documents.map((document) => {
    const routerTrace = parserRouterTraceForDocument(document);
    const warnings = warningsByDocumentId.get(document.id) ?? [];
    const recommendation = recommendationsByDocumentId.get(document.id);
    const attempts = routerTrace?.attempts ?? [];

    return {
      documentId: document.id,
      sourceId: document.provenance.sourceId,
      ...(routerTrace?.selectedParserId === undefined
        ? {}
        : { selectedParserId: routerTrace.selectedParserId }),
      ...(routerTrace?.selectedTier === undefined
        ? {}
        : { selectedTier: routerTrace.selectedTier }),
      ...selectedScoreMetadata(document),
      attemptCount: attempts.length,
      failedAttemptCount: attempts.filter((attempt) => attempt.status === "failed").length,
      rejectedAttemptCount: attempts.filter((attempt) => attempt.status === "rejected").length,
      skippedAttemptCount: attempts.filter((attempt) => attempt.status === "skipped").length,
      warningCodes: [...new Set(warnings.map((warning) => warning.code))],
      escalationReasons: recommendation?.reasons ?? [],
      escalationTargetParserIds: recommendation?.targetParserIds ?? [],
      needsEscalation: recommendation !== undefined && recommendation.targetParserIds.length > 0,
      attempts: attempts.map((attempt) => ({
        ...(attempt.parserId === undefined ? {} : { parserId: attempt.parserId }),
        ...(attempt.tier === undefined ? {} : { tier: attempt.tier }),
        ...(attempt.status === undefined ? {} : { status: attempt.status }),
        ...(attempt.qualityScore === undefined ? {} : { qualityScore: attempt.qualityScore }),
        ...(attempt.reasons === undefined ? {} : { reasons: attempt.reasons })
      }))
    };
  });
}

function groupByDocumentId(
  warnings: readonly ParserQualityWarning[]
): ReadonlyMap<string, readonly ParserQualityWarning[]> {
  const grouped = new Map<string, ParserQualityWarning[]>();
  for (const warning of warnings) {
    grouped.set(warning.documentId, [...(grouped.get(warning.documentId) ?? []), warning]);
  }
  return grouped;
}

function selectedScoreMetadata(document: RagDocument): { readonly selectedScore?: number } {
  const value = document.metadata?.["parserRouterSelectedScore"];
  return typeof value === "number" && Number.isFinite(value) ? { selectedScore: value } : {};
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
