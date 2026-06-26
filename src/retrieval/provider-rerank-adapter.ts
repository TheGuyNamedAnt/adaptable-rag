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
  RerankModelAdapter,
  RerankModelRequest,
  RerankModelResult,
  RerankModelScore
} from "./model-reranker.js";

export interface ProviderRerankUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ProviderRerankParsedResponse {
  readonly scores: readonly RerankModelScore[];
  readonly usage?: ProviderRerankUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderRerankAdapterOptions {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly buildHeaders?: ProviderRequestHeadersBuilder;
  readonly buildRequestBody: (request: RerankModelRequest) => unknown;
  readonly parseResponse: (
    response: ProviderHttpResponse,
    request: RerankModelRequest
  ) => ProviderRerankParsedResponse;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class ProviderRerankAdapter implements RerankModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;

  private readonly options: ProviderRerankAdapterOptions;

  constructor(options: ProviderRerankAdapterOptions) {
    validateProviderConfig(options.config);
    this.id = options.config.id;
    this.provider = options.config.provider;
    this.modelName = options.config.modelName;
    this.options = options;
  }

  async rerank(request: RerankModelRequest): Promise<RerankModelResult> {
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
        message: "Provider rerank request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  private parseResponse(
    response: ProviderHttpResponse,
    request: RerankModelRequest,
    secret: string
  ): ProviderRerankParsedResponse {
    try {
      return this.options.parseResponse(response, request);
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private successResult(input: {
    readonly request: RerankModelRequest;
    readonly parsed: ProviderRerankParsedResponse;
    readonly completedAt: string;
    readonly latencyMs: number;
  }): RerankModelResult {
    const usage = input.parsed.usage ?? estimateRerankUsage(input.request, input.parsed.scores);

    return {
      status: "succeeded",
      scores: input.parsed.scores,
      provider: this.provider,
      modelName: this.modelName,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      cost: estimateCost(usage, this.options.config),
      warnings: input.parsed.warnings ?? []
    };
  }

  private failedResult(input: {
    readonly request: RerankModelRequest;
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): RerankModelResult {
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
      status: "failed",
      scores: [],
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
      ],
      errorMessage: message
    };
  }
}

function shouldRetry(error: ProviderMappedError, attempt: number, maxAttempts: number): boolean {
  return error.retryable && attempt < maxAttempts;
}

function safeParseResponse(
  parse: () => ProviderRerankParsedResponse
):
  | { readonly value: ProviderRerankParsedResponse; readonly error?: never }
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

function estimateRerankUsage(
  request: RerankModelRequest,
  scores: readonly RerankModelScore[]
): ProviderRerankUsage {
  const promptTokens = estimateTokens(
    `${request.query}\n${request.candidates
      .map((candidate) => `${candidate.chunkId}\n${candidate.title}\n${candidate.text}`)
      .join("\n")}`
  );
  const completionTokens = estimateTokens(
    scores.map((score) => `${score.chunkId}:${score.score}:${score.reason ?? ""}`).join("\n")
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function estimateCost(
  usage: ProviderRerankUsage,
  config: ProviderBoundaryConfig
): RerankModelResult["cost"] {
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
