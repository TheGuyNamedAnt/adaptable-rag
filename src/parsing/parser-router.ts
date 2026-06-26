import type {
  DocumentParseRequest,
  DocumentParseResult,
  DocumentParser,
  DocumentParserCapabilities,
  DocumentParserWarning,
  ParserInputMode
} from "./parser.js";

export type ParserRouterTier =
  | "fast_native"
  | "layout_local"
  | "visual_local"
  | "paid_cloud"
  | "fallback";

export interface ParserRouterCandidate {
  readonly parser: DocumentParser;
  readonly tier: ParserRouterTier;
  readonly priority?: number;
  readonly requireLayout?: boolean;
  readonly minimumBodyCharacters?: number;
}

export interface ParserRouterPolicy {
  readonly requireLayout?: boolean;
  readonly preferLayout?: boolean;
  readonly preferTables?: boolean;
  readonly preferVisualAssets?: boolean;
  readonly minimumBodyCharacters?: number;
  readonly maxAttempts?: number;
  readonly allowPaidCloud?: boolean;
}

export interface ParserRouterOptions {
  readonly id?: string;
  readonly description?: string;
  readonly version?: string;
  readonly candidates: readonly ParserRouterCandidate[];
  readonly policy?: ParserRouterPolicy;
}

export type ParserRouterAttemptStatus = "accepted" | "rejected" | "failed" | "skipped";

export interface ParserRouterAttemptTrace {
  readonly parserId: string;
  readonly tier: ParserRouterTier;
  readonly status: ParserRouterAttemptStatus;
  readonly priority?: number;
  readonly qualityScore?: number;
  readonly bodyCharacters?: number;
  readonly hasLayout?: boolean;
  readonly tableCount?: number;
  readonly visualAssetCount?: number;
  readonly reasons?: readonly string[];
}

export interface ParserRouterTrace {
  readonly selectedParserId?: string;
  readonly selectedTier?: ParserRouterTier;
  readonly selectedQualityScore?: number;
  readonly attempts: readonly ParserRouterAttemptTrace[];
}

interface AttemptFailure {
  readonly parserId: string;
  readonly tier: ParserRouterTier;
  readonly code: string;
  readonly message: string;
  readonly qualityScore?: number;
}

interface ParseAssessment {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly qualityScore: number;
  readonly bodyCharacters: number;
  readonly hasLayout: boolean;
  readonly tableCount: number;
  readonly visualAssetCount: number;
}

interface CandidateEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export class DocumentParserRouter implements DocumentParser {
  readonly id: string;
  readonly description: string;
  readonly version?: string;
  readonly capabilities: DocumentParserCapabilities;

  private readonly candidates: readonly ParserRouterCandidate[];
  private readonly policy: ParserRouterPolicy;

  constructor(options: ParserRouterOptions) {
    if (options.candidates.length === 0) {
      throw new Error("DocumentParserRouter requires at least one parser candidate.");
    }

    this.id = options.id ?? "parser-router";
    this.description =
      options.description ??
      "Routes documents to the fastest parser that satisfies the requested quality policy.";
    if (options.version !== undefined) {
      this.version = options.version;
    }
    this.candidates = [...options.candidates].sort(compareCandidates);
    this.policy = options.policy ?? {};
    this.capabilities = routerCapabilities(this.candidates);
  }

  async parse(request: DocumentParseRequest): Promise<DocumentParseResult> {
    const failures: AttemptFailure[] = [];
    const attempts: ParserRouterAttemptTrace[] = [];
    const maxAttempts = this.policy.maxAttempts ?? this.candidates.length;
    let attempted = 0;

    for (const [candidateIndex, candidate] of this.candidates.entries()) {
      const eligibility = candidateEligibility(candidate, request, this.policy);
      if (!eligibility.eligible) {
        attempts.push(attemptTrace(candidate, "skipped", { reasons: eligibility.reasons }));
        continue;
      }

      if (attempted >= maxAttempts) {
        attempts.push(
          attemptTrace(candidate, "skipped", {
            reasons: [`maxAttempts=${maxAttempts} was reached before this parser was attempted`]
          })
        );
        continue;
      }

      attempted += 1;
      try {
        const result = await candidate.parser.parse(request);
        const assessment = assessParseResult(result, candidate, this.policy);

        if (assessment.accepted) {
          const acceptedAttempts = [
            ...attempts,
            attemptTrace(candidate, "accepted", {
              qualityScore: assessment.qualityScore,
              bodyCharacters: assessment.bodyCharacters,
              hasLayout: assessment.hasLayout,
              tableCount: assessment.tableCount,
              visualAssetCount: assessment.visualAssetCount,
              reasons: ["satisfied parser router policy"]
            }),
            ...remainingCandidateTraces(
              this.candidates.slice(candidateIndex + 1),
              request,
              this.policy
            )
          ];
          return this.routeResult(result, candidate, attempted, failures, acceptedAttempts);
        }

        attempts.push(
          attemptTrace(candidate, "rejected", {
            qualityScore: assessment.qualityScore,
            bodyCharacters: assessment.bodyCharacters,
            hasLayout: assessment.hasLayout,
            tableCount: assessment.tableCount,
            visualAssetCount: assessment.visualAssetCount,
            reasons: assessment.reasons
          })
        );
        failures.push({
          parserId: candidate.parser.id,
          tier: candidate.tier,
          code: "parser_router_attempt_rejected",
          message: `Parser ${candidate.parser.id} scored ${assessment.qualityScore} and was rejected: ${assessment.reasons.join(
            ", "
          )}.`,
          qualityScore: assessment.qualityScore
        });
      } catch (error) {
        attempts.push(
          attemptTrace(candidate, "failed", {
            reasons: [`parser failed during parse with ${errorName(error)}`]
          })
        );
        failures.push({
          parserId: candidate.parser.id,
          tier: candidate.tier,
          code: "parser_router_attempt_failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const detail =
      failures.length === 0
        ? `No eligible parser candidates were available; ${attempts.length} candidate(s) were skipped.`
        : failures.map((failure) => `${failure.parserId}: ${failure.message}`).join(" ");
    throw new Error(`Parser router could not produce an acceptable parse result. ${detail}`);
  }

  private routeResult(
    result: DocumentParseResult,
    candidate: ParserRouterCandidate,
    attemptCount: number,
    failures: readonly AttemptFailure[],
    attempts: readonly ParserRouterAttemptTrace[]
  ): DocumentParseResult {
    const selectedAttempt = attempts.find(
      (attempt) => attempt.parserId === candidate.parser.id && attempt.status === "accepted"
    );
    const trace: ParserRouterTrace = {
      selectedParserId: candidate.parser.id,
      selectedTier: candidate.tier,
      ...(selectedAttempt?.qualityScore === undefined
        ? {}
        : { selectedQualityScore: selectedAttempt.qualityScore }),
      attempts
    };

    return {
      ...result,
      parserId: this.id,
      ...(this.version === undefined ? {} : { parserVersion: this.version }),
      document: {
        ...result.document,
        metadata: {
          ...result.document.metadata,
          parserRouterSelectedParserId: candidate.parser.id,
          parserRouterSelectedTier: candidate.tier,
          parserRouterAttemptCount: attemptCount,
          ...(selectedAttempt?.qualityScore === undefined
            ? {}
            : { parserRouterSelectedScore: selectedAttempt.qualityScore }),
          parserRouterRejectedAttemptCount: countAttempts(attempts, "rejected"),
          parserRouterFailedAttemptCount: countAttempts(attempts, "failed"),
          parserRouterSkippedCandidateCount: countAttempts(attempts, "skipped"),
          parserRouterTraceJson: JSON.stringify(trace)
        }
      },
      warnings: [...failureWarnings(failures), ...result.warnings]
    };
  }
}

function compareCandidates(a: ParserRouterCandidate, b: ParserRouterCandidate): number {
  const tierDelta = tierRank(a.tier) - tierRank(b.tier);
  if (tierDelta !== 0) {
    return tierDelta;
  }
  return (a.priority ?? 0) - (b.priority ?? 0);
}

function tierRank(tier: ParserRouterTier): number {
  switch (tier) {
    case "fast_native":
      return 0;
    case "layout_local":
      return 1;
    case "visual_local":
      return 2;
    case "paid_cloud":
      return 3;
    case "fallback":
      return 4;
  }
}

function candidateEligibility(
  candidate: ParserRouterCandidate,
  request: DocumentParseRequest,
  policy: ParserRouterPolicy
): CandidateEligibility {
  const reasons: string[] = [];

  if (candidate.tier === "paid_cloud" && policy.allowPaidCloud !== true) {
    reasons.push("paid cloud candidates are disabled by policy");
  }

  if (!supportsInput(candidate.parser.capabilities.inputMode, request)) {
    reasons.push(
      `parser inputMode=${candidate.parser.capabilities.inputMode} is incompatible with request input`
    );
  }

  if (!supportsContentType(candidate.parser.capabilities, request.contentType)) {
    reasons.push(
      request.contentType
        ? `parser does not support contentType=${request.contentType}`
        : "parser requires a supported content type but request contentType is missing"
    );
  }

  if (!withinByteLimit(candidate.parser.capabilities, request.bytes)) {
    reasons.push(`request bytes exceed parser maxBytes=${candidate.parser.capabilities.maxBytes}`);
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

function supportsInput(inputMode: ParserInputMode, request: DocumentParseRequest): boolean {
  if (inputMode === "text_or_binary") {
    return request.text !== undefined || request.bytes !== undefined;
  }
  if (inputMode === "text") {
    return request.text !== undefined;
  }
  return request.bytes !== undefined;
}

function supportsContentType(
  capabilities: DocumentParserCapabilities,
  contentType: string | undefined
): boolean {
  if (!capabilities.supportedContentTypes || capabilities.supportedContentTypes.length === 0) {
    return true;
  }
  if (!contentType) {
    return true;
  }
  return capabilities.supportedContentTypes.some((supported) =>
    supported.endsWith("/*")
      ? contentType.startsWith(supported.slice(0, supported.length - 1))
      : supported === contentType
  );
}

function withinByteLimit(
  capabilities: DocumentParserCapabilities,
  bytes: Uint8Array | undefined
): boolean {
  return (
    bytes === undefined ||
    capabilities.maxBytes === undefined ||
    bytes.length <= capabilities.maxBytes
  );
}

function assessParseResult(
  result: DocumentParseResult,
  candidate: ParserRouterCandidate,
  policy: ParserRouterPolicy
): ParseAssessment {
  const reasons: string[] = [];
  const minimumBodyCharacters =
    candidate.minimumBodyCharacters ?? policy.minimumBodyCharacters ?? 1;
  const bodyLength = result.document.body.trim().length;
  const hasLayout = result.document.layout !== undefined;
  const tableCount = result.document.layout?.tables?.length ?? 0;
  const visualAssetCount = result.document.layout?.visualAssets?.length ?? 0;
  if (bodyLength < minimumBodyCharacters) {
    reasons.push(`body had ${bodyLength} character(s), below ${minimumBodyCharacters}`);
  }

  if ((candidate.requireLayout === true || policy.requireLayout === true) && !hasLayout) {
    reasons.push("layout was required but missing");
  }

  if (policy.preferTables === true && tableCount === 0) {
    reasons.push("tables were preferred but none were emitted");
  }

  if (policy.preferVisualAssets === true && visualAssetCount === 0) {
    reasons.push("visual assets were preferred but none were emitted");
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    qualityScore: parseQualityScore({
      bodyCharacters: bodyLength,
      minimumBodyCharacters,
      layoutRequired: candidate.requireLayout === true || policy.requireLayout === true,
      hasLayout,
      tablesRequired: policy.preferTables === true,
      tableCount,
      visualAssetsRequired: policy.preferVisualAssets === true,
      visualAssetCount
    }),
    bodyCharacters: bodyLength,
    hasLayout,
    tableCount,
    visualAssetCount
  };
}

function parseQualityScore(input: {
  readonly bodyCharacters: number;
  readonly minimumBodyCharacters: number;
  readonly layoutRequired: boolean;
  readonly hasLayout: boolean;
  readonly tablesRequired: boolean;
  readonly tableCount: number;
  readonly visualAssetsRequired: boolean;
  readonly visualAssetCount: number;
}): number {
  let score = 100;

  if (input.bodyCharacters < input.minimumBodyCharacters) {
    const ratio =
      input.minimumBodyCharacters <= 0 ? 0 : input.bodyCharacters / input.minimumBodyCharacters;
    score -= Math.ceil(40 * (1 - Math.max(0, Math.min(1, ratio))));
  }

  if (input.layoutRequired && !input.hasLayout) {
    score -= 25;
  }

  if (input.tablesRequired && input.tableCount === 0) {
    score -= 20;
  }

  if (input.visualAssetsRequired && input.visualAssetCount === 0) {
    score -= 20;
  }

  return Math.max(0, Math.min(100, score));
}

function attemptTrace(
  candidate: ParserRouterCandidate,
  status: ParserRouterAttemptStatus,
  details: Omit<ParserRouterAttemptTrace, "parserId" | "tier" | "status" | "priority"> = {}
): ParserRouterAttemptTrace {
  return {
    parserId: candidate.parser.id,
    tier: candidate.tier,
    status,
    ...(candidate.priority === undefined ? {} : { priority: candidate.priority }),
    ...details
  };
}

function remainingCandidateTraces(
  candidates: readonly ParserRouterCandidate[],
  request: DocumentParseRequest,
  policy: ParserRouterPolicy
): readonly ParserRouterAttemptTrace[] {
  return candidates.map((candidate) => {
    const eligibility = candidateEligibility(candidate, request, policy);
    return attemptTrace(candidate, "skipped", {
      reasons:
        eligibility.reasons.length > 0
          ? eligibility.reasons
          : ["higher-ranked parser accepted before this parser was attempted"]
    });
  });
}

function countAttempts(
  attempts: readonly ParserRouterAttemptTrace[],
  status: ParserRouterAttemptStatus
): number {
  return attempts.filter((attempt) => attempt.status === status).length;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function failureWarnings(failures: readonly AttemptFailure[]): readonly DocumentParserWarning[] {
  return failures.map((failure) => ({
    code: failure.code,
    message: `[${failure.tier}] ${failure.message}`
  }));
}

function routerCapabilities(
  candidates: readonly ParserRouterCandidate[]
): DocumentParserCapabilities {
  const inputMode = combinedInputMode(
    candidates.map((candidate) => candidate.parser.capabilities.inputMode)
  );
  const supportedContentTypes = combinedContentTypes(candidates);
  const maxBytes = combinedMaxBytes(candidates);

  return {
    inputMode,
    emitsLayout: candidates.some((candidate) => candidate.parser.capabilities.emitsLayout),
    emitsTables: candidates.some((candidate) => candidate.parser.capabilities.emitsTables),
    emitsVisualAssets: candidates.some(
      (candidate) => candidate.parser.capabilities.emitsVisualAssets
    ),
    ...(supportedContentTypes ? { supportedContentTypes } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes })
  };
}

function combinedInputMode(inputModes: readonly ParserInputMode[]): ParserInputMode {
  if (inputModes.includes("text_or_binary")) {
    return "text_or_binary";
  }
  return new Set(inputModes).size === 1 ? (inputModes[0] ?? "text_or_binary") : "text_or_binary";
}

function combinedContentTypes(
  candidates: readonly ParserRouterCandidate[]
): readonly string[] | undefined {
  if (
    candidates.some(
      (candidate) =>
        !candidate.parser.capabilities.supportedContentTypes ||
        candidate.parser.capabilities.supportedContentTypes.length === 0
    )
  ) {
    return undefined;
  }

  return [
    ...new Set(
      candidates.flatMap((candidate) => candidate.parser.capabilities.supportedContentTypes ?? [])
    )
  ].sort();
}

function combinedMaxBytes(candidates: readonly ParserRouterCandidate[]): number | undefined {
  const limits = candidates
    .map((candidate) => candidate.parser.capabilities.maxBytes)
    .filter((limit): limit is number => limit !== undefined);
  return limits.length === 0 ? undefined : Math.max(...limits);
}
