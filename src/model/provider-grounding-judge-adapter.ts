import {
  ProviderParseError,
  defaultProviderRequestHeaders,
  mapProviderStatus,
  mapTransportError,
  providerBoundaryTrace,
  redactText,
  validateProviderConfig,
  type ProviderAdapterSecrets,
  type ProviderAttemptTrace,
  type ProviderBoundaryConfig,
  type ProviderHttpResponse,
  type ProviderMappedError,
  type ProviderRequestHeadersBuilder,
  type ProviderTransport
} from "../shared/provider-boundary.js";
import type {
  GroundingJudgeIssue,
  GroundingJudgeModelAdapter,
  GroundingJudgeModelRequest,
  GroundingJudgeModelResult
} from "../answer/grounding-judge.js";

export interface ProviderGroundingJudgeUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ProviderGroundingJudgeParsedResponse {
  readonly verdict: GroundingJudgeModelResult["verdict"];
  readonly issues: readonly GroundingJudgeIssue[];
  readonly usage?: ProviderGroundingJudgeUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderGroundingJudgeAdapterOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly buildHeaders?: ProviderRequestHeadersBuilder;
  readonly buildRequestBody: (request: GroundingJudgeModelRequest) => unknown;
  readonly parseResponse: (
    response: ProviderHttpResponse,
    request: GroundingJudgeModelRequest
  ) => ProviderGroundingJudgeParsedResponse;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class ProviderGroundingJudgeAdapter implements GroundingJudgeModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;

  private readonly options: ProviderGroundingJudgeAdapterOptions;

  constructor(options: ProviderGroundingJudgeAdapterOptions) {
    validateProviderConfig(options.config);
    this.id = options.config.id;
    this.provider = options.config.provider;
    this.modelName = options.config.modelName;
    this.options = options;
  }

  async judge(request: GroundingJudgeModelRequest): Promise<GroundingJudgeModelResult> {
    const startedAtMs = Date.now();
    const now = this.options.now ?? (() => new Date().toISOString());
    const attempts: ProviderAttemptTrace[] = [];
    const apiKey = await resolveApiKey(this.options.secrets.apiKeyProvider);

    if (!apiKey) {
      return this.failedResult({
        request,
        completedAt: now(),
        latencyMs: elapsedMs(startedAtMs),
        error: {
          code: "auth_error",
          message: "Provider API key is missing.",
          retryable: false
        },
        attempts
      });
    }

    const headers =
      this.options.buildHeaders?.({
        apiKey,
        requestId: request.requestId
      }) ??
      defaultProviderRequestHeaders({
        apiKey,
        requestId: request.requestId
      });
    const httpRequest = {
      requestId: request.requestId,
      url: this.options.config.endpoint,
      method: "POST" as const,
      headers,
      body: this.options.buildRequestBody(request),
      timeoutMs: this.options.config.timeoutMs
    };
    const maxAttempts = this.options.config.retryPolicy.maxRetries + 1;
    let finalError: ProviderMappedError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.options.transport.send(httpRequest);
        const mapped = mapProviderStatus(response);

        if (!mapped) {
          const parsed = safeParseResponse(() => this.parseResponse(response, request, apiKey));
          if (parsed.error) {
            attempts.push({
              attempt,
              status: response.status,
              latencyMs: response.latencyMs,
              errorCode: parsed.error.code,
              retryable: parsed.error.retryable
            });
            finalError = parsed.error;
            break;
          }

          attempts.push({
            attempt,
            status: response.status,
            latencyMs: response.latencyMs,
            retryable: false
          });
          return this.successResult({
            request,
            parsed: parsed.value,
            completedAt: now(),
            latencyMs: totalLatency(attempts)
          });
        }

        attempts.push({
          attempt,
          status: response.status,
          latencyMs: response.latencyMs,
          errorCode: mapped.code,
          retryable: mapped.retryable
        });
        finalError = mapped;
        if (!shouldRetry(mapped, attempt, maxAttempts)) {
          break;
        }
      } catch (error) {
        const mapped = mapTransportError(error);
        attempts.push({
          attempt,
          latencyMs: 0,
          errorCode: mapped.code,
          retryable: mapped.retryable
        });
        finalError = mapped;
        if (!shouldRetry(mapped, attempt, maxAttempts)) {
          break;
        }
      }

      await maybeSleep(this.options.sleep, this.options.config.retryPolicy.backoffMs);
    }

    return this.failedResult({
      request,
      completedAt: now(),
      latencyMs: totalLatency(attempts) || elapsedMs(startedAtMs),
      error: finalError ?? {
        code: "provider_error",
        message: "Provider grounding judge request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  private parseResponse(
    response: ProviderHttpResponse,
    request: GroundingJudgeModelRequest,
    secret: string
  ): ProviderGroundingJudgeParsedResponse {
    try {
      return this.options.parseResponse(response, request);
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private successResult(input: {
    readonly request: GroundingJudgeModelRequest;
    readonly parsed: ProviderGroundingJudgeParsedResponse;
    readonly completedAt: string;
    readonly latencyMs: number;
  }): GroundingJudgeModelResult {
    const usage = input.parsed.usage ?? estimateGroundingJudgeUsage(input.request, input.parsed);

    return {
      verdict: input.parsed.verdict,
      issues: input.parsed.issues,
      provider: this.provider,
      modelName: this.modelName,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      cost: estimateCost(usage, this.options.config),
      warnings: input.parsed.warnings ?? []
    };
  }

  private failedResult(input: {
    readonly request: GroundingJudgeModelRequest;
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): GroundingJudgeModelResult {
    const message = redactText(input.error.message, [
      input.secret ?? "",
      this.options.secrets.secretId ?? ""
    ]);
    const boundary = providerBoundaryTrace(
      this.options.config,
      input.request.requestId,
      input.attempts,
      input.error
    );

    return {
      verdict: "failed",
      issues: [
        {
          code: "judge_failed",
          message
        }
      ],
      provider: this.provider,
      modelName: this.modelName,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      cost: {
        amountUsd: 0,
        currency: "USD"
      },
      warnings: [
        `provider_error_code:${input.error.code}`,
        `provider_attempts:${input.attempts.length}`,
        `provider_endpoint_host:${boundary.endpointHost}`
      ]
    };
  }
}

function shouldRetry(error: ProviderMappedError, attempt: number, maxAttempts: number): boolean {
  return error.retryable && attempt < maxAttempts;
}

function safeParseResponse(
  parse: () => ProviderGroundingJudgeParsedResponse
):
  | { readonly value: ProviderGroundingJudgeParsedResponse; readonly error?: never }
  | { readonly error: ProviderMappedError; readonly value?: never } {
  try {
    return {
      value: parse()
    };
  } catch (error) {
    return {
      error: mapTransportError(error)
    };
  }
}

async function maybeSleep(
  sleep: ((milliseconds: number) => Promise<void>) | undefined,
  milliseconds: number
): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  if (sleep) {
    await sleep(milliseconds);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveApiKey(provider: () => string | Promise<string>): Promise<string> {
  const value = await provider();
  return value.trim();
}

function estimateGroundingJudgeUsage(
  request: GroundingJudgeModelRequest,
  parsed: ProviderGroundingJudgeParsedResponse
): ProviderGroundingJudgeUsage {
  const promptTokens = estimateTokens(
    `${request.question}\n${request.answer}\n${request.citationChunkIds.join(" ")}\n${request.contextBlocks
      .map((block) => `${block.chunkId}\n${block.text}`)
      .join("\n")}`
  );
  const completionTokens = estimateTokens(
    `${parsed.verdict}\n${parsed.issues
      .map((issue) => `${issue.code}:${issue.chunkId ?? ""}:${issue.message}`)
      .join("\n")}`
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function estimateCost(
  usage: ProviderGroundingJudgeUsage,
  config: ProviderBoundaryConfig
): GroundingJudgeModelResult["cost"] {
  if (!config.pricing) {
    return {
      amountUsd: 0,
      currency: "USD"
    };
  }

  const amountUsd =
    (usage.promptTokens / 1000) * config.pricing.promptUsdPer1kTokens +
    (usage.completionTokens / 1000) * config.pricing.completionUsdPer1kTokens;

  return {
    amountUsd: Math.round(amountUsd * 1_000_000) / 1_000_000,
    currency: "USD"
  };
}

function totalLatency(attempts: readonly ProviderAttemptTrace[]): number {
  return attempts.reduce((total, attempt) => total + attempt.latencyMs, 0);
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
