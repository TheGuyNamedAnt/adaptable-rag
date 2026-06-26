import type {
  ModelAdapter,
  ModelCostEstimate,
  ModelGenerateRequest,
  ModelGenerateResult,
  ModelTokenUsage
} from "./model-types.js";
import type {
  ProviderAttemptTrace,
  ProviderBoundaryConfig,
  ProviderHttpResponse,
  ProviderMappedError,
  ProviderModelAdapterOptions,
  ProviderParsedResponse
} from "./provider-types.js";
import {
  ProviderParseError,
  defaultProviderRequestHeaders,
  mapProviderStatus,
  mapTransportError,
  providerBoundaryTrace,
  redactText,
  validateProviderConfig
} from "../shared/provider-boundary.js";

export {
  ProviderParseError,
  defaultProviderRequestHeaders,
  mapProviderStatus,
  mapTransportError,
  providerBoundaryTrace,
  redactText,
  validateProviderConfig
} from "../shared/provider-boundary.js";

const EMPTY_USAGE: ModelTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0
};

export class ProviderModelAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;

  private readonly options: ProviderModelAdapterOptions;

  constructor(options: ProviderModelAdapterOptions) {
    validateProviderConfig(options.config);
    this.id = options.config.id;
    this.provider = options.config.provider;
    this.modelName = options.config.modelName;
    this.options = options;
  }

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResult> {
    const startedAtMs = Date.now();
    const now = this.options.now ?? (() => new Date().toISOString());
    const attempts: ProviderAttemptTrace[] = [];
    const apiKey = await resolveApiKey(this.options.secrets.apiKeyProvider);

    if (!apiKey) {
      return this.failedResult({
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

    const body = this.options.buildRequestBody(request);
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
      body,
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
            response,
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
      completedAt: now(),
      latencyMs: totalLatency(attempts) || elapsedMs(startedAtMs),
      error: finalError ?? {
        code: "provider_error",
        message: "Provider request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  private parseResponse(
    response: ProviderHttpResponse,
    request: ModelGenerateRequest,
    secret: string
  ): ProviderParsedResponse {
    try {
      return this.options.parseResponse(response, request);
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private successResult(input: {
    readonly request: ModelGenerateRequest;
    readonly response: ProviderHttpResponse;
    readonly parsed: ProviderParsedResponse;
    readonly completedAt: string;
    readonly latencyMs: number;
  }): ModelGenerateResult {
    const usage = input.parsed.usage ?? estimateUsage(input.request, input.parsed.draft);

    return {
      status: "succeeded",
      draft: input.parsed.draft,
      provider: this.provider,
      modelName: this.modelName,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      usage,
      cost: estimateCost(usage, this.options.config),
      warnings: input.parsed.warnings ?? []
    };
  }

  private failedResult(input: {
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): ModelGenerateResult {
    const message = redactText(input.error.message, [
      input.secret ?? "",
      this.options.secrets.secretId ?? ""
    ]);
    const boundary = providerBoundaryTrace(
      this.options.config,
      this.id,
      input.attempts,
      input.error
    );

    return {
      status: "failed",
      provider: this.provider,
      modelName: this.modelName,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      usage: EMPTY_USAGE,
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
  parse: () => ProviderParsedResponse
):
  | { readonly value: ProviderParsedResponse; readonly error?: never }
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

function estimateUsage(
  request: ModelGenerateRequest,
  draft: ProviderParsedResponse["draft"]
): ModelTokenUsage {
  const promptTokens = estimateTokens(
    `${request.input.question}\n${request.input.contextText}\n${request.input.groundingRules.join("\n")}`
  );
  const completionTokens = estimateTokens(
    `${draft.answer}\n${draft.evidenceSummary ?? ""}\n${draft.citationChunkIds.join(" ")}`
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

function estimateCost(usage: ModelTokenUsage, config: ProviderBoundaryConfig): ModelCostEstimate {
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
