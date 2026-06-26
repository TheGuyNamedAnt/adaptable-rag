import type { DocumentLayout, DocumentTableCell } from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities
} from "./parser.js";

export interface DelimitedTableParserOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly delimiter?: "," | "\t";
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
}

export class DelimitedTableParser implements DocumentParser {
  readonly id: string;
  readonly description = "Local deterministic parser for CSV/TSV-style structured tables.";
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly delimiter: "," | "\t" | undefined;

  constructor(options: DelimitedTableParserOptions = {}) {
    this.id = options.parserId ?? "delimited-table-parser";
    this.version = options.parserVersion ?? "1.0.0";
    this.delimiter = options.delimiter;
    this.capabilities = {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: options.supportedContentTypes ?? [
        "text/csv",
        "text/tab-separated-values",
        "text/plain"
      ],
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    const sourceText = request.text ?? decodeBytes(request.bytes);
    const delimiter = this.delimiter ?? inferDelimiter(request, sourceText);
    const rows = parseDelimitedRows(sourceText, delimiter);
    const body = rows.map((row) => row.join(" | ")).join("\n");
    const layout = layoutForRows(this.id, this.version, rows, body);

    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body,
        layout,
        metadata: {
          ...(request.metadata ?? {}),
          parserKind: "structured_table",
          delimiter: delimiter === "\t" ? "tab" : "comma",
          rowCount: rows.length,
          columnCount: rows.reduce((max, row) => Math.max(max, row.length), 0)
        }
      },
      warnings:
        rows.length === 0 ? [{ code: "empty_table", message: "No table rows were parsed." }] : []
    };
  }
}

export function parseDelimitedRows(text: string, delimiter: "," | "\t"): readonly string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }
  return rows;
}

function inferDelimiter(request: DocumentParseRequest, text: string): "," | "\t" {
  if (request.contentType === "text/tab-separated-values" || request.title.endsWith(".tsv")) {
    return "\t";
  }
  return text.includes("\t") && !text.includes(",") ? "\t" : ",";
}

function decodeBytes(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function layoutForRows(
  parserId: string,
  parserVersion: string,
  rows: readonly string[][],
  body: string
): DocumentLayout {
  const cells: DocumentTableCell[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      cells.push({ rowIndex, columnIndex, text });
    }
  }

  return {
    parserId,
    parserVersion,
    strategy: "table_structure",
    pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
    regions: [
      {
        id: "table_region_1",
        kind: "table",
        pageNumber: 1,
        text: body,
        characterStart: 0,
        characterEnd: body.length
      }
    ],
    tables: [{ id: "table_1", pageNumber: 1, regionId: "table_region_1", cells }],
    visualAssets: []
  };
}
