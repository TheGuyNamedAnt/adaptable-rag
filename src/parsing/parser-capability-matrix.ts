import type { DocumentParserCapabilities } from "./parser.js";

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

export type ParserExecutionTier = "fast_local" | "layout_local" | "visual_local" | "cloud";

export type ParserRiskSignal =
  | "table_structure_may_be_flattened"
  | "visual_content_may_be_missing"
  | "reading_order_may_be_wrong"
  | "ocr_required_for_scans"
  | "requires_external_dependency"
  | "broad_converter_not_layout_parser";

export interface ParserCapabilityMatrixEntry {
  readonly parserId: string;
  readonly label: string;
  readonly tier: ParserExecutionTier;
  readonly strengths: readonly ParserCapabilityArea[];
  readonly risks: readonly ParserRiskSignal[];
  readonly recommendedForContentTypes: readonly string[];
  readonly escalationTargets: readonly string[];
  readonly capabilities: DocumentParserCapabilities;
}

const MARKITDOWN_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/epub+zip",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/zip"
] as const;

export const DEFAULT_PARSER_CAPABILITY_MATRIX = [
  {
    parserId: "plain-text-parser",
    label: "Plain text",
    tier: "fast_local",
    strengths: ["text"],
    risks: [],
    recommendedForContentTypes: [
      "text/*",
      "application/json",
      "application/x-ndjson",
      "application/yaml"
    ],
    escalationTargets: ["markdown-structure-parser", "markitdown-command-markdown-parser"],
    capabilities: {
      inputMode: "text",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false,
      supportedContentTypes: [
        "text/*",
        "application/json",
        "application/x-ndjson",
        "application/yaml"
      ]
    }
  },
  {
    parserId: "markdown-structure-parser",
    label: "Markdown structure",
    tier: "fast_local",
    strengths: ["text", "markdown", "layout", "tables"],
    risks: [],
    recommendedForContentTypes: ["text/markdown"],
    escalationTargets: ["markitdown-command-markdown-parser"],
    capabilities: {
      inputMode: "text",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: ["text/markdown"]
    }
  },
  {
    parserId: "delimited-table-parser",
    label: "Delimited table",
    tier: "fast_local",
    strengths: ["text", "layout", "tables"],
    risks: [],
    recommendedForContentTypes: ["text/csv", "text/tab-separated-values"],
    escalationTargets: [],
    capabilities: {
      inputMode: "text",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: ["text/csv", "text/tab-separated-values"]
    }
  },
  {
    parserId: "sec-html-parser",
    label: "SEC HTML",
    tier: "fast_local",
    strengths: ["text", "layout", "tables"],
    risks: [],
    recommendedForContentTypes: ["text/html", "application/xhtml+xml"],
    escalationTargets: ["markitdown-command-markdown-parser"],
    capabilities: {
      inputMode: "text",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: ["text/html", "application/xhtml+xml"]
    }
  },
  {
    parserId: "markitdown-command-markdown-parser",
    label: "MarkItDown Markdown",
    tier: "fast_local",
    strengths: ["text", "markdown", "broad_format"],
    risks: [
      "table_structure_may_be_flattened",
      "visual_content_may_be_missing",
      "reading_order_may_be_wrong",
      "requires_external_dependency",
      "broad_converter_not_layout_parser"
    ],
    recommendedForContentTypes: MARKITDOWN_CONTENT_TYPES,
    escalationTargets: [
      "pdf_text-local-layout-parser",
      "docling-local-layout-parser",
      "paddleocr-local-layout-parser",
      "mineru-local-layout-parser"
    ],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false,
      supportedContentTypes: MARKITDOWN_CONTENT_TYPES
    }
  },
  {
    parserId: "openpyxl_command-structured-parser",
    label: "OpenPyXL spreadsheet",
    tier: "fast_local",
    strengths: ["text", "markdown", "layout", "tables"],
    risks: ["requires_external_dependency"],
    recommendedForContentTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel.sheet.macroEnabled.12"
    ],
    escalationTargets: [],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel.sheet.macroEnabled.12"
      ]
    }
  },
  {
    parserId: "pdf_text-local-layout-parser",
    label: "PDF text layer",
    tier: "layout_local",
    strengths: ["text", "layout", "page_level"],
    risks: ["ocr_required_for_scans", "table_structure_may_be_flattened"],
    recommendedForContentTypes: ["application/pdf"],
    escalationTargets: ["docling-local-layout-parser", "paddleocr-local-layout-parser"],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: false,
      emitsVisualAssets: false,
      supportedContentTypes: ["application/pdf"]
    }
  },
  {
    parserId: "docling-local-layout-parser",
    label: "Docling layout",
    tier: "layout_local",
    strengths: ["text", "layout", "tables", "figures", "page_level", "visual_assets"],
    risks: ["requires_external_dependency", "ocr_required_for_scans"],
    recommendedForContentTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/*"
    ],
    escalationTargets: ["paddleocr-local-layout-parser", "mineru-local-layout-parser"],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: true,
      supportedContentTypes: [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "image/*"
      ]
    }
  },
  {
    parserId: "paddleocr-local-layout-parser",
    label: "PaddleOCR visual OCR",
    tier: "visual_local",
    strengths: ["text", "layout", "ocr", "page_level", "visual_assets"],
    risks: ["requires_external_dependency", "table_structure_may_be_flattened"],
    recommendedForContentTypes: ["application/pdf", "image/*"],
    escalationTargets: ["mineru-local-layout-parser"],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: false,
      emitsVisualAssets: true,
      supportedContentTypes: ["application/pdf", "image/*"]
    }
  },
  {
    parserId: "mineru-local-layout-parser",
    label: "MinerU visual document parser",
    tier: "visual_local",
    strengths: ["text", "layout", "tables", "figures", "ocr", "page_level", "visual_assets"],
    risks: ["requires_external_dependency"],
    recommendedForContentTypes: ["application/pdf", "image/*"],
    escalationTargets: [],
    capabilities: {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: true,
      supportedContentTypes: ["application/pdf", "image/*"]
    }
  }
] as const satisfies readonly ParserCapabilityMatrixEntry[];

export function parserCapabilityEntryFor(
  parserId: string,
  matrix: readonly ParserCapabilityMatrixEntry[] = DEFAULT_PARSER_CAPABILITY_MATRIX
): ParserCapabilityMatrixEntry | undefined {
  return matrix.find((entry) => entry.parserId === parserId);
}

export function parserHasCapability(
  parserId: string,
  capability: ParserCapabilityArea,
  matrix: readonly ParserCapabilityMatrixEntry[] = DEFAULT_PARSER_CAPABILITY_MATRIX
): boolean {
  return parserCapabilityEntryFor(parserId, matrix)?.strengths.includes(capability) ?? false;
}

export function parserEscalationTargetsFor(
  parserId: string,
  matrix: readonly ParserCapabilityMatrixEntry[] = DEFAULT_PARSER_CAPABILITY_MATRIX
): readonly string[] {
  return parserCapabilityEntryFor(parserId, matrix)?.escalationTargets ?? [];
}
