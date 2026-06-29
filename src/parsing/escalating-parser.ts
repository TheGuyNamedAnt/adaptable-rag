import type { DocumentParseRequest, DocumentParseResult, DocumentParser } from "./parser.js";
import { compareParserResults, type ParserComparisonAttempt } from "./parser-comparison.js";
import {
  assessParserResultQuality,
  type ParserResultQuality,
  type ParserResultRisk
} from "./parser-result-quality.js";

export interface ParserEscalationCandidate {
  readonly parser: DocumentParser;
  readonly addressesRisks: readonly ParserResultRisk[];
}

export interface EscalatingDocumentParserOptions {
  readonly parserId?: string;
  readonly parserVersion?: string;
  readonly description?: string;
  readonly primaryParser: DocumentParser;
  readonly escalationParsers: readonly ParserEscalationCandidate[];
  readonly minimumPrimaryScore?: number;
  readonly maxEscalationParsers?: number;
}

export class EscalatingDocumentParser implements DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version?: string;
  readonly capabilities: DocumentParser["capabilities"];

  private readonly primaryParser: DocumentParser;
  private readonly escalationParsers: readonly ParserEscalationCandidate[];
  private readonly minimumPrimaryScore: number;
  private readonly maxEscalationParsers: number;

  constructor(options: EscalatingDocumentParserOptions) {
    this.primaryParser = options.primaryParser;
    this.escalationParsers = options.escalationParsers;
    this.minimumPrimaryScore = options.minimumPrimaryScore ?? 85;
    this.maxEscalationParsers = options.maxEscalationParsers ?? options.escalationParsers.length;
    this.id = options.parserId ?? "escalating-document-parser";
    this.description =
      options.description ??
      "Runs a primary parser and escalates to stronger parsers when quality signals require it.";
    if (options.parserVersion !== undefined) {
      this.version = options.parserVersion;
    }
    this.capabilities = {
      inputMode: combinedInputMode([
        this.primaryParser,
        ...this.escalationParsers.map((candidate) => candidate.parser)
      ]),
      emitsLayout:
        this.primaryParser.capabilities.emitsLayout ||
        this.escalationParsers.some((candidate) => candidate.parser.capabilities.emitsLayout),
      emitsTables:
        this.primaryParser.capabilities.emitsTables ||
        this.escalationParsers.some((candidate) => candidate.parser.capabilities.emitsTables),
      emitsVisualAssets:
        this.primaryParser.capabilities.emitsVisualAssets ||
        this.escalationParsers.some((candidate) => candidate.parser.capabilities.emitsVisualAssets),
      ...combinedSupportedContentTypes([
        this.primaryParser,
        ...this.escalationParsers.map((candidate) => candidate.parser)
      ])
    };
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    let primary: DocumentParseResult;
    let primaryQuality: ParserResultQuality;
    try {
      primary = await this.primaryParser.parse(request);
      primaryQuality = assessParserResultQuality(request, primary);
    } catch (error) {
      const escalationParsers = this.escalationParsers.slice(0, this.maxEscalationParsers);
      if (escalationParsers.length === 0) {
        return failedEscalationResult(request, this.id, this.version, error);
      }

      return this.compareWithEscalationParsers(request, escalationParsers, [
        {
          parserId: this.primaryParser.id,
          status: "failed",
          errorMessage: errorName(error)
        }
      ]);
    }
    const escalationParsers = escalationParsersForRisks(
      primaryQuality.risks,
      this.escalationParsers
    ).slice(0, this.maxEscalationParsers);

    if (primaryQuality.score >= this.minimumPrimaryScore && primaryQuality.risks.length === 0) {
      return withWrapperParserId(
        withEscalationMetadata(primary, primaryQuality, false, []),
        this.id,
        this.version
      );
    }

    if (escalationParsers.length === 0) {
      return withWrapperParserId(
        withEscalationMetadata(primary, primaryQuality, false, []),
        this.id,
        this.version
      );
    }

    return this.compareWithEscalationParsers(request, escalationParsers, [
      {
        parserId: this.primaryParser.id,
        status: "fulfilled",
        result: primary,
        quality: primaryQuality
      }
    ]);
  }

  private async compareWithEscalationParsers(
    request: DocumentParseRequest,
    escalationParsers: readonly ParserEscalationCandidate[],
    precomputedAttempts: readonly ParserComparisonAttempt[]
  ): Promise<DocumentParseResult> {
    const comparison = await compareParserResults(
      request,
      escalationParsers.map((candidate) => candidate.parser),
      {
        precomputedAttempts
      }
    );
    return withWrapperParserId(
      withEscalationMetadata(
        comparison.selected,
        comparison.selectedQuality,
        comparison.selected.parserId !== this.primaryParser.id,
        escalationParsers.map((candidate) => candidate.parser.id)
      ),
      this.id,
      this.version
    );
  }
}

export function escalationParsersForRisks(
  risks: readonly ParserResultRisk[],
  candidates: readonly ParserEscalationCandidate[]
): readonly ParserEscalationCandidate[] {
  if (risks.length === 0) {
    return [];
  }
  const selected = new Map<string, ParserEscalationCandidate>();
  for (const risk of risks) {
    for (const candidate of candidates) {
      if (candidate.addressesRisks.includes(risk)) {
        selected.set(candidate.parser.id, candidate);
      }
    }
  }
  return [...selected.values()];
}

function withEscalationMetadata(
  result: DocumentParseResult,
  quality: ParserResultQuality,
  escalated: boolean,
  attemptedParserIds: readonly string[]
): DocumentParseResult {
  return {
    ...result,
    document: {
      ...result.document,
      metadata: {
        ...result.document.metadata,
        parserEscalationSelectedParserId: result.parserId,
        parserEscalationSelectedScore: quality.score,
        parserEscalationSelectedRisksJson: JSON.stringify(quality.risks),
        parserEscalationAttemptedParserIdsJson: JSON.stringify(attemptedParserIds),
        parserEscalationApplied: escalated
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

function failedEscalationResult(
  request: DocumentParseRequest,
  parserId: string,
  parserVersion: string | undefined,
  error: unknown
): DocumentParseResult {
  const warning = {
    code: "parser_escalation_failed",
    message: `Parser escalation failed with ${errorName(error)}.`
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
