import type { RagChunk } from "../documents/chunk.js";
import type { RagDocument } from "../documents/document.js";
import type {
  DocumentLayout,
  DocumentLayoutRegion,
  DocumentTable,
  DocumentTableCell,
  DocumentVisualAsset,
  LayoutBox
} from "../documents/layout.js";
import { auditPagesForOcr, type PageOcrAuditPage } from "../documents/page-ocr-audit.js";
import { DEFAULT_CHUNKING_POLICY } from "../chunking/chunk-policy.js";
import { hashText } from "../chunking/hash.js";

const MAX_DERIVED_CHUNK_CHARACTERS = DEFAULT_CHUNKING_POLICY.maxCharacters;

interface SourceRange {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly regionIds: readonly string[];
}

export const SEARCHABLE_UNIT_TYPES = [
  "body_chunk",
  "heading_chunk",
  "table_chunk",
  "table_row_chunk",
  "table_caption_chunk",
  "equation_chunk",
  "figure_caption_chunk",
  "visual_asset_chunk",
  "page_summary_chunk",
  "layout_relation_chunk",
  "parser_gap_chunk"
] as const;

export type SearchableUnitType = (typeof SEARCHABLE_UNIT_TYPES)[number];

export interface SearchableArtifactWarning {
  readonly documentId: string;
  readonly code:
    | "table_not_source_backed"
    | "table_row_not_source_backed"
    | "equation_not_source_backed"
    | "parser_gap_not_source_backed"
    | "caption_not_source_backed"
    | "visual_asset_missing_text_fallback"
    | "layout_relation_not_source_backed";
  readonly message: string;
}

export interface SearchableArtifactBuildResult {
  readonly chunks: readonly RagChunk[];
  readonly warnings: readonly SearchableArtifactWarning[];
}

export interface SearchableArtifactBuildRequest {
  readonly document: RagDocument;
  readonly bodyChunks: readonly RagChunk[];
}

export function buildSearchableArtifacts(
  request: SearchableArtifactBuildRequest
): SearchableArtifactBuildResult {
  const layout = request.document.layout;
  if (!layout) {
    return { chunks: [], warnings: [] };
  }

  const chunks: RagChunk[] = [];
  const warnings: SearchableArtifactWarning[] = [];
  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));
  const nextIndex = () => request.bodyChunks.length + chunks.length;

  for (const page of layout.pages) {
    const pageChunk = pageSummaryChunk({
      document: request.document,
      layout,
      pageNumber: page.pageNumber,
      index: nextIndex()
    });
    if (pageChunk) {
      chunks.push(pageChunk);
    }
  }

  for (const page of auditPagesForOcr(layout).pagesNeedingOcr) {
    const gapChunk = parserGapChunk({
      document: request.document,
      layout,
      page,
      index: nextIndex()
    });
    if (gapChunk) {
      chunks.push(gapChunk);
    } else {
      warnings.push({
        documentId: request.document.id,
        code: "parser_gap_not_source_backed",
        message: `Page ${page.pageNumber} likely needs OCR, but no source-backed page text range was available for a parser-gap chunk.`
      });
    }
  }

  for (const heading of layout.regions.filter(isHeadingRegion).filter(isSourceBackedRegion)) {
    chunks.push(
      makeDerivedChunk({
        document: request.document,
        layout,
        index: nextIndex(),
        unitType: "heading_chunk",
        characterStart: heading.characterStart,
        characterEnd: heading.characterEnd,
        layoutRegionIds: [heading.id],
        metadata: {
          searchableEmbeddingText: compactLines([
            "Heading",
            `Text: ${request.document.body.slice(heading.characterStart, heading.characterEnd)}`,
            `Page: ${heading.pageNumber}`,
            `Parser: ${layout.parserId}`
          ])
        }
      })
    );
  }

  for (const table of layout.tables ?? []) {
    const tableChunk = tableContextChunk({
      document: request.document,
      layout,
      table,
      regionsById,
      index: nextIndex()
    });
    if (tableChunk) {
      chunks.push(tableChunk);
    } else {
      warnings.push({
        documentId: request.document.id,
        code: "table_not_source_backed",
        message: `Table "${table.id}" could not be materialized because it does not map to source text ranges.`
      });
    }

    for (const rowIndex of tableRowIndexes(table)) {
      const rowCells = table.cells.filter((cell) => cell.rowIndex === rowIndex);
      if (isSeparatorTableRow(rowCells)) {
        continue;
      }
      const sourceRange = sourceRangeForTableRow({
        body: request.document.body,
        table,
        rowCells,
        regionsById
      });
      if (!sourceRange) {
        warnings.push({
          documentId: request.document.id,
          code: "table_row_not_source_backed",
          message: `Table "${table.id}" row ${rowIndex} could not be materialized because its cells do not map to source text ranges.`
        });
        continue;
      }

      chunks.push(
        makeDerivedChunk({
          document: request.document,
          layout,
          index: nextIndex(),
          unitType: "table_row_chunk",
          characterStart: sourceRange.characterStart,
          characterEnd: sourceRange.characterEnd,
          layoutRegionIds: sourceRange.regionIds,
          metadata: {
            tableId: table.id,
            tableRowIndex: rowIndex,
            searchableEmbeddingText: tableRowEmbeddingText(table, rowCells, regionsById, layout)
          }
        })
      );
    }

    const captionChunk = captionChunkForTable({
      document: request.document,
      layout,
      table,
      regionsById,
      index: nextIndex()
    });
    if (captionChunk) {
      chunks.push(captionChunk);
    }
  }

  for (const equation of layout.regions.filter(isEquationRegion)) {
    if (!isSourceBackedRegion(equation)) {
      warnings.push({
        documentId: request.document.id,
        code: "equation_not_source_backed",
        message: `Equation region "${equation.id}" could not be materialized because it does not map to source text ranges.`
      });
      continue;
    }

    chunks.push(
      makeDerivedChunk({
        document: request.document,
        layout,
        index: nextIndex(),
        unitType: "equation_chunk",
        characterStart: equation.characterStart,
        characterEnd: equation.characterEnd,
        layoutRegionIds: [equation.id],
        metadata: {
          searchableEmbeddingText: compactLines([
            "Equation",
            `Text: ${request.document.body.slice(equation.characterStart, equation.characterEnd)}`,
            `Page: ${equation.pageNumber}`,
            `Parser: ${layout.parserId}`
          ])
        }
      })
    );
  }

  for (const visualAsset of layout.visualAssets ?? []) {
    const visualChunk = visualAssetChunk({
      document: request.document,
      layout,
      visualAsset,
      regionsById,
      index: nextIndex()
    });
    if (visualChunk) {
      chunks.push(visualChunk);
    }

    const fallback = visualFallbackChunk({
      document: request.document,
      layout,
      visualAsset,
      regionsById,
      index: nextIndex()
    });
    if (fallback) {
      chunks.push(fallback);
    } else {
      warnings.push({
        documentId: request.document.id,
        code: "visual_asset_missing_text_fallback",
        message: `Visual asset "${visualAsset.id}" has no source-backed caption or descriptive region fallback.`
      });
    }
  }

  for (const relation of layout.relations ?? []) {
    const relationChunk = layoutRelationChunk({
      document: request.document,
      layout,
      relation,
      regionsById,
      index: nextIndex()
    });
    if (relationChunk) {
      chunks.push(relationChunk);
    } else {
      warnings.push({
        documentId: request.document.id,
        code: "layout_relation_not_source_backed",
        message: `Layout relation "${relation.id}" could not be materialized because one or both regions do not map to source text ranges.`
      });
    }
  }

  return { chunks: uniqueChunks(chunks), warnings };
}

function pageSummaryChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly pageNumber: number;
  readonly index: number;
}): RagChunk | undefined {
  const pageRegions = input.layout.regions.filter(
    (region) => region.pageNumber === input.pageNumber
  );
  const sourceRange = sourceRangeForRegions(pageRegions);
  if (!sourceRange) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "page_summary_chunk",
    characterStart: sourceRange.characterStart,
    characterEnd: sourceRange.characterEnd,
    layoutRegionIds: sourceRange.regionIds,
    metadata: {
      pageNumber: input.pageNumber,
      searchableEmbeddingText: compactLines([
        "Page summary",
        `Page: ${input.pageNumber}`,
        `Text: ${input.document.body.slice(sourceRange.characterStart, sourceRange.characterEnd)}`,
        `Parser: ${input.layout.parserId}`
      ])
    }
  });
}

function parserGapChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly page: PageOcrAuditPage;
  readonly index: number;
}): RagChunk | undefined {
  const pageRegions = input.layout.regions.filter(
    (region) => region.pageNumber === input.page.pageNumber
  );
  const sourceRange = sourceRangeForRegions(pageRegions);
  if (!sourceRange) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "parser_gap_chunk",
    characterStart: sourceRange.characterStart,
    characterEnd: sourceRange.characterEnd,
    layoutRegionIds: sourceRange.regionIds,
    metadata: {
      pageNumber: input.page.pageNumber,
      parserGapReasons: input.page.reasons.join(","),
      parserGapTextCharacters: input.page.textCharacters,
      parserGapVisualAssetCount: input.page.visualAssetCount,
      answerEvidence: false,
      searchableEmbeddingText: compactLines([
        "Parser gap",
        `Page: ${input.page.pageNumber}`,
        `Reasons: ${input.page.reasons.join(", ")}`,
        `Text characters: ${input.page.textCharacters}`,
        `Visual assets: ${input.page.visualAssetCount}`,
        `Text: ${input.document.body.slice(sourceRange.characterStart, sourceRange.characterEnd)}`,
        `Parser: ${input.layout.parserId}`
      ])
    }
  });
}

function tableContextChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly table: DocumentTable;
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
  readonly index: number;
}): RagChunk | undefined {
  const sourceRange = sourceRangeForTable({
    body: input.document.body,
    table: input.table,
    regionsById: input.regionsById
  });
  if (!sourceRange) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "table_chunk",
    characterStart: sourceRange.characterStart,
    characterEnd: sourceRange.characterEnd,
    layoutRegionIds: uniqueStrings([input.table.regionId, ...sourceRange.regionIds]),
    metadata: {
      tableId: input.table.id,
      searchableEmbeddingText: tableEmbeddingText(input.table, input.regionsById, input.layout)
    }
  });
}

function captionChunkForTable(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly table: DocumentTable;
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
  readonly index: number;
}): RagChunk | undefined {
  if (!input.table.captionRegionId) {
    return undefined;
  }
  const caption = input.regionsById.get(input.table.captionRegionId);
  if (!isSourceBackedRegion(caption)) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "table_caption_chunk",
    characterStart: caption.characterStart,
    characterEnd: caption.characterEnd,
    layoutRegionIds: [caption.id, input.table.regionId],
    metadata: {
      tableId: input.table.id,
      searchableEmbeddingText: compactLines([
        "Table caption",
        `Table: ${input.table.id}`,
        `Caption: ${input.document.body.slice(caption.characterStart, caption.characterEnd)}`,
        `Page: ${input.table.pageNumber}`
      ])
    }
  });
}

function visualAssetChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly visualAsset: DocumentVisualAsset;
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
  readonly index: number;
}): RagChunk | undefined {
  const caption = captionRegionForVisualAsset(input.layout, input.visualAsset, input.regionsById);
  if (!isSourceBackedRegion(caption)) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "visual_asset_chunk",
    characterStart: caption.characterStart,
    characterEnd: caption.characterEnd,
    layoutRegionIds: visualAssetRegionIds(input.layout, input.visualAsset, caption.id),
    metadata: {
      visualAssetId: input.visualAsset.id,
      visualAssetKind: input.visualAsset.kind,
      searchableEmbeddingText: compactLines([
        "Visual asset",
        `Kind: ${input.visualAsset.kind}`,
        `Caption: ${input.document.body.slice(caption.characterStart, caption.characterEnd)}`,
        `Page: ${input.visualAsset.pageNumber}`,
        `Visual asset: ${input.visualAsset.id}`,
        `Parser: ${input.layout.parserId}`
      ])
    }
  });
}

function visualFallbackChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly visualAsset: DocumentVisualAsset;
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
  readonly index: number;
}): RagChunk | undefined {
  const caption = captionRegionForVisualAsset(input.layout, input.visualAsset, input.regionsById);
  if (isSourceBackedRegion(caption)) {
    return makeDerivedChunk({
      document: input.document,
      layout: input.layout,
      index: input.index,
      unitType: visualCaptionUnitType(caption),
      characterStart: caption.characterStart,
      characterEnd: caption.characterEnd,
      layoutRegionIds: [caption.id],
      metadata: {
        visualAssetId: input.visualAsset.id,
        searchableEmbeddingText: compactLines([
          "Visual asset",
          `Kind: ${input.visualAsset.kind}`,
          `Caption: ${input.document.body.slice(caption.characterStart, caption.characterEnd)}`,
          `Page: ${input.visualAsset.pageNumber}`,
          `Visual asset: ${input.visualAsset.id}`
        ])
      }
    });
  }

  const pageRange = sourceRangeForRegions(
    input.layout.regions.filter(
      (region) =>
        region.pageNumber === input.visualAsset.pageNumber &&
        region.kind !== "page_image" &&
        region.kind !== "figure"
    )
  );
  if (!pageRange) {
    return undefined;
  }
  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "visual_asset_chunk",
    characterStart: pageRange.characterStart,
    characterEnd: pageRange.characterEnd,
    layoutRegionIds: visualAssetRegionIdsFromRange(input.layout, input.visualAsset, pageRange),
    metadata: {
      visualAssetId: input.visualAsset.id,
      visualAssetKind: input.visualAsset.kind,
      searchableEmbeddingText: compactLines([
        "Visual asset",
        `Kind: ${input.visualAsset.kind}`,
        `Page text: ${input.document.body.slice(pageRange.characterStart, pageRange.characterEnd)}`,
        `Page: ${input.visualAsset.pageNumber}`,
        `Visual asset: ${input.visualAsset.id}`,
        `Parser: ${input.layout.parserId}`
      ])
    }
  });
}

function layoutRelationChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly relation: NonNullable<DocumentLayout["relations"]>[number];
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
  readonly index: number;
}): RagChunk | undefined {
  const from = input.regionsById.get(input.relation.fromRegionId);
  const to = input.regionsById.get(input.relation.toRegionId);
  const sourceRange = sourceRangeForRegions([from, to]);
  if (!sourceRange) {
    return undefined;
  }

  return makeDerivedChunk({
    document: input.document,
    layout: input.layout,
    index: input.index,
    unitType: "layout_relation_chunk",
    characterStart: sourceRange.characterStart,
    characterEnd: sourceRange.characterEnd,
    layoutRegionIds: sourceRange.regionIds,
    metadata: {
      layoutRelationId: input.relation.id,
      layoutRelationKind: input.relation.kind,
      fromRegionId: input.relation.fromRegionId,
      toRegionId: input.relation.toRegionId,
      searchableEmbeddingText: compactLines([
        "Layout relation",
        `Kind: ${input.relation.kind}`,
        from?.text ? `From: ${from.text}` : undefined,
        to?.text ? `To: ${to.text}` : undefined,
        `Parser: ${input.layout.parserId}`
      ])
    }
  });
}

function makeDerivedChunk(input: {
  readonly document: RagDocument;
  readonly layout: DocumentLayout;
  readonly index: number;
  readonly unitType: SearchableUnitType;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly layoutRegionIds: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | undefined>>;
}): RagChunk {
  const sourceText = input.document.body.slice(input.characterStart, input.characterEnd);
  const text =
    sourceText.length > MAX_DERIVED_CHUNK_CHARACTERS
      ? sourceText.slice(0, MAX_DERIVED_CHUNK_CHARACTERS)
      : sourceText;
  const characterEnd = input.characterStart + text.length;
  const truncated = characterEnd < input.characterEnd;
  const textHash = hashText(text);
  const id = [input.document.id, input.unitType, input.index, textHash.slice(0, 12)].join(":");
  const layoutRegionIds = uniqueStrings(input.layoutRegionIds);
  const boundingBoxes = boxesForRegions(input.layout, layoutRegionIds);
  const pageNumber = pageNumberForRegions(input.layout, layoutRegionIds);
  const metadata = derivedChunkMetadata(input.metadata, {
    truncated,
    originalCharacterEnd: input.characterEnd
  });

  return {
    id,
    documentId: input.document.id,
    namespaceId: input.document.namespaceId,
    text,
    index: input.index,
    textHash,
    characterStart: input.characterStart,
    characterEnd,
    safetyFlags: truncated ? ["oversized_chunk"] : [],
    ...(layoutRegionIds.length > 0 ? { layoutRegionIds } : {}),
    ...(boundingBoxes.length > 0 ? { boundingBoxes } : {}),
    provenance: input.document.provenance,
    citation: {
      sourceId: input.document.provenance.sourceId,
      chunkId: id,
      title: input.document.title,
      locator: `chars:${input.characterStart}-${characterEnd}`,
      ...(pageNumber === undefined ? {} : { pageNumber }),
      ...(layoutRegionIds.length > 0 ? { layoutRegionIds } : {}),
      ...(boundingBoxes.length > 0 ? { boundingBoxes } : {})
    },
    accessScope: input.document.accessScope,
    metadata: stripUndefinedMetadata({
      ...(input.document.metadata ?? {}),
      searchableUnitType: input.unitType,
      derivedFrom: "parser_layout",
      sourceDocumentId: input.document.id,
      sourceParserId: input.layout.parserId,
      parserVersion: input.layout.parserVersion,
      derivedChunkerVersion: "1",
      ...metadata
    })
  };
}

function derivedChunkMetadata(
  metadata: Readonly<Record<string, string | number | boolean | undefined>>,
  options: {
    readonly truncated: boolean;
    readonly originalCharacterEnd: number;
  }
): Readonly<Record<string, string | number | boolean | undefined>> {
  const searchableEmbeddingText = metadata.searchableEmbeddingText;
  const cappedSearchableEmbeddingText =
    typeof searchableEmbeddingText === "string" &&
    searchableEmbeddingText.length > MAX_DERIVED_CHUNK_CHARACTERS
      ? searchableEmbeddingText.slice(0, MAX_DERIVED_CHUNK_CHARACTERS)
      : searchableEmbeddingText;
  return {
    ...metadata,
    ...(cappedSearchableEmbeddingText === searchableEmbeddingText
      ? {}
      : {
          searchableEmbeddingText: cappedSearchableEmbeddingText,
          derivedEmbeddingTextTruncated: true
        }),
    ...(options.truncated
      ? {
          derivedChunkTruncated: true,
          derivedOriginalCharacterEnd: options.originalCharacterEnd
        }
      : {})
  };
}

function tableRowIndexes(table: DocumentTable): readonly number[] {
  return [...new Set(table.cells.map((cell) => cell.rowIndex))].sort(
    (first, second) => first - second
  );
}

function sourceRangeForCells(
  cells: readonly DocumentTableCell[],
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>
): SourceRange | undefined {
  const regions = cells
    .map((cell) => (cell.regionId ? regionsById.get(cell.regionId) : undefined))
    .filter(isSourceBackedRegion);
  if (regions.length === 0) {
    return undefined;
  }

  return {
    characterStart: Math.min(...regions.map((region) => region.characterStart)),
    characterEnd: Math.max(...regions.map((region) => region.characterEnd)),
    regionIds: regions.map((region) => region.id)
  };
}

function sourceRangeForTable(input: {
  readonly body: string;
  readonly table: DocumentTable;
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
}): SourceRange | undefined {
  const tableRegion = input.regionsById.get(input.table.regionId);
  if (isSourceBackedRegion(tableRegion)) {
    return {
      characterStart: tableRegion.characterStart,
      characterEnd: tableRegion.characterEnd,
      regionIds: [tableRegion.id]
    };
  }

  const cellRange = sourceRangeForCells(input.table.cells, input.regionsById);
  if (cellRange) {
    return cellRange;
  }

  if (tableRegion?.text) {
    const textRange = sourceRangeForText(input.body, tableRegion.text, [tableRegion.id]);
    if (textRange) {
      return textRange;
    }
  }

  return sourceRangeForCellSequence(input.body, input.table.cells, [input.table.regionId]);
}

function sourceRangeForTableRow(input: {
  readonly body: string;
  readonly table: DocumentTable;
  readonly rowCells: readonly DocumentTableCell[];
  readonly regionsById: ReadonlyMap<string, DocumentLayoutRegion>;
}): SourceRange | undefined {
  const cellRange = sourceRangeForCells(input.rowCells, input.regionsById);
  if (cellRange) {
    return cellRange;
  }

  const orderedCells = orderedMaterialCells(input.rowCells);
  const rowText = orderedCells.map((cell) => cell.text?.trim()).join(" | ");
  const exactRange = sourceRangeForText(input.body, rowText, [input.table.regionId]);
  if (exactRange) {
    return exactRange;
  }

  return sourceRangeForCellSequence(input.body, orderedCells, [input.table.regionId]);
}

function sourceRangeForText(
  body: string,
  text: string,
  regionIds: readonly string[]
): SourceRange | undefined {
  if (!text.trim()) {
    return undefined;
  }

  const start = body.indexOf(text);
  if (start === -1) {
    return undefined;
  }

  return {
    characterStart: start,
    characterEnd: start + text.length,
    regionIds
  };
}

function sourceRangeForCellSequence(
  body: string,
  cells: readonly DocumentTableCell[],
  regionIds: readonly string[]
): SourceRange | undefined {
  const orderedCells = orderedMaterialCells(cells);
  if (orderedCells.length === 0) {
    return undefined;
  }

  let cursor = 0;
  let characterStart: number | undefined;
  let characterEnd: number | undefined;
  for (const cell of orderedCells) {
    const text = cell.text?.trim();
    if (!text) {
      continue;
    }
    const match = findCellText(body, text, cursor);
    const index = match?.index ?? -1;
    if (index === -1) {
      return undefined;
    }
    characterStart ??= index;
    characterEnd = index + (match?.text.length ?? text.length);
    cursor = characterEnd;
  }

  if (characterStart === undefined || characterEnd === undefined) {
    return undefined;
  }

  return {
    characterStart,
    characterEnd,
    regionIds
  };
}

function orderedMaterialCells(cells: readonly DocumentTableCell[]): readonly DocumentTableCell[] {
  return [...cells]
    .sort(
      (first, second) => first.rowIndex - second.rowIndex || first.columnIndex - second.columnIndex
    )
    .filter((cell) => cell.text !== undefined && cell.text.trim().length > 0);
}

function findCellText(
  body: string,
  text: string,
  cursor: number
): { readonly index: number; readonly text: string } | undefined {
  const directIndex = body.indexOf(text, cursor);
  if (directIndex !== -1) {
    return { index: directIndex, text };
  }

  if (text.includes("|")) {
    const escaped = text.replace(/\|/gu, "\\|");
    const escapedIndex = body.indexOf(escaped, cursor);
    if (escapedIndex !== -1) {
      return { index: escapedIndex, text: escaped };
    }
  }

  return undefined;
}

function isSeparatorTableRow(cells: readonly DocumentTableCell[]): boolean {
  const materialCells = orderedMaterialCells(cells);
  return (
    materialCells.length > 0 &&
    materialCells.every((cell) => /^:?-{3,}:?$/u.test(cell.text?.trim() ?? ""))
  );
}

function tableRowEmbeddingText(
  table: DocumentTable,
  rowCells: readonly DocumentTableCell[],
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  layout: DocumentLayout
): string {
  const caption = table.captionRegionId ? regionsById.get(table.captionRegionId)?.text : undefined;
  const columns = tableColumnLabels(table);
  const row = [...rowCells]
    .sort((first, second) => first.columnIndex - second.columnIndex)
    .map((cell) => cell.text ?? (cell.regionId ? regionsById.get(cell.regionId)?.text : undefined))
    .filter((text): text is string => text !== undefined && text.trim().length > 0)
    .join(", ");

  return compactLines([
    "Table row",
    `Table: ${table.id}`,
    caption ? `Caption: ${caption}` : undefined,
    columns.length > 0 ? `Columns: ${columns.join(", ")}` : undefined,
    `Row: ${row}`,
    `Page: ${table.pageNumber}`,
    `Parser: ${layout.parserId}`
  ]);
}

function tableEmbeddingText(
  table: DocumentTable,
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  layout: DocumentLayout
): string {
  const caption = table.captionRegionId ? regionsById.get(table.captionRegionId)?.text : undefined;
  const columns = tableColumnLabels(table);
  const rows = tableRowIndexes(table)
    .map((rowIndex) =>
      table.cells
        .filter((cell) => cell.rowIndex === rowIndex)
        .sort((first, second) => first.columnIndex - second.columnIndex)
        .map(
          (cell) => cell.text ?? (cell.regionId ? regionsById.get(cell.regionId)?.text : undefined)
        )
        .filter((text): text is string => text !== undefined && text.trim().length > 0)
        .join(", ")
    )
    .filter((row) => row.trim().length > 0)
    .slice(0, 12);

  return compactLines([
    "Table",
    `Table: ${table.id}`,
    caption ? `Caption: ${caption}` : undefined,
    columns.length > 0 ? `Columns: ${columns.join(", ")}` : undefined,
    rows.length > 0 ? `Rows: ${rows.join(" | ")}` : undefined,
    `Page: ${table.pageNumber}`,
    table.summary ? `Summary: ${table.summary}` : undefined,
    `Parser: ${layout.parserId}`
  ]);
}

function tableColumnLabels(table: DocumentTable): readonly string[] {
  const firstRow = Math.min(...table.cells.map((cell) => cell.rowIndex));
  if (!Number.isFinite(firstRow)) {
    return [];
  }
  return table.cells
    .filter((cell) => cell.rowIndex === firstRow)
    .sort((first, second) => first.columnIndex - second.columnIndex)
    .map((cell) => cell.text)
    .filter((text): text is string => text !== undefined && text.trim().length > 0);
}

function isEquationRegion(region: DocumentLayoutRegion): boolean {
  return region.kind === "equation";
}

function captionRegionForVisualAsset(
  layout: DocumentLayout,
  visualAsset: DocumentVisualAsset,
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>
): DocumentLayoutRegion | undefined {
  const relatedCaptionId = layout.relations?.find(
    (relation) =>
      relation.kind === "caption_for" &&
      isVisualTargetRegion(visualAsset, regionsById.get(relation.toRegionId)) &&
      regionsById.get(relation.toRegionId)?.pageNumber === visualAsset.pageNumber
  )?.fromRegionId;
  if (relatedCaptionId) {
    return regionsById.get(relatedCaptionId);
  }

  return layout.regions.find(
    (region) =>
      fallbackCaptionKindsForVisualAsset(visualAsset).includes(region.kind) &&
      region.pageNumber === visualAsset.pageNumber
  );
}

function visualAssetRegionIds(
  layout: DocumentLayout,
  visualAsset: DocumentVisualAsset,
  captionRegionId: string
): readonly string[] {
  const target = layout.regions.find(
    (region) =>
      region.pageNumber === visualAsset.pageNumber && isVisualTargetRegion(visualAsset, region)
  );
  return uniqueStrings([captionRegionId, ...(target?.id === undefined ? [] : [target.id])]);
}

function visualAssetRegionIdsFromRange(
  layout: DocumentLayout,
  visualAsset: DocumentVisualAsset,
  sourceRange: SourceRange
): readonly string[] {
  const target = layout.regions.find(
    (region) =>
      region.pageNumber === visualAsset.pageNumber && isVisualTargetRegion(visualAsset, region)
  );
  return uniqueStrings([
    ...sourceRange.regionIds,
    ...(target?.id === undefined ? [] : [target.id])
  ]);
}

function visualCaptionUnitType(region: DocumentLayoutRegion): SearchableUnitType {
  return region.kind === "table_caption" ? "table_caption_chunk" : "figure_caption_chunk";
}

function isVisualTargetRegion(
  visualAsset: DocumentVisualAsset,
  region: DocumentLayoutRegion | undefined
): boolean {
  if (!region) {
    return false;
  }

  switch (visualAsset.kind) {
    case "figure":
      return region.kind === "figure";
    case "table_crop":
      return region.kind === "table";
    case "page_image":
    case "patch_grid":
      return region.kind === "page_image" || region.kind === "figure";
  }
}

function fallbackCaptionKindsForVisualAsset(
  visualAsset: DocumentVisualAsset
): readonly DocumentLayoutRegion["kind"][] {
  switch (visualAsset.kind) {
    case "table_crop":
      return ["table_caption"];
    case "figure":
    case "page_image":
    case "patch_grid":
      return ["figure_caption"];
  }
}

function isHeadingRegion(region: DocumentLayoutRegion): boolean {
  return region.kind === "title" || region.kind === "heading";
}

function isSourceBackedRegion(
  region: DocumentLayoutRegion | undefined
): region is DocumentLayoutRegion & {
  readonly characterStart: number;
  readonly characterEnd: number;
} {
  return (
    region !== undefined &&
    typeof region.characterStart === "number" &&
    typeof region.characterEnd === "number" &&
    region.characterEnd > region.characterStart
  );
}

function sourceRangeForRegions(
  regions: readonly (DocumentLayoutRegion | undefined)[]
): SourceRange | undefined {
  const sourceBacked = regions.filter(isSourceBackedRegion);
  if (sourceBacked.length === 0) {
    return undefined;
  }

  return {
    characterStart: Math.min(...sourceBacked.map((region) => region.characterStart)),
    characterEnd: Math.max(...sourceBacked.map((region) => region.characterEnd)),
    regionIds: sourceBacked.map((region) => region.id)
  };
}

function boxesForRegions(
  layout: DocumentLayout,
  regionIds: readonly string[]
): readonly LayoutBox[] {
  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));
  return regionIds.flatMap((regionId) => {
    const box = regionsById.get(regionId)?.box;
    return box ? [box] : [];
  });
}

function pageNumberForRegions(
  layout: DocumentLayout,
  regionIds: readonly string[]
): number | undefined {
  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));
  return regionIds
    .map((regionId) => regionsById.get(regionId)?.pageNumber)
    .find((pageNumber) => pageNumber !== undefined);
}

function uniqueChunks(chunks: readonly RagChunk[]): readonly RagChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    if (seen.has(chunk.id)) {
      return false;
    }
    seen.add(chunk.id);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function compactLines(lines: readonly (string | undefined)[]): string {
  return lines
    .filter((line): line is string => line !== undefined && line.trim().length > 0)
    .join("\n");
}

function stripUndefinedMetadata(
  metadata: Readonly<Record<string, string | number | boolean | undefined>>
): Readonly<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined
    )
  );
}
