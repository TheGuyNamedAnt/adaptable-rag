import type { RagDocument } from "./document.js";

export type DocumentIntelligenceType =
  | "shareholder_agreement"
  | "operating_agreement"
  | "incorporation"
  | "trust_deed"
  | "cap_table"
  | "financial_statement"
  | "support_policy"
  | "generic_document";

export type DocumentIntelligenceSignal =
  | "ownership_terms"
  | "entity_formation_terms"
  | "trust_terms"
  | "cap_table_terms"
  | "financial_metric_terms"
  | "support_policy_terms"
  | "has_tables"
  | "has_figures"
  | "has_structured_layout";

export interface DocumentIntelligenceResult {
  readonly documentId: string;
  readonly docType: DocumentIntelligenceType;
  readonly confidence: number;
  readonly signals: readonly DocumentIntelligenceSignal[];
  readonly shouldExtractGraph: boolean;
  readonly shouldPreserveStructuredRegions: boolean;
  readonly reason: string;
}

const EXTRACTABLE_GRAPH_TYPES: readonly DocumentIntelligenceType[] = [
  "shareholder_agreement",
  "operating_agreement",
  "incorporation",
  "trust_deed",
  "cap_table"
];

export function classifyDocumentIntelligence(document: RagDocument): DocumentIntelligenceResult {
  const haystack = `${document.title}\n${document.body}`.toLowerCase();
  const signals = detectSignals(document, haystack);
  const docType = classifyType(haystack, signals);
  const shouldExtractGraph =
    EXTRACTABLE_GRAPH_TYPES.includes(docType) &&
    (signals.includes("ownership_terms") ||
      signals.includes("entity_formation_terms") ||
      signals.includes("trust_terms") ||
      signals.includes("cap_table_terms"));

  return {
    documentId: document.id,
    docType,
    confidence: confidenceFor(docType, signals),
    signals,
    shouldExtractGraph,
    shouldPreserveStructuredRegions:
      signals.includes("has_tables") ||
      signals.includes("has_figures") ||
      signals.includes("has_structured_layout"),
    reason: reasonFor(docType, signals, shouldExtractGraph)
  };
}

function detectSignals(
  document: RagDocument,
  haystack: string
): readonly DocumentIntelligenceSignal[] {
  const signals = new Set<DocumentIntelligenceSignal>();

  if (
    /\b(ownership|owns|owned by|shareholder|member interest|subsidiar|parent company)\b/u.test(
      haystack
    )
  ) {
    signals.add("ownership_terms");
  }
  if (
    /\b(incorporat|formation|articles of organization|certificate of formation|registered in)\b/u.test(
      haystack
    )
  ) {
    signals.add("entity_formation_terms");
  }
  if (/\b(trustee|beneficiar|settlor|grantor|trust deed|deed of trust)\b/u.test(haystack)) {
    signals.add("trust_terms");
  }
  if (
    /\b(cap table|capitalization table|fully diluted|shares outstanding|ownership percentage)\b/u.test(
      haystack
    )
  ) {
    signals.add("cap_table_terms");
  }
  if (
    /\b(revenue|ebitda|assets|liabilities|cash flow|balance sheet|income statement)\b/u.test(
      haystack
    )
  ) {
    signals.add("financial_metric_terms");
  }
  if (/\b(refund|support|escalat|ticket|customer|policy)\b/u.test(haystack)) {
    signals.add("support_policy_terms");
  }

  if ((document.layout?.tables?.length ?? 0) > 0) {
    signals.add("has_tables");
  }
  if ((document.layout?.visualAssets ?? []).some((asset) => asset.kind === "figure")) {
    signals.add("has_figures");
  }
  if ((document.layout?.regions.length ?? 0) > 0) {
    signals.add("has_structured_layout");
  }

  return [...signals].sort();
}

function classifyType(
  haystack: string,
  signals: readonly DocumentIntelligenceSignal[]
): DocumentIntelligenceType {
  if (/\b(shareholder agreement|stockholder agreement)\b/u.test(haystack)) {
    return "shareholder_agreement";
  }
  if (
    /\b(operating agreement|limited liability company agreement|llc agreement)\b/u.test(haystack)
  ) {
    return "operating_agreement";
  }
  if (
    signals.includes("entity_formation_terms") &&
    /\b(articles|certificate|incorporat|formation)\b/u.test(haystack)
  ) {
    return "incorporation";
  }
  if (signals.includes("trust_terms")) {
    return "trust_deed";
  }
  if (signals.includes("cap_table_terms")) {
    return "cap_table";
  }
  if (signals.includes("financial_metric_terms")) {
    return "financial_statement";
  }
  if (signals.includes("support_policy_terms")) {
    return "support_policy";
  }
  return "generic_document";
}

function confidenceFor(
  docType: DocumentIntelligenceType,
  signals: readonly DocumentIntelligenceSignal[]
): number {
  if (docType === "generic_document") {
    return 0.5;
  }
  return Math.min(0.95, 0.65 + signals.length * 0.06);
}

function reasonFor(
  docType: DocumentIntelligenceType,
  signals: readonly DocumentIntelligenceSignal[],
  shouldExtractGraph: boolean
): string {
  return `Classified as ${docType} from ${signals.length} signal(s); graph extraction ${
    shouldExtractGraph ? "recommended" : "not recommended"
  }.`;
}
