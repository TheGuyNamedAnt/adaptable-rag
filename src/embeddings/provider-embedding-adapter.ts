import { hashText } from "../shared/hash.js";
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
import { isFiniteVector } from "../shared/vector-math.js";
import type {
  EmbeddingAdapter,
  EmbeddingBatchResult,
  EmbeddingInput,
  EmbeddingRequest,
  EmbeddingUsage,
  TextEmbedding
} from "./embedding-types.js";

export interface ProviderEmbeddingVector {
  readonly id: string;
  readonly vector: readonly number[];
}

export interface ProviderEmbeddingParsedResponse {
  readonly embeddings: readonly ProviderEmbeddingVector[];
  readonly usage?: EmbeddingUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderEmbeddingAdapterOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly buildHeaders?: ProviderRequestHeadersBuilder;
  readonly buildRequestBody: (request: EmbeddingRequest) => unknown;
  readonly parseResponse: (
    response: ProviderHttpResponse,
    request: EmbeddingRequest
  ) => ProviderEmbeddingParsedResponse;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ParsedEmbeddingResponse {
  readonly embeddings: readonly TextEmbedding[];
  readonly usage?: EmbeddingUsage;
  readonly warnings?: readonly string[];
}

export class ProviderEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;

  private readonly options: ProviderEmbeddingAdapterOptions;

  constructor(options: ProviderEmbeddingAdapterOptions) {
    validateProviderConfig(options.config);
    validateDimensions(options.dimensions);
    this.id = options.config.id;
    this.provider = options.config.provider;
    this.modelName = options.config.modelName;
    this.dimensions = options.dimensions;
    this.options = options;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingBatchResult> {
    const startedAtMs = Date.now();
    const now = this.options.now ?? (() => new Date().toISOString());
    const requestedAt = request.requestedAt ?? now();
    const requestId = `embedding_${requestedAt.replace(/[^0-9a-z]/gi, "")}`;
    const usage = usageFor(request);
    const attempts: ProviderAttemptTrace[] = [];
    const apiKey = await resolveApiKey(this.options.secrets.apiKeyProvider);

    if (!apiKey) {
      return this.failedResult({
        requestId,
        completedAt: now(),
        latencyMs: elapsedMs(startedAtMs),
        usage,
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
        requestId
      }) ??
      defaultProviderRequestHeaders({
        apiKey,
        requestId
      });
    const httpRequest = {
      requestId,
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
            parsed: parsed.value,
            fallbackUsage: usage
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
      requestId,
      completedAt: now(),
      latencyMs: totalLatency(attempts) || elapsedMs(startedAtMs),
      usage,
      error: finalError ?? {
        code: "provider_error",
        message: "Provider embedding request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  private parseResponse(
    response: ProviderHttpResponse,
    request: EmbeddingRequest,
    secret: string
  ): ParsedEmbeddingResponse {
    try {
      return normalizeParsedResponse(
        this.options.parseResponse(response, request),
        request.inputs,
        this.dimensions
      );
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private successResult(input: {
    readonly parsed: ParsedEmbeddingResponse;
    readonly fallbackUsage: EmbeddingUsage;
  }): EmbeddingBatchResult {
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings: input.parsed.embeddings,
      usage: input.parsed.usage ?? input.fallbackUsage,
      warnings: input.parsed.warnings ?? []
    };
  }

  private failedResult(input: {
    readonly requestId: string;
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly usage: EmbeddingUsage;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): EmbeddingBatchResult {
    const message = redactText(input.error.message, [
      input.secret ?? "",
      this.options.secrets.secretId ?? ""
    ]);
    const boundary = providerBoundaryTrace(
      this.options.config,
      input.requestId,
      input.attempts,
      input.error
    );

    return {
      status: "failed",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings: [],
      usage: input.usage,
      warnings: [
        `provider_error_code:${input.error.code}`,
        `provider_attempts:${input.attempts.length}`,
        `provider_endpoint_host:${boundary.endpointHost}`
      ],
      errorMessage: message
    };
  }
}

function normalizeParsedResponse(
  parsed: ProviderEmbeddingParsedResponse,
  inputs: readonly EmbeddingInput[],
  dimensions: number
): ParsedEmbeddingResponse {
  const inputsById = new Map(inputs.map((input) => [input.id, input]));
  const seenIds = new Set<string>();
  const embeddings: TextEmbedding[] = [];

  for (const embedding of parsed.embeddings) {
    if (!embedding.id.trim()) {
      throw new Error("Provider embedding response included an embedding without an id.");
    }

    if (seenIds.has(embedding.id)) {
      throw new Error(`Provider embedding response duplicated id "${embedding.id}".`);
    }
    seenIds.add(embedding.id);

    const input = inputsById.get(embedding.id);
    if (!input) {
      throw new Error(`Provider embedding response included unknown id "${embedding.id}".`);
    }

    if (!isFiniteVector(embedding.vector)) {
      throw new Error(`Provider embedding "${embedding.id}" must contain finite numeric values.`);
    }

    if (embedding.vector.length !== dimensions) {
      throw new Error(
        `Provider embedding "${embedding.id}" dimensions ${embedding.vector.length} do not match configured dimensions ${dimensions}.`
      );
    }

    embeddings.push({
      id: embedding.id,
      vector: embedding.vector,
      textHash: hashText(input.text)
    });
  }

  const missingCount = inputs.filter((input) => !seenIds.has(input.id)).length;
  const warnings = [
    ...(parsed.warnings ?? []),
    ...(missingCount > 0 ? [`provider_missing_embedding_count:${missingCount}`] : [])
  ];

  return {
    embeddings,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings
  };
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("Provider embedding dimensions must be a positive integer.");
  }
}

function usageFor(request: EmbeddingRequest): EmbeddingUsage {
  return {
    inputCount: request.inputs.length,
    totalInputCharacters: request.inputs.reduce((count, input) => count + input.text.length, 0)
  };
}

function shouldRetry(error: ProviderMappedError, attempt: number, maxAttempts: number): boolean {
  return error.retryable && attempt < maxAttempts;
}

function safeParseResponse(
  parse: () => ParsedEmbeddingResponse
):
  | { readonly value: ParsedEmbeddingResponse; readonly error?: never }
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

function totalLatency(attempts: readonly ProviderAttemptTrace[]): number {
  return attempts.reduce((total, attempt) => total + attempt.latencyMs, 0);
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
