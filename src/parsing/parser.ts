import type { DocumentLayout } from "../documents/layout.js";
import type { SourceKind } from "../documents/provenance.js";

export type ParserInputMode = "text" | "binary" | "text_or_binary";

export interface DocumentParserCapabilities {
  readonly inputMode: ParserInputMode;
  readonly emitsLayout: boolean;
  readonly emitsTables: boolean;
  readonly emitsVisualAssets: boolean;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
}

export interface DocumentParseRequest {
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly title: string;
  readonly contentType?: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly originUri?: string;
  readonly path?: string;
  readonly requestedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ParsedDocument {
  readonly body: string;
  readonly layout?: DocumentLayout;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DocumentParserWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface DocumentParseResult {
  readonly sourceId: string;
  readonly parserId: string;
  readonly parserVersion?: string;
  readonly document: ParsedDocument;
  readonly warnings: readonly DocumentParserWarning[];
}

export interface DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version?: string;
  readonly capabilities: DocumentParserCapabilities;
  parse(request: DocumentParseRequest): Promise<DocumentParseResult>;
}
