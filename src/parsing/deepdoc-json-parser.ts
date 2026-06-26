import type { DocumentLayout } from "../documents/layout.js";
import { validateDocumentLayout } from "../documents/layout.js";
import type {
  ProviderAdapterSecrets,
  ProviderBoundaryConfig,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import {
  defaultProviderRequestHeaders,
  mapProviderStatus,
  mapTransportError,
  redactText,
  validateProviderConfig
} from "../shared/provider-boundary.js";
import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning,
  ParsedDocument
} from "./parser.js";

export interface DeepDocJsonParserOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly supportedContentTypes?: readonly string[];
  readonly maxBytes?: number;
}

interface DeepDocParsedPayload {
  readonly body: string;
  readonly layout: DocumentLayout;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly warnings: readonly DocumentParserWarning[];
}

export class DeepDocJsonParser implements DocumentParser {
  readonly id: string;
  readonly description =
    "Provider-backed DeepDoc-style parser for text, layout, tables, and visual assets.";
  readonly version: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly options: DeepDocJsonParserOptions;

  constructor(options: DeepDocJsonParserOptions) {
    validateProviderConfig(options.config);
    this.options = options;
    this.id = options.parserId ?? options.config.id;
    this.version = options.parserVersion ?? "1.0.0";
    this.capabilities = {
      inputMode: "text_or_binary",
      emitsLayout: true,
      emitsTables: true,
      emitsVisualAssets: true,
      ...(options.supportedContentTypes === undefined
        ? {}
        : { supportedContentTypes: options.supportedContentTypes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    const apiKey = await this.options.secrets.apiKeyProvider();
    if (!apiKey.trim()) {
      return failedParseResult(this, request, {
        code: "provider_auth_missing",
        message: "Provider API key is missing."
      });
    }

    try {
      const providerRequest: ProviderHttpRequest = {
        requestId: `parse_${request.sourceId}_${request.requestedAt.replace(/[^0-9a-z]/gi, "")}`,
        url: this.options.config.endpoint,
        method: "POST",
        headers: defaultProviderRequestHeaders({
          apiKey,
          requestId: `parse_${request.sourceId}`
        }),
        body: buildDeepDocJsonParserRequestBody(request, this.options.config.modelName),
        timeoutMs: this.options.config.timeoutMs
      };
      const response = await this.options.transport.send(providerRequest);
      const mapped = mapProviderStatus(response);
      if (mapped) {
        return failedParseResult(this, request, {
          code: `provider_${mapped.code}`,
          message: redactText(mapped.message, [apiKey, this.options.secrets.secretId ?? ""])
        });
      }

      const payload = parseDeepDocJsonParserResponse(response);
      const layoutValidation = validateDocumentLayout(payload.layout, payload.body);
      if (!layoutValidation.valid) {
        return failedParseResult(this, request, {
          code: "provider_layout_invalid",
          message: `Provider layout failed validation with ${layoutValidation.errors.length} error(s).`
        });
      }

      return {
        sourceId: request.sourceId,
        parserId: this.id,
        ...(this.version === undefined ? {} : { parserVersion: this.version }),
        document: {
          body: payload.body,
          layout: payload.layout,
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata })
        },
        warnings: payload.warnings
      };
    } catch (error) {
      const mapped = mapTransportError(error);
      return failedParseResult(this, request, {
        code: `provider_${mapped.code}`,
        message: redactText(mapped.message, [apiKey, this.options.secrets.secretId ?? ""])
      });
    }
  }
}

export function buildDeepDocJsonParserRequestBody(
  request: DocumentParseRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    sourceId: request.sourceId,
    sourceKind: request.sourceKind,
    title: request.title,
    contentType: request.contentType,
    originUri: request.originUri,
    path: request.path,
    text: request.text,
    bytesBase64:
      request.bytes === undefined ? undefined : Buffer.from(request.bytes).toString("base64"),
    contract: {
      output:
        "Return strict JSON with body, layout.pages, layout.regions, optional layout.relations, optional layout.tables, optional layout.visualAssets, optional metadata, and optional warnings.",
      layoutRegionKinds:
        "title, heading, paragraph, list, table, table_caption, figure, figure_caption, equation, page_image",
      layoutRelationKinds: "caption_for, explains, continues_as, references, same_section",
      requirement:
        "Every layout region with text must use characterStart/characterEnd offsets into returned body."
    }
  };
}

export function parseDeepDocJsonParserResponse(
  response: ProviderHttpResponse
): DeepDocParsedPayload {
  const record = extractJsonRecord(response.body);
  const body = typeof record["body"] === "string" ? record["body"] : undefined;
  const layout = record["layout"];
  if (body === undefined || !isRecord(layout)) {
    throw new Error("DeepDoc provider response must include body and layout object.");
  }
  const metadata = readMetadata(record["metadata"]);

  return {
    body,
    layout: layout as unknown as DocumentLayout,
    ...(metadata === undefined ? {} : { metadata }),
    warnings: readWarnings(record["warnings"])
  };
}

function failedParseResult(
  parser: DeepDocJsonParser,
  request: DocumentParseRequest,
  warning: DocumentParserWarning
): DocumentParseResult {
  const document: ParsedDocument = {
    body: request.text ?? "",
    ...(request.metadata === undefined ? {} : { metadata: request.metadata })
  };

  return {
    sourceId: request.sourceId,
    parserId: parser.id,
    ...(parser.version === undefined ? {} : { parserVersion: parser.version }),
    document,
    warnings: [warning]
  };
}

function extractJsonRecord(body: unknown): Record<string, unknown> {
  if (isRecord(body) && typeof body["body"] === "string" && isRecord(body["layout"])) {
    return body;
  }

  const text = extractText(body);
  const parsed: unknown = JSON.parse(text.trim());
  if (!isRecord(parsed)) {
    throw new Error("DeepDoc provider response text must parse to an object.");
  }
  return parsed;
}

function extractText(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Provider response body must be an object.");
  }
  if (typeof body["output_text"] === "string") {
    return body["output_text"];
  }
  const choices = body["choices"];
  if (Array.isArray(choices) && isRecord(choices[0])) {
    const message = choices[0]["message"];
    if (isRecord(message) && typeof message["content"] === "string") {
      return message["content"];
    }
  }
  throw new Error("Provider response did not include parser JSON text.");
}

function readMetadata(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean] =>
      ["string", "number", "boolean"].includes(typeof entry[1])
    )
  );
}

function readWarnings(value: unknown): readonly DocumentParserWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item["code"] !== "string" ||
      typeof item["message"] !== "string"
    ) {
      return [];
    }
    return [
      {
        code: item["code"],
        message: item["message"],
        ...(typeof item["path"] === "string" ? { path: item["path"] } : {})
      }
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
