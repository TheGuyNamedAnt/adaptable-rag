import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities
} from "./parser.js";

export interface PlainTextParserOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
}

export class PlainTextParser implements DocumentParser {
  readonly id: string;
  readonly description = "Local parser that accepts already-extracted text without layout.";
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  constructor(options: PlainTextParserOptions = {}) {
    this.id = options.parserId ?? "plain-text-parser";
    this.version = options.parserVersion ?? "1.0.0";
    this.capabilities = {
      inputMode: "text",
      emitsLayout: false,
      emitsTables: false,
      emitsVisualAssets: false,
      ...(options.supportedContentTypes === undefined
        ? {}
        : { supportedContentTypes: options.supportedContentTypes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    return {
      sourceId: request.sourceId,
      parserId: this.id,
      parserVersion: this.version,
      document: {
        body: request.text ?? "",
        ...(request.metadata === undefined ? {} : { metadata: request.metadata })
      },
      warnings: []
    };
  }
}
