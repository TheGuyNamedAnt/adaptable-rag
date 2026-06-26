import type { LayoutBox } from "./layout.js";
import type { SourceSensitivity, TrustTier } from "./trust-tier.js";

export type SourceKind =
  | "repo_file"
  | "local_file"
  | "database_row"
  | "support_ticket"
  | "uploaded_file"
  | "web_page"
  | "api_response"
  | "derived_summary";

export const SOURCE_KINDS = [
  "repo_file",
  "local_file",
  "database_row",
  "support_ticket",
  "uploaded_file",
  "web_page",
  "api_response",
  "derived_summary"
] as const satisfies readonly SourceKind[];

export interface SourceProvenance {
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly title: string;
  readonly originUri?: string;
  readonly path?: string;
  readonly owner?: string;
  readonly ingestedAt: string;
  readonly capturedAt?: string;
  readonly trustTier: TrustTier;
  readonly sensitivity: SourceSensitivity;
  readonly checksum?: string;
}

export interface CitationVisualAsset {
  readonly id: string;
  readonly kind?: string;
  readonly mediaType?: string;
  readonly pageNumber?: number;
  readonly assetType?: string;
  readonly title?: string;
  readonly chartType?: string;
  readonly sheetName?: string;
  readonly anchorCell?: string;
  readonly artifactKind?: string;
}

export interface CitationPointer {
  readonly sourceId: string;
  readonly chunkId: string;
  readonly title: string;
  readonly locator?: string;
  readonly visualAssetId?: string;
  readonly visualAsset?: CitationVisualAsset;
  readonly pageNumber?: number;
  readonly boundingBoxes?: readonly LayoutBox[];
  readonly layoutRegionIds?: readonly string[];
}

export function isSourceKind(value: string): value is SourceKind {
  return SOURCE_KINDS.some((sourceKind) => sourceKind === value);
}
