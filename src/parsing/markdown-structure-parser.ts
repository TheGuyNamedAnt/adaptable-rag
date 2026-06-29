import type {
  DocumentLayout,
  DocumentLayoutRegion,
  DocumentTable,
  DocumentTableCell
} from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning
} from "./parser.js";

export interface MarkdownStructureParserOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
}

interface MarkdownTableBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly rows: readonly (readonly string[])[];
}

export class MarkdownStructureParser implements DocumentParser {
  readonly id: string;
  readonly description =
    "Local deterministic parser for Markdown text with heading and pipe-table structure.";
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  constructor(options: MarkdownStructureParserOptions = {}) {
    this.id = options.parserId ?? "markdown-structure-parser";
    this.version = options.parserVersion ?? "1.0.0";
    this.capabilities = {
      inputMode: "text",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: options.supportedContentTypes ?? ["text/markdown"],
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    const body = request.text ?? "";
    const tableBlocks = parseMarkdownPipeTables(body);
    const layout = layoutForMarkdown(this.id, this.version, body, tableBlocks);
    const warnings: DocumentParserWarning[] =
      body.trim().length === 0
        ? [{ code: "empty_markdown", message: "Markdown body was empty." }]
        : [];

    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body,
        layout,
        metadata: {
          ...(request.metadata ?? {}),
          parserKind: "markdown_structure",
          markdownTableCount: tableBlocks.length
        }
      },
      warnings
    };
  }
}

export function parseMarkdownPipeTables(markdown: string): readonly MarkdownTableBlock[] {
  const lines = markdown.split(/\r?\n/u);
  const tables: MarkdownTableBlock[] = [];
  let index = 0;

  while (index < lines.length - 1) {
    const header = parsePipeRow(lines[index] ?? "");
    const separator = parsePipeRow(lines[index + 1] ?? "");
    if (!header || !separator || !isSeparatorRow(separator) || header.length < 2) {
      index += 1;
      continue;
    }

    const rows: string[][] = [[...header]];
    let endLine = index + 1;
    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const row = parsePipeRow(lines[rowIndex] ?? "");
      if (!row || row.length < 2) {
        break;
      }
      rows.push([...normalizeCellCount(row, header.length)]);
      endLine = rowIndex;
      rowIndex += 1;
    }

    if (rows.length > 1) {
      tables.push({ startLine: index, endLine, rows });
      index = rowIndex;
    } else {
      index += 1;
    }
  }

  return tables;
}

function parsePipeRow(line: string): readonly string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return undefined;
  }

  const withoutOuterPipes = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = splitUnescapedPipes(withoutOuterPipes).map((cell) => cell.trim());
  return cells.length >= 2 ? cells : undefined;
}

function splitUnescapedPipes(line: string): readonly string[] {
  const cells: string[] = [];
  let cell = "";
  let escaping = false;

  for (const char of line) {
    if (escaping) {
      cell += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }

  cells.push(cell);
  return cells;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, "")));
}

function normalizeCellCount(cells: readonly string[], expectedCount: number): readonly string[] {
  if (cells.length === expectedCount) {
    return cells;
  }
  if (cells.length > expectedCount) {
    return cells.slice(0, expectedCount);
  }
  return [...cells, ...Array.from({ length: expectedCount - cells.length }, () => "")];
}

function layoutForMarkdown(
  parserId: string,
  parserVersion: string,
  body: string,
  tableBlocks: readonly MarkdownTableBlock[]
): DocumentLayout {
  const lines = body.split(/\r?\n/u);
  const tableLineIndexes = new Set<number>();
  for (const block of tableBlocks) {
    for (let lineIndex = block.startLine; lineIndex <= block.endLine; lineIndex += 1) {
      tableLineIndexes.add(lineIndex);
    }
  }

  const regions: DocumentLayoutRegion[] = [];
  const tables: DocumentTable[] = [];

  for (const [tableIndex, block] of tableBlocks.entries()) {
    const regionId = `table_region_${tableIndex + 1}`;
    const tableText = lines.slice(block.startLine, block.endLine + 1).join("\n");
    regions.push({
      id: regionId,
      kind: "table",
      pageNumber: 1,
      text: tableText,
      metadata: {
        startLine: block.startLine + 1,
        endLine: block.endLine + 1
      }
    });
    tables.push({
      id: `table_${tableIndex + 1}`,
      pageNumber: 1,
      regionId,
      cells: cellsForTable(block.rows),
      metadata: {
        source: "markdown_pipe_table",
        headerRowCount: 1,
        rowCount: block.rows.length,
        columnCount: block.rows[0]?.length ?? 0
      }
    });
  }

  const textRegions = markdownTextRegions(lines, tableLineIndexes);
  regions.push(...textRegions);

  return {
    parserId,
    parserVersion,
    strategy: tables.length > 0 ? "table_structure" : "text_extraction",
    pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
    regions,
    tables,
    visualAssets: []
  };
}

function cellsForTable(rows: readonly (readonly string[])[]): readonly DocumentTableCell[] {
  const cells: DocumentTableCell[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      cells.push({ rowIndex, columnIndex, text });
    }
  }
  return cells;
}

function markdownTextRegions(
  lines: readonly string[],
  tableLineIndexes: ReadonlySet<number>
): readonly DocumentLayoutRegion[] {
  const regions: DocumentLayoutRegion[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const text = line.trim();
    if (!text || tableLineIndexes.has(lineIndex)) {
      continue;
    }
    regions.push({
      id: `text_region_${regions.length + 1}`,
      kind: text.startsWith("#") ? "heading" : "paragraph",
      pageNumber: 1,
      text,
      metadata: { line: lineIndex + 1 }
    });
  }
  return regions;
}
