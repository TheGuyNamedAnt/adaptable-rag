export type ChunkBoundaryStrategy = "paragraph" | "line" | "character_window";

export type ChunkLocatorStrategy = "character_range" | "line_range" | "paragraph_range";

export interface ChunkingPolicy {
  readonly id: string;
  readonly maxCharacters: number;
  readonly overlapCharacters: number;
  readonly minCharacters: number;
  readonly maxChunksPerDocument: number;
  readonly boundaryStrategy: ChunkBoundaryStrategy;
  readonly locatorStrategy: ChunkLocatorStrategy;
  readonly preserveWhitespace: boolean;
  readonly preserveStructuredLayoutRegions?: boolean;
  readonly includeTextHash: boolean;
  readonly detectSuspiciousText: boolean;
}

export const DEFAULT_CHUNKING_POLICY: ChunkingPolicy = {
  id: "default-safe-chunking",
  maxCharacters: 1800,
  overlapCharacters: 180,
  minCharacters: 120,
  maxChunksPerDocument: 500,
  boundaryStrategy: "paragraph",
  locatorStrategy: "character_range",
  preserveWhitespace: true,
  preserveStructuredLayoutRegions: true,
  includeTextHash: true,
  detectSuspiciousText: true
};
