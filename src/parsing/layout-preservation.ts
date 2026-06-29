import type {
  DocumentLayout,
  DocumentLayoutRegion,
  DocumentTable,
  DocumentVisualAsset
} from "../documents/layout.js";
import type { DocumentParseResult } from "./parser.js";

export interface PreservedTableAnchor {
  readonly tableId: string;
  readonly pageNumber: number;
  readonly regionId: string;
  readonly caption?: string;
  readonly summary?: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface PreservedFigureAnchor {
  readonly assetId: string;
  readonly pageNumber: number;
  readonly regionId?: string;
  readonly caption?: string;
  readonly mediaType: string;
  readonly uri?: string;
}

export interface PreservedPageAnchor {
  readonly pageNumber: number;
  readonly textRegionCount: number;
  readonly tableCount: number;
  readonly figureCount: number;
  readonly visualAssetCount: number;
}

export interface LayoutPreservationSummary {
  readonly tables: readonly PreservedTableAnchor[];
  readonly figures: readonly PreservedFigureAnchor[];
  readonly pages: readonly PreservedPageAnchor[];
}

export function summarizeLayoutPreservation(
  layout: DocumentLayout | undefined
): LayoutPreservationSummary {
  if (!layout) {
    return { tables: [], figures: [], pages: [] };
  }

  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));
  const captionByTargetRegionId = captionMap(layout);

  return {
    tables: (layout.tables ?? []).map((table) =>
      preservedTableAnchor(table, regionsById, captionByTargetRegionId)
    ),
    figures: (layout.visualAssets ?? [])
      .filter((asset) => asset.kind === "figure" || asset.kind === "page_image")
      .map((asset) => preservedFigureAnchor(asset, layout, captionByTargetRegionId)),
    pages: layout.pages.map((page) => {
      const pageRegions = layout.regions.filter((region) => region.pageNumber === page.pageNumber);
      const pageTables = (layout.tables ?? []).filter(
        (table) => table.pageNumber === page.pageNumber
      );
      const pageAssets = (layout.visualAssets ?? []).filter(
        (asset) => asset.pageNumber === page.pageNumber
      );
      return {
        pageNumber: page.pageNumber,
        textRegionCount: pageRegions.filter((region) => region.text?.trim()).length,
        tableCount: pageTables.length,
        figureCount: pageAssets.filter((asset) => asset.kind === "figure").length,
        visualAssetCount: pageAssets.length
      };
    })
  };
}

export function withLayoutPreservationMetadata(result: DocumentParseResult): DocumentParseResult {
  const summary = summarizeLayoutPreservation(result.document.layout);
  return {
    ...result,
    document: {
      ...result.document,
      metadata: {
        ...result.document.metadata,
        layoutPreservationSummaryJson: JSON.stringify(summary),
        layoutPreservedTableCount: summary.tables.length,
        layoutPreservedFigureCount: summary.figures.length,
        layoutPreservedPageCount: summary.pages.length
      }
    }
  };
}

function preservedTableAnchor(
  table: DocumentTable,
  regionsById: ReadonlyMap<string, DocumentLayoutRegion>,
  captionByTargetRegionId: ReadonlyMap<string, string>
): PreservedTableAnchor {
  const rowIndexes = new Set(table.cells.map((cell) => cell.rowIndex));
  const columnIndexes = new Set(table.cells.map((cell) => cell.columnIndex));
  const caption =
    table.captionRegionId === undefined
      ? captionByTargetRegionId.get(table.regionId)
      : regionsById.get(table.captionRegionId)?.text;
  return {
    tableId: table.id,
    pageNumber: table.pageNumber,
    regionId: table.regionId,
    ...(caption === undefined ? {} : { caption }),
    ...(table.summary === undefined ? {} : { summary: table.summary }),
    rowCount: rowIndexes.size,
    columnCount: columnIndexes.size
  };
}

function preservedFigureAnchor(
  asset: DocumentVisualAsset,
  layout: DocumentLayout,
  captionByTargetRegionId: ReadonlyMap<string, string>
): PreservedFigureAnchor {
  const region = figureRegionForAsset(asset, layout);
  const caption = region === undefined ? undefined : captionByTargetRegionId.get(region.id);
  return {
    assetId: asset.id,
    pageNumber: asset.pageNumber,
    ...(region === undefined ? {} : { regionId: region.id }),
    ...(caption === undefined ? {} : { caption }),
    mediaType: asset.mediaType,
    ...(asset.uri === undefined ? {} : { uri: asset.uri })
  };
}

function figureRegionForAsset(
  asset: DocumentVisualAsset,
  layout: DocumentLayout
): DocumentLayoutRegion | undefined {
  const page = layout.pages.find((candidate) => candidate.visualAssetId === asset.id);
  if (page) {
    const pageImageRegion = layout.regions.find(
      (region) => region.pageNumber === page.pageNumber && region.kind === "page_image"
    );
    if (pageImageRegion) {
      return pageImageRegion;
    }
  }

  const samePageFigureRegions = layout.regions.filter(
    (region) =>
      region.pageNumber === asset.pageNumber &&
      (region.kind === "figure" || region.kind === "page_image")
  );
  const metadataMatch = samePageFigureRegions.find(
    (region) => region.metadata?.["visualAssetId"] === asset.id
  );
  if (metadataMatch) {
    return metadataMatch;
  }

  if (asset.box) {
    const overlapping = samePageFigureRegions
      .filter((region) => region.box)
      .map((region) => ({
        region,
        overlap: boxOverlapRatio(asset.box!, region.box!)
      }))
      .sort((first, second) => second.overlap - first.overlap)[0];
    if (overlapping && overlapping.overlap > 0) {
      return overlapping.region;
    }
  }

  return samePageFigureRegions[0];
}

function boxOverlapRatio(
  first: NonNullable<DocumentVisualAsset["box"]>,
  second: NonNullable<DocumentLayoutRegion["box"]>
): number {
  if (first.pageNumber !== second.pageNumber || first.unit !== second.unit) {
    return 0;
  }
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const overlapArea = Math.max(0, right - left) * Math.max(0, bottom - top);
  const firstArea = first.width * first.height;
  return firstArea <= 0 ? 0 : overlapArea / firstArea;
}

function captionMap(layout: DocumentLayout): ReadonlyMap<string, string> {
  const regionsById = new Map(layout.regions.map((region) => [region.id, region]));
  const captions = new Map<string, string>();
  for (const relation of layout.relations ?? []) {
    if (relation.kind !== "caption_for") {
      continue;
    }
    const caption = regionsById.get(relation.fromRegionId);
    if (caption?.text?.trim()) {
      captions.set(relation.toRegionId, caption.text.trim());
    }
  }
  return captions;
}
