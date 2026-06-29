export type ParserEvalDocumentKind =
  | "pdf_text"
  | "pdf_scanned"
  | "pdf_mixed"
  | "docx"
  | "pptx"
  | "spreadsheet"
  | "html"
  | "image"
  | "archive"
  | "bad_file"
  | "huge_file"
  | "encrypted_file";

export interface ParserEvalExpectation {
  readonly expectedOutcome?: "parsed" | "failed";
  readonly minimumBodyCharacters?: number;
  readonly requiresLayout?: boolean;
  readonly minimumTableCount?: number;
  readonly minimumFigureCount?: number;
  readonly minimumVisualAssetCount?: number;
  readonly requiresOcr?: boolean;
  readonly expectedWarningCodes?: readonly string[];
  readonly forbiddenWarningCodes?: readonly string[];
}

export interface ParserEvalCorpusCase {
  readonly id: string;
  readonly kind: ParserEvalDocumentKind;
  readonly title: string;
  readonly fixturePath?: string;
  readonly contentType: string;
  readonly expectation: ParserEvalExpectation;
  readonly tags: readonly string[];
}

export const DEFAULT_PARSER_EVAL_CORPUS_CASES = [
  {
    id: "pdf_text_clean",
    kind: "pdf_text",
    title: "Clean selectable-text PDF",
    contentType: "application/pdf",
    expectation: { expectedOutcome: "parsed", minimumBodyCharacters: 500, requiresLayout: true },
    tags: ["pdf", "text-layer", "baseline"]
  },
  {
    id: "pdf_scanned_ocr",
    kind: "pdf_scanned",
    title: "Scanned PDF requiring OCR",
    contentType: "application/pdf",
    expectation: {
      expectedOutcome: "parsed",
      minimumBodyCharacters: 300,
      requiresLayout: true,
      requiresOcr: true,
      minimumVisualAssetCount: 1
    },
    tags: ["pdf", "scan", "ocr"]
  },
  {
    id: "pdf_mixed_page_ocr",
    kind: "pdf_mixed",
    title: "Mixed selectable and scanned PDF",
    contentType: "application/pdf",
    expectation: {
      expectedOutcome: "parsed",
      minimumBodyCharacters: 500,
      requiresLayout: true,
      requiresOcr: true,
      minimumVisualAssetCount: 1
    },
    tags: ["pdf", "mixed", "page-ocr"]
  },
  {
    id: "docx_tables_figures",
    kind: "docx",
    title: "DOCX with tables and figures",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    expectation: {
      expectedOutcome: "parsed",
      minimumBodyCharacters: 500,
      requiresLayout: true,
      minimumTableCount: 1,
      minimumFigureCount: 1
    },
    tags: ["docx", "tables", "figures"]
  },
  {
    id: "pptx_speaker_notes_diagrams",
    kind: "pptx",
    title: "PPTX with notes and diagrams",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    expectation: {
      expectedOutcome: "parsed",
      minimumBodyCharacters: 300,
      requiresLayout: true,
      minimumFigureCount: 1
    },
    tags: ["pptx", "notes", "figures"]
  },
  {
    id: "spreadsheet_formulas_charts",
    kind: "spreadsheet",
    title: "Spreadsheet with formulas, tables, and charts",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    expectation: {
      expectedOutcome: "parsed",
      minimumBodyCharacters: 300,
      requiresLayout: true,
      minimumTableCount: 1,
      minimumVisualAssetCount: 1
    },
    tags: ["xlsx", "tables", "charts"]
  },
  {
    id: "bad_file_rejected",
    kind: "bad_file",
    title: "Corrupt or unsupported file",
    contentType: "application/octet-stream",
    expectation: {
      expectedOutcome: "failed",
      minimumBodyCharacters: 0,
      expectedWarningCodes: ["parser_router_attempt_rejected", "parser_router_attempt_failed"]
    },
    tags: ["negative", "corrupt"]
  },
  {
    id: "encrypted_pdf_rejected",
    kind: "encrypted_file",
    title: "Encrypted PDF",
    contentType: "application/pdf",
    expectation: {
      expectedOutcome: "failed",
      minimumBodyCharacters: 0,
      expectedWarningCodes: ["parser_router_attempt_rejected", "parser_router_attempt_failed"]
    },
    tags: ["negative", "pdf", "encrypted"]
  }
] as const satisfies readonly ParserEvalCorpusCase[];

export function parserEvalCasesByKind(
  kind: ParserEvalDocumentKind,
  cases: readonly ParserEvalCorpusCase[] = DEFAULT_PARSER_EVAL_CORPUS_CASES
): readonly ParserEvalCorpusCase[] {
  return cases.filter((testCase) => testCase.kind === kind);
}
