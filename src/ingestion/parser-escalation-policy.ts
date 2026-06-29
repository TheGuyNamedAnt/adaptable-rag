import type { ParserQualityWarning, ParserQualityWarningCode } from "./parser-quality.js";

export type ParserCapabilityArea =
  | "text"
  | "markdown"
  | "layout"
  | "tables"
  | "figures"
  | "ocr"
  | "page_level"
  | "visual_assets"
  | "broad_format";

export interface ParserCapabilityMatrixEntry {
  readonly parserId: string;
  readonly strengths: readonly ParserCapabilityArea[];
  readonly escalationTargets: readonly string[];
}

export type ParserEscalationReason =
  | "table_structure_needed"
  | "visual_assets_needed"
  | "layout_needed"
  | "ocr_needed"
  | "markdown_layout_risk";

export interface ParserEscalationRecommendation {
  readonly documentId: string;
  readonly sourceId: string;
  readonly currentParserId?: string;
  readonly reasons: readonly ParserEscalationReason[];
  readonly targetParserIds: readonly string[];
  readonly warningCodes: readonly ParserQualityWarningCode[];
}

export interface ParserEscalationPolicyInput {
  readonly warnings: readonly ParserQualityWarning[];
  readonly selectedParserByDocumentId?: ReadonlyMap<string, string>;
  readonly matrix?: readonly ParserCapabilityMatrixEntry[];
}

const WARNING_REASONS: Readonly<
  Record<ParserQualityWarningCode, ParserEscalationReason | undefined>
> = {
  parser_score_below_threshold: undefined,
  parser_failed_result_selected: undefined,
  parser_fallback_selected: undefined,
  parser_visual_selected_for_text_like_document: undefined,
  parser_failed_attempts: undefined,
  parser_rejected_attempts: undefined,
  parser_table_structure_missing: "table_structure_needed",
  parser_visual_assets_missing: "visual_assets_needed",
  parser_layout_missing_for_complex_document: "layout_needed",
  parser_markdown_selected_for_layout_risk: "markdown_layout_risk",
  parser_page_text_coverage_low: "ocr_needed"
};

const REASON_TARGET_CAPABILITIES: Readonly<
  Record<ParserEscalationReason, readonly ParserCapabilityArea[]>
> = {
  table_structure_needed: ["tables"],
  visual_assets_needed: ["visual_assets"],
  layout_needed: ["layout"],
  ocr_needed: ["ocr"],
  markdown_layout_risk: ["layout"]
};

const DEFAULT_ESCALATION_MATRIX = [
  {
    parserId: "plain-text-parser",
    strengths: ["text"],
    escalationTargets: ["markdown-structure-parser", "markitdown-command-markdown-parser"]
  },
  {
    parserId: "markdown-structure-parser",
    strengths: ["text", "markdown", "layout", "tables"],
    escalationTargets: ["markitdown-command-markdown-parser"]
  },
  {
    parserId: "markitdown-command-markdown-parser",
    strengths: ["text", "markdown", "broad_format"],
    escalationTargets: [
      "pdf_text-local-layout-parser",
      "docling-local-layout-parser",
      "paddleocr-local-layout-parser",
      "mineru-local-layout-parser"
    ]
  },
  {
    parserId: "pdf_text-local-layout-parser",
    strengths: ["text", "layout", "page_level"],
    escalationTargets: ["docling-local-layout-parser", "paddleocr-local-layout-parser"]
  },
  {
    parserId: "docling-local-layout-parser",
    strengths: ["text", "layout", "tables", "figures", "page_level", "visual_assets"],
    escalationTargets: ["paddleocr-local-layout-parser", "mineru-local-layout-parser"]
  },
  {
    parserId: "paddleocr-local-layout-parser",
    strengths: ["text", "layout", "ocr", "page_level", "visual_assets"],
    escalationTargets: ["mineru-local-layout-parser"]
  },
  {
    parserId: "mineru-local-layout-parser",
    strengths: ["text", "layout", "tables", "figures", "ocr", "page_level", "visual_assets"],
    escalationTargets: []
  }
] as const satisfies readonly ParserCapabilityMatrixEntry[];

export function buildParserEscalationRecommendations(
  input: ParserEscalationPolicyInput
): readonly ParserEscalationRecommendation[] {
  const grouped = new Map<string, ParserQualityWarning[]>();
  for (const warning of input.warnings) {
    if (WARNING_REASONS[warning.code] === undefined) {
      continue;
    }
    grouped.set(warning.documentId, [...(grouped.get(warning.documentId) ?? []), warning]);
  }

  return [...grouped.entries()].map(([documentId, warnings]) => {
    const currentParserId = input.selectedParserByDocumentId?.get(documentId);
    const reasons = uniqueReasons(warnings);
    return {
      documentId,
      sourceId: warnings[0]?.sourceId ?? "",
      ...(currentParserId === undefined ? {} : { currentParserId }),
      reasons,
      targetParserIds: targetParserIdsForReasons(reasons, currentParserId, input.matrix),
      warningCodes: [...new Set(warnings.map((warning) => warning.code))]
    };
  });
}

function uniqueReasons(
  warnings: readonly ParserQualityWarning[]
): readonly ParserEscalationReason[] {
  return [
    ...new Set(
      warnings.flatMap((warning) => {
        const reason = WARNING_REASONS[warning.code];
        return reason === undefined ? [] : [reason];
      })
    )
  ];
}

function targetParserIdsForReasons(
  reasons: readonly ParserEscalationReason[],
  currentParserId: string | undefined,
  matrix: readonly ParserCapabilityMatrixEntry[] | undefined
): readonly string[] {
  const capabilityMatrix = matrix ?? DEFAULT_ESCALATION_MATRIX;
  const candidates =
    currentParserId === undefined
      ? []
      : parserEscalationTargetsFor(currentParserId, capabilityMatrix);
  if (candidates.length === 0) {
    return [];
  }

  return candidates.filter((candidateId) => {
    const candidate = parserCapabilityEntryFor(candidateId, capabilityMatrix);
    if (!candidate) {
      return false;
    }
    return reasons.every((reason) =>
      REASON_TARGET_CAPABILITIES[reason].some((capability) =>
        candidate.strengths.includes(capability)
      )
    );
  });
}

function parserCapabilityEntryFor(
  parserId: string,
  matrix: readonly ParserCapabilityMatrixEntry[]
): ParserCapabilityMatrixEntry | undefined {
  return matrix.find((entry) => entry.parserId === parserId);
}

function parserEscalationTargetsFor(
  parserId: string,
  matrix: readonly ParserCapabilityMatrixEntry[]
): readonly string[] {
  return parserCapabilityEntryFor(parserId, matrix)?.escalationTargets ?? [];
}
