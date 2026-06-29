import type { DocumentParseRequest, DocumentParseResult, DocumentParser } from "./parser.js";
import { assessParserResultQuality, type ParserResultQuality } from "./parser-result-quality.js";

export interface ParserComparisonAttempt {
  readonly parserId: string;
  readonly status: "fulfilled" | "failed";
  readonly result?: DocumentParseResult;
  readonly quality?: ParserResultQuality;
  readonly errorMessage?: string;
}

export interface ParserComparisonResult {
  readonly selected: DocumentParseResult;
  readonly selectedQuality: ParserResultQuality;
  readonly attempts: readonly ParserComparisonAttempt[];
}

export interface ParserComparisonOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly description?: string;
}

export interface CompareParserResultsOptions {
  readonly precomputedAttempts?: readonly ParserComparisonAttempt[];
}

export class ParserComparisonMode implements DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version?: string;
  readonly capabilities: DocumentParser["capabilities"];

  private readonly parsers: readonly DocumentParser[];

  constructor(parsers: readonly DocumentParser[], options: ParserComparisonOptions = {}) {
    if (parsers.length === 0) {
      throw new Error("ParserComparisonMode requires at least one parser.");
    }
    this.parsers = parsers;
    this.id = options.parserId ?? "parser-comparison-mode";
    this.description =
      options.description ?? "Runs multiple parsers and selects the highest-quality parse result.";
    if (options.parserVersion !== undefined) {
      this.version = options.parserVersion;
    }
    this.capabilities = {
      inputMode: combinedInputMode(parsers),
      emitsLayout: parsers.some((parser) => parser.capabilities.emitsLayout),
      emitsTables: parsers.some((parser) => parser.capabilities.emitsTables),
      emitsVisualAssets: parsers.some((parser) => parser.capabilities.emitsVisualAssets),
      ...combinedSupportedContentTypes(parsers)
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    try {
      const comparison = await compareParserResults(request, this.parsers);
      return withWrapperParserId(comparison.selected, this.id, this.version);
    } catch (error) {
      return failedComparisonResult(request, this.id, this.version, error);
    }
  }
}

export async function compareParserResults(
  request: DocumentParseRequest,
  parsers: readonly DocumentParser[],
  options: CompareParserResultsOptions = {}
): Promise<ParserComparisonResult> {
  const eligibleParsers = parsers.filter((parser) => parserCanParseRequest(parser, request));
  const attempts = [
    ...(options.precomputedAttempts ?? []),
    ...(await Promise.all(eligibleParsers.map((parser) => runParser(request, parser))))
  ];
  const fulfilled = attempts.filter(
    (
      attempt
    ): attempt is ParserComparisonAttempt & {
      readonly result: DocumentParseResult;
      readonly quality: ParserResultQuality;
    } =>
      attempt.status === "fulfilled" &&
      attempt.result !== undefined &&
      attempt.quality !== undefined
  );
  if (fulfilled.length === 0) {
    throw new Error(
      `All parser comparison attempts failed: ${attempts
        .map((attempt) => `${attempt.parserId}: ${attempt.errorMessage ?? attempt.status}`)
        .join("; ")}`
    );
  }

  const selected = [...fulfilled].sort(compareAttempts)[0]!;
  return {
    selected: withComparisonMetadata(selected.result, selected.quality, attempts),
    selectedQuality: selected.quality,
    attempts
  };
}

async function runParser(
  request: DocumentParseRequest,
  parser: DocumentParser
): Promise<ParserComparisonAttempt> {
  try {
    const result = await parser.parse(request);
    return {
      parserId: parser.id,
      status: "fulfilled",
      result,
      quality: assessParserResultQuality(request, result)
    };
  } catch (error) {
    return {
      parserId: parser.id,
      status: "failed",
      errorMessage: errorName(error)
    };
  }
}

function compareAttempts(
  first: ParserComparisonAttempt & { readonly quality: ParserResultQuality },
  second: ParserComparisonAttempt & { readonly quality: ParserResultQuality }
): number {
  return (
    second.quality.score - first.quality.score ||
    second.quality.tableCount - first.quality.tableCount ||
    second.quality.visualAssetCount - first.quality.visualAssetCount ||
    second.quality.bodyCharacters - first.quality.bodyCharacters
  );
}

function withComparisonMetadata(
  result: DocumentParseResult,
  quality: ParserResultQuality,
  attempts: readonly ParserComparisonAttempt[]
): DocumentParseResult {
  return {
    ...result,
    document: {
      ...result.document,
      metadata: {
        ...result.document.metadata,
        parserComparisonSelectedParserId: result.parserId,
        parserComparisonSelectedScore: quality.score,
        parserComparisonAttemptCount: attempts.length,
        parserComparisonTraceJson: JSON.stringify(
          attempts.map((attempt) => ({
            parserId: attempt.parserId,
            status: attempt.status,
            score: attempt.quality?.score,
            risks: attempt.quality?.risks,
            errorName: attempt.errorMessage === undefined ? undefined : "Error"
          }))
        )
      }
    }
  };
}

function withWrapperParserId(
  result: DocumentParseResult,
  parserId: string,
  parserVersion: string | undefined
): DocumentParseResult {
  return {
    ...result,
    parserId,
    ...(parserVersion === undefined ? {} : { parserVersion })
  };
}

function failedComparisonResult(
  request: DocumentParseRequest,
  parserId: string,
  parserVersion: string | undefined,
  error: unknown
): DocumentParseResult {
  const warning = {
    code: "parser_comparison_failed",
    message: `Parser comparison failed with ${errorName(error)}.`
  };
  return {
    sourceId: request.sourceId,
    parserId,
    ...(parserVersion === undefined ? {} : { parserVersion }),
    document: {
      body: request.text ?? "",
      metadata: {
        ...(request.metadata ?? {}),
        parserFailed: true,
        parserFailureCode: warning.code,
        parserFailureMessage: warning.message
      }
    },
    warnings: [warning]
  };
}

function parserCanParseRequest(parser: DocumentParser, request: DocumentParseRequest): boolean {
  if (parser.capabilities.inputMode === "text" && request.text === undefined) {
    return false;
  }
  if (parser.capabilities.inputMode === "binary" && request.bytes === undefined) {
    return false;
  }
  if (
    parser.capabilities.inputMode === "text_or_binary" &&
    request.text === undefined &&
    request.bytes === undefined
  ) {
    return false;
  }
  const supported = parser.capabilities.supportedContentTypes;
  if (!supported || supported.length === 0 || request.contentType === undefined) {
    return parserWithinByteLimit(parser, request);
  }
  return (
    supported.some((contentType) =>
      contentType.endsWith("/*")
        ? request.contentType?.startsWith(contentType.slice(0, contentType.length - 1))
        : contentType === request.contentType
    ) && parserWithinByteLimit(parser, request)
  );
}

function parserWithinByteLimit(parser: DocumentParser, request: DocumentParseRequest): boolean {
  return (
    request.bytes === undefined ||
    parser.capabilities.maxBytes === undefined ||
    request.bytes.byteLength <= parser.capabilities.maxBytes
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function combinedInputMode(
  parsers: readonly DocumentParser[]
): DocumentParser["capabilities"]["inputMode"] {
  const modes = new Set(parsers.map((parser) => parser.capabilities.inputMode));
  if (modes.has("text_or_binary") || (modes.has("text") && modes.has("binary"))) {
    return "text_or_binary";
  }
  return parsers[0]?.capabilities.inputMode ?? "text_or_binary";
}

function combinedSupportedContentTypes(
  parsers: readonly DocumentParser[]
): Pick<DocumentParser["capabilities"], "supportedContentTypes"> {
  if (parsers.some((parser) => !parser.capabilities.supportedContentTypes?.length)) {
    return {};
  }
  return {
    supportedContentTypes: [
      ...new Set(parsers.flatMap((parser) => parser.capabilities.supportedContentTypes ?? []))
    ]
  };
}
