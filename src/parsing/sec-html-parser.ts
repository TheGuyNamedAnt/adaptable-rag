import type {
  DocumentLayout,
  DocumentLayoutRegion,
  DocumentTable,
  DocumentTableCell
} from "../documents/layout.js";
import { validateDocumentLayout } from "../documents/layout.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning
} from "./parser.js";

export interface SecHtmlParserOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
  readonly maxTableRegionCharacters?: number;
  readonly maxRowsPerTableRegion?: number;
}

interface ParsedHtmlTable {
  readonly rows: readonly ParsedHtmlTableRow[];
}

interface ParsedHtmlTableRow {
  readonly cells: readonly ParsedHtmlTableCell[];
}

interface ParsedHtmlTableCell {
  readonly text: string;
  readonly rowSpan?: number;
  readonly columnSpan?: number;
}

interface BodyAppendResult {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const DEFAULT_MAX_TABLE_REGION_CHARACTERS = 1_500;
const DEFAULT_MAX_ROWS_PER_TABLE_REGION = 30;
const MIN_PROTECTED_TABLE_TEXT_CHARACTERS = 40;

export class SecHtmlParser implements DocumentParser {
  readonly id: string;
  readonly description =
    "Local deterministic parser for SEC filing HTML that strips markup and preserves table row groups.";
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly maxTableRegionCharacters: number;
  private readonly maxRowsPerTableRegion: number;

  constructor(options: SecHtmlParserOptions = {}) {
    this.id = options.parserId ?? "sec-html-parser";
    this.version = options.parserVersion ?? "1.0.0";
    this.maxTableRegionCharacters =
      options.maxTableRegionCharacters ?? DEFAULT_MAX_TABLE_REGION_CHARACTERS;
    this.maxRowsPerTableRegion = options.maxRowsPerTableRegion ?? DEFAULT_MAX_ROWS_PER_TABLE_REGION;
    this.capabilities = {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: false,
      supportedContentTypes: options.supportedContentTypes ?? [
        "text/html",
        "application/xhtml+xml"
      ],
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    const sourceHtml = request.text ?? decodeBytes(request.bytes);
    const warnings: DocumentParserWarning[] = [];
    const html = stripNonVisibleHtml(extractSecTextPayload(sourceHtml, warnings));
    const builder = new ParsedBodyBuilder();
    const regions: DocumentLayoutRegion[] = [];
    const tables: DocumentTable[] = [];
    let paragraphIndex = 0;
    let tableIndex = 0;

    for (const segment of splitHtmlByTables(html)) {
      if (segment.kind === "text") {
        for (const block of textBlocksFromHtml(segment.html)) {
          const appended = builder.appendBlock(block);
          if (!appended) {
            continue;
          }
          regions.push({
            id: `paragraph_${++paragraphIndex}`,
            kind: paragraphKind(block),
            pageNumber: 1,
            text: appended.text,
            characterStart: appended.start,
            characterEnd: appended.end
          });
        }
        continue;
      }

      tableIndex += 1;
      appendTable({
        builder,
        html: segment.html,
        tableIndex,
        regions,
        tables,
        maxRowsPerTableRegion: this.maxRowsPerTableRegion,
        maxTableRegionCharacters: this.maxTableRegionCharacters
      });
    }

    const body = builder.body.trimEnd();
    const layout = buildLayout({
      parserId: this.id,
      parserVersion: this.version,
      body,
      regions: trimRegionEnds(regions, body.length),
      tables
    });
    const validation = validateDocumentLayout(layout, body);

    if (!validation.valid) {
      return {
        sourceId: request.sourceId,
        parserId: this.id,
        parserVersion: this.version,
        document: {
          body,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata })
        },
        warnings: [
          ...warnings,
          {
            code: "sec_html_layout_invalid",
            message: `SEC HTML layout failed validation with ${validation.errors.length} error(s).`
          }
        ]
      };
    }

    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body,
        layout,
        metadata: {
          ...(request.metadata ?? {}),
          parserKind: "sec_html",
          parserNormalizedBodyCharacters: body.length,
          parserLayoutRegionCount: layout.regions.length,
          parserTableRegionCount: layout.tables?.length ?? 0
        }
      },
      warnings
    };
  }
}

function appendTable(input: {
  readonly builder: ParsedBodyBuilder;
  readonly html: string;
  readonly tableIndex: number;
  readonly regions: DocumentLayoutRegion[];
  readonly tables: DocumentTable[];
  readonly maxRowsPerTableRegion: number;
  readonly maxTableRegionCharacters: number;
}): void {
  const table = parseHtmlTable(input.html);
  const fullTableText = tableTextForRows(table.rows);
  if (!isProtectedTable(table, fullTableText)) {
    const appended = input.builder.appendBlock(fullTableText);
    if (!appended) {
      return;
    }
    input.regions.push({
      id: `table_${input.tableIndex}_text`,
      kind: "paragraph",
      pageNumber: 1,
      text: appended.text,
      characterStart: appended.start,
      characterEnd: appended.end,
      metadata: {
        originalTableIndex: input.tableIndex,
        sourceElement: "table"
      }
    });
    return;
  }

  const batches = batchTableRows(table.rows, {
    maxRowsPerTableRegion: input.maxRowsPerTableRegion,
    maxTableRegionCharacters: input.maxTableRegionCharacters
  });

  for (const [batchIndex, rows] of batches.entries()) {
    const tableText = rows.map((row) => row.cells.map((cell) => cell.text).join(" | ")).join("\n");
    const appended = input.builder.appendBlock(tableText);
    if (!appended) {
      continue;
    }

    const regionId = `table_${input.tableIndex}_region_${batchIndex + 1}`;
    const tableId = `table_${input.tableIndex}_${batchIndex + 1}`;
    input.regions.push({
      id: regionId,
      kind: "table",
      pageNumber: 1,
      text: appended.text,
      characterStart: appended.start,
      characterEnd: appended.end,
      metadata: {
        originalTableIndex: input.tableIndex,
        tableBatchIndex: batchIndex + 1
      }
    });
    input.tables.push({
      id: tableId,
      pageNumber: 1,
      regionId,
      cells: tableCellsForRows(rows),
      summary: tableText.slice(0, 240),
      metadata: {
        originalTableIndex: input.tableIndex,
        tableBatchIndex: batchIndex + 1,
        rowCount: rows.length,
        columnCount: rows.reduce((max, row) => Math.max(max, row.cells.length), 0)
      }
    });
  }
}

function tableTextForRows(rows: readonly ParsedHtmlTableRow[]): string {
  return rows.map((row) => row.cells.map((cell) => cell.text).join(" | ")).join("\n");
}

function isProtectedTable(table: ParsedHtmlTable, tableText: string): boolean {
  const columnCount = table.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const cellCount = table.rows.reduce((count, row) => count + row.cells.length, 0);
  return (
    columnCount >= 2 &&
    cellCount >= 4 &&
    tableText.trim().length >= MIN_PROTECTED_TABLE_TEXT_CHARACTERS
  );
}

function tableCellsForRows(rows: readonly ParsedHtmlTableRow[]): readonly DocumentTableCell[] {
  return rows.flatMap((row, rowIndex) =>
    row.cells.map(
      (cell, columnIndex): DocumentTableCell => ({
        rowIndex,
        columnIndex,
        text: cell.text,
        ...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan }),
        ...(cell.columnSpan === undefined ? {} : { columnSpan: cell.columnSpan })
      })
    )
  );
}

function batchTableRows(
  rows: readonly ParsedHtmlTableRow[],
  options: {
    readonly maxRowsPerTableRegion: number;
    readonly maxTableRegionCharacters: number;
  }
): readonly ParsedHtmlTableRow[][] {
  const batches: ParsedHtmlTableRow[][] = [];
  let batch: ParsedHtmlTableRow[] = [];
  let batchCharacters = 0;

  for (const row of rows) {
    const rowCharacters = row.cells.map((cell) => cell.text).join(" | ").length;
    const shouldFlush =
      batch.length > 0 &&
      (batch.length >= options.maxRowsPerTableRegion ||
        batchCharacters + rowCharacters + 1 > options.maxTableRegionCharacters);

    if (shouldFlush) {
      batches.push(batch);
      batch = [];
      batchCharacters = 0;
    }

    batch.push(row);
    batchCharacters += rowCharacters + 1;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

function parseHtmlTable(html: string): ParsedHtmlTable {
  const rows = matches(html, /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu).flatMap((rowMatch) => {
    const cells = matches(rowMatch.body, /<(td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/giu)
      .map((cellMatch) => {
        const text = normalizeInlineText(cellMatch.groups[2] ?? "");
        if (!text) {
          return undefined;
        }
        return {
          text,
          ...spanMetadata(cellMatch.groups[1] ?? "")
        };
      })
      .filter((cell): cell is ParsedHtmlTableCell => cell !== undefined);

    return cells.length === 0 ? [] : [{ cells }];
  });

  return { rows };
}

function spanMetadata(attributes: string): Pick<ParsedHtmlTableCell, "rowSpan" | "columnSpan"> {
  const rowSpan = positiveIntegerAttribute(attributes, "rowspan");
  const columnSpan = positiveIntegerAttribute(attributes, "colspan");
  return {
    ...(rowSpan === undefined ? {} : { rowSpan }),
    ...(columnSpan === undefined ? {} : { columnSpan })
  };
}

function positiveIntegerAttribute(attributes: string, name: string): number | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "iu").exec(attributes);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 1 ? value : undefined;
}

function splitHtmlByTables(
  html: string
): readonly (
  | { readonly kind: "text"; readonly html: string }
  | { readonly kind: "table"; readonly html: string }
)[] {
  const segments: (
    | { readonly kind: "text"; readonly html: string }
    | { readonly kind: "table"; readonly html: string }
  )[] = [];
  const tablePattern = /<table\b[\s\S]*?<\/table>/giu;
  let cursor = 0;
  let match;

  while ((match = tablePattern.exec(html)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "text", html: html.slice(cursor, match.index) });
    }
    segments.push({ kind: "table", html: match[0] });
    cursor = match.index + match[0].length;
  }

  if (cursor < html.length) {
    segments.push({ kind: "text", html: html.slice(cursor) });
  }

  return segments;
}

function stripNonVisibleHtml(html: string): string {
  return html
    .replace(
      /<div\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>/giu,
      " "
    )
    .replace(/<ix:header\b[\s\S]*?<\/ix:header>/giu, " ")
    .replace(/<ix:hidden\b[\s\S]*?<\/ix:hidden>/giu, " ");
}

function textBlocksFromHtml(html: string): readonly string[] {
  const text = normalizeBlockText(html);
  return text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);
}

function normalizeBlockText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<\/?(?:p|div|section|article|header|footer|br|li|tr|h[1-6])\b[^>]*>/giu, "\n")
      .replace(/<\/?(?:td|th)\b[^>]*>/giu, " | ")
      .replace(/<[^>]+>/gu, " ")
  )
    .split(/\n/u)
    .map((line) => line.replace(/[ \t\f\v]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizeInlineText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<br\b[^>]*\/?>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
  )
    .replace(/\s+/gu, " ")
    .trim();
}

function extractSecTextPayload(sourceHtml: string, warnings: DocumentParserWarning[]): string {
  const match = /<TEXT\b[^>]*>([\s\S]*?)<\/TEXT>/iu.exec(sourceHtml);
  if (!match?.[1]) {
    if (!/<html\b/i.test(sourceHtml)) {
      warnings.push({
        code: "sec_text_wrapper_missing",
        message: "SEC <TEXT> wrapper was not found; parsed the full HTML input."
      });
    }
    return sourceHtml;
  }
  return match[1];
}

function buildLayout(input: {
  readonly parserId: string;
  readonly parserVersion: string;
  readonly body: string;
  readonly regions: readonly DocumentLayoutRegion[];
  readonly tables: readonly DocumentTable[];
}): DocumentLayout {
  return {
    parserId: input.parserId,
    parserVersion: input.parserVersion,
    strategy: input.tables.length > 0 ? "table_structure" : "text_extraction",
    pages: [{ pageNumber: 1, width: 1, height: 1, unit: "normalized" }],
    regions: input.regions,
    tables: input.tables,
    visualAssets: [],
    metadata: {
      sourceFormat: "sec_html"
    }
  };
}

function trimRegionEnds(
  regions: readonly DocumentLayoutRegion[],
  bodyLength: number
): readonly DocumentLayoutRegion[] {
  return regions.flatMap((region) => {
    if (region.characterStart === undefined || region.characterEnd === undefined) {
      return [region];
    }
    const end = Math.min(region.characterEnd, bodyLength);
    if (end <= region.characterStart) {
      return [];
    }
    if (end === region.characterEnd) {
      return [region];
    }
    const text = region.text?.slice(0, end - region.characterStart);
    return [
      {
        ...region,
        characterEnd: end,
        ...(text === undefined ? {} : { text })
      }
    ];
  });
}

function paragraphKind(block: string): "heading" | "paragraph" {
  return block.length <= 120 && !/[.!?]$/u.test(block) ? "heading" : "paragraph";
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu, (_full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return safeCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return safeCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    switch (lower) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      case "ndash":
        return "-";
      case "mdash":
        return "-";
      case "rsquo":
        return "'";
      case "lsquo":
        return "'";
      case "rdquo":
        return '"';
      case "ldquo":
        return '"';
      default:
        return namedLatinEntity(entity) ?? " ";
    }
  });
}

function namedLatinEntity(entity: string): string | undefined {
  const lower = entity.toLowerCase();
  const decoded = NAMED_LATIN_HTML_ENTITIES[lower];
  if (decoded === undefined) {
    return undefined;
  }
  return entity[0] === entity[0]?.toUpperCase() ? decoded.toUpperCase() : decoded;
}

function safeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return " ";
  }
  return String.fromCodePoint(value);
}

function decodeBytes(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const NAMED_LATIN_HTML_ENTITIES: Readonly<Record<string, string>> = {
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ"
};

function matches(
  input: string,
  pattern: RegExp
): readonly { readonly body: string; readonly groups: readonly string[] }[] {
  const results: { readonly body: string; readonly groups: readonly string[] }[] = [];
  let match;
  while ((match = pattern.exec(input)) !== null) {
    results.push({
      body: match[1] ?? "",
      groups: match.slice(1)
    });
  }
  return results;
}

class ParsedBodyBuilder {
  body = "";

  appendBlock(text: string): BodyAppendResult | undefined {
    const normalized = text.trim();
    if (!normalized) {
      return undefined;
    }

    if (this.body.length > 0) {
      this.body += "\n\n";
    }
    const start = this.body.length;
    this.body += normalized;
    return {
      start,
      end: this.body.length,
      text: normalized
    };
  }
}
