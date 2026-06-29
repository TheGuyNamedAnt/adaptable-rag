import type { DocumentLayout } from "../documents/layout.js";
import type { DocumentParseRequest, DocumentParseResult } from "./parser.js";

export type ParserResultRisk =
  | "empty_body"
  | "layout_missing_for_complex_document"
  | "table_structure_missing"
  | "visual_assets_missing"
  | "ocr_likely_needed"
  | "low_page_text_coverage";

export interface ParserResultQuality {
  readonly score: number;
  readonly risks: readonly ParserResultRisk[];
  readonly bodyCharacters: number;
  readonly hasLayout: boolean;
  readonly tableCount: number;
  readonly visualAssetCount: number;
  readonly pageCount: number;
  readonly pagesWithText: number;
  readonly emptyPageCount: number;
}

export interface ParserResultQualityOptions {
  readonly requireLayoutForComplexDocuments?: boolean;
  readonly minimumPageTextCoverage?: number;
}

export function assessParserResultQuality(
  request: DocumentParseRequest,
  result: DocumentParseResult,
  options: ParserResultQualityOptions = {}
): ParserResultQuality {
  const risks: ParserResultRisk[] = [];
  const bodyCharacters = meaningfulBodyText(result.document.body).length;
  const layout = result.document.layout;
  const hasLayout = layout !== undefined;
  const tableCount = layout?.tables?.length ?? 0;
  const visualAssetCount = layout?.visualAssets?.length ?? 0;
  const pageCoverage = pageTextCoverage(layout, result.document.metadata);

  if (bodyCharacters === 0) {
    risks.push("empty_body");
  }
  if (
    options.requireLayoutForComplexDocuments !== false &&
    isLayoutRiskContentType(request.contentType) &&
    !hasLayout
  ) {
    risks.push("layout_missing_for_complex_document");
  }
  if (hasTableLikeText(request, result.document.body) && tableCount === 0) {
    risks.push("table_structure_missing");
  }
  if (hasVisualReferenceText(result.document.body) && visualAssetCount === 0) {
    risks.push("visual_assets_missing");
  }
  if (pageCoverage.pageCount > 0 && pageCoverage.pagesWithText === 0) {
    risks.push("ocr_likely_needed");
  }

  const minimumPageTextCoverage = options.minimumPageTextCoverage ?? 0.8;
  if (
    pageCoverage.pageCount > 0 &&
    pageCoverage.pagesWithText / pageCoverage.pageCount < minimumPageTextCoverage
  ) {
    risks.push("low_page_text_coverage");
  }

  return {
    score: qualityScore({
      bodyCharacters,
      hasLayout,
      tableCount,
      visualAssetCount,
      pageCount: pageCoverage.pageCount,
      risks
    }),
    risks,
    bodyCharacters,
    hasLayout,
    tableCount,
    visualAssetCount,
    pageCount: pageCoverage.pageCount,
    pagesWithText: pageCoverage.pagesWithText,
    emptyPageCount: pageCoverage.pageCount - pageCoverage.pagesWithText
  };
}

function qualityScore(input: {
  readonly bodyCharacters: number;
  readonly hasLayout: boolean;
  readonly tableCount: number;
  readonly visualAssetCount: number;
  readonly pageCount: number;
  readonly risks: readonly ParserResultRisk[];
}): number {
  let score = 100;
  for (const risk of input.risks) {
    switch (risk) {
      case "empty_body":
        score -= 50;
        break;
      case "ocr_likely_needed":
        score -= 35;
        break;
      case "layout_missing_for_complex_document":
        score -= 20;
        break;
      case "table_structure_missing":
      case "visual_assets_missing":
      case "low_page_text_coverage":
        score -= 15;
        break;
    }
  }
  if (input.hasLayout) {
    score += 5;
  }
  if (input.tableCount > 0) {
    score += 5;
  }
  if (input.visualAssetCount > 0) {
    score += 5;
  }
  if (input.pageCount > 0) {
    score += 2;
  }
  return Math.max(0, Math.min(100, score));
}

function meaningfulBodyText(body: string): string {
  return body
    .replace(/<!--\s*(?:image|figure|picture|page image|diagram|chart)?\s*-->/giu, " ")
    .replace(/<img\b[^>]*>/giu, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .trim();
}

function pageTextCoverage(
  layout: DocumentLayout | undefined,
  metadata: Readonly<Record<string, string | number | boolean>> | undefined
): { readonly pageCount: number; readonly pagesWithText: number } {
  if (layout) {
    const pageNumbers = new Set(layout.pages.map((page) => page.pageNumber));
    const pagesWithText = new Set(
      layout.regions.flatMap((region) => (region.text?.trim() ? [region.pageNumber] : []))
    );
    return { pageCount: pageNumbers.size, pagesWithText: pagesWithText.size };
  }

  const pageCount = numericMetadata(metadata, "pageCount");
  const pagesWithText = numericMetadata(metadata, "pagesWithText");
  if (pageCount === undefined || pagesWithText === undefined || pageCount <= 0) {
    return { pageCount: 0, pagesWithText: 0 };
  }
  return { pageCount, pagesWithText: Math.max(0, Math.min(pageCount, pagesWithText)) };
}

function numericMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isLayoutRiskContentType(contentType: string | undefined): boolean {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ].includes(contentType ?? "");
}

function hasTableLikeText(request: DocumentParseRequest, body: string): boolean {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (hasConsistentPipeRows(lines)) {
    return true;
  }

  if (isStructuredMarkupContentType(request.contentType)) {
    return false;
  }

  return (
    lines.filter((line) => line.split(",").length >= 3).length >= 3 ||
    /\b(cap table|capitalization table|balance sheet|income statement|row total|column total)\b/iu.test(
      body
    )
  );
}

function hasConsistentPipeRows(lines: readonly string[]): boolean {
  const pipeRows = lines.filter((line) => line.includes("|"));
  const pipeCounts = new Set(pipeRows.map((line) => line.split("|").length));
  return pipeRows.length >= 2 && pipeCounts.size <= 2;
}

function hasVisualReferenceText(body: string): boolean {
  return /\b(fig\.?|figure|chart|diagram|screenshot)\s*\d*\b|\b(see|shown|pictured|displayed)\s+(below|above|in|as)\b|\b(see|shown)\s+(the\s+)?(figure|chart|diagram|screenshot|image)\b/iu.test(
    body
  );
}

function isStructuredMarkupContentType(contentType: string | undefined): boolean {
  return [
    "application/json",
    "application/x-ndjson",
    "application/yaml",
    "application/xml",
    "text/xml"
  ].includes(contentType ?? "");
}
