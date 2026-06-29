import type { DocumentLayout } from "./layout.js";

export type PageOcrAuditReason =
  | "page_has_visual_asset_without_text"
  | "page_has_page_image_region_without_text"
  | "layout_page_without_text"
  | "page_text_below_threshold";

export interface PageOcrAuditPage {
  readonly pageNumber: number;
  readonly textCharacters: number;
  readonly visualAssetCount: number;
  readonly reasons: readonly PageOcrAuditReason[];
}

export interface PageOcrAuditResult {
  readonly pageCount: number;
  readonly pagesNeedingOcr: readonly PageOcrAuditPage[];
}

export interface PageOcrAuditOptions {
  readonly minimumTextCharactersPerPage?: number;
}

export function auditPagesForOcr(
  layout: DocumentLayout | undefined,
  options: PageOcrAuditOptions = {}
): PageOcrAuditResult {
  if (!layout) {
    return { pageCount: 0, pagesNeedingOcr: [] };
  }

  const minimumTextCharactersPerPage = options.minimumTextCharactersPerPage ?? 20;
  const pagesNeedingOcr = layout.pages.flatMap((page) => {
    const regions = layout.regions.filter((region) => region.pageNumber === page.pageNumber);
    const visualAssets = (layout.visualAssets ?? []).filter(
      (asset) => asset.pageNumber === page.pageNumber
    );
    const textCharacters = regions
      .map((region) => region.text?.trim().length ?? 0)
      .reduce((sum, count) => sum + count, 0);
    const hasPageImageRegion = regions.some((region) => region.kind === "page_image");
    const reasons: PageOcrAuditReason[] = [];

    if (visualAssets.length > 0 && textCharacters === 0) {
      reasons.push("page_has_visual_asset_without_text");
    }
    if (hasPageImageRegion && textCharacters === 0) {
      reasons.push("page_has_page_image_region_without_text");
    }
    if (textCharacters === 0) {
      reasons.push("layout_page_without_text");
    }
    if (
      (visualAssets.length > 0 || hasPageImageRegion) &&
      textCharacters > 0 &&
      textCharacters < minimumTextCharactersPerPage
    ) {
      reasons.push("page_text_below_threshold");
    }

    return reasons.length === 0
      ? []
      : [
          {
            pageNumber: page.pageNumber,
            textCharacters,
            visualAssetCount: visualAssets.length,
            reasons
          }
        ];
  });

  return { pageCount: layout.pages.length, pagesNeedingOcr };
}
