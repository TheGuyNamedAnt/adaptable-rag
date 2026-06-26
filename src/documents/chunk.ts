import type { AccessScope } from "../security/access-scope.js";
import type { LayoutBox } from "./layout.js";
import type { CitationPointer, SourceProvenance } from "./provenance.js";

export type ChunkSafetyFlag =
  | "possible_prompt_injection"
  | "secret_like_text"
  | "sensitive_personal_data"
  | "oversized_chunk";

export interface RagChunk {
  readonly id: string;
  readonly documentId: string;
  readonly namespaceId: string;
  readonly text: string;
  readonly index: number;
  readonly textHash: string;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly tokenEstimate?: number;
  readonly layoutRegionIds?: readonly string[];
  readonly boundingBoxes?: readonly LayoutBox[];
  readonly safetyFlags: readonly ChunkSafetyFlag[];
  readonly provenance: SourceProvenance;
  readonly citation: CitationPointer;
  readonly accessScope: AccessScope;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
