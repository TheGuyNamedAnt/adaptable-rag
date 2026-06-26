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
  VisualEmbedding,
  VisualEmbeddingAdapter,
  VisualEmbeddingBatchResult,
  VisualEmbeddingInput,
  VisualEmbeddingRequest,
  VisualEmbeddingUsage,
  VisualEmbeddingVector,
  VisualQueryEmbeddingRequest,
  VisualQueryEmbeddingResult
} from "./visual-embedding-types.js";

export interface ProviderVisualEmbeddingVector {
  readonly id: string;
  readonly vectors: readonly VisualEmbeddingVector[];
  readonly textHash?: string;
  readonly visualAssetId?: string;
}

export interface ProviderVisualEmbeddingParsedResponse {
  readonly embeddings: readonly ProviderVisualEmbeddingVector[];
  readonly usage?: VisualEmbeddingUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderVisualQueryEmbeddingParsedResponse {
  readonly vectors: readonly VisualEmbeddingVector[];
  readonly usage?: VisualEmbeddingUsage;
  readonly warnings?: readonly string[];
}

export interface ProviderVisualEmbeddingAdapterOptions {
  readonly config: ProviderBoundaryConfig;
  readonly dimensions: number;
  readonly secrets: ProviderAdapterSecrets;
  readonly transport: ProviderTransport;
  readonly buildHeaders?: ProviderRequestHeadersBuilder;
  readonly buildVisualAssetsRequestBody: (request: VisualEmbeddingRequest) => unknown;
  readonly buildQueryRequestBody: (request: VisualQueryEmbeddingRequest) => unknown;
  readonly parseVisualAssetsResponse: (
    response: ProviderHttpResponse,
    request: VisualEmbeddingRequest
  ) => ProviderVisualEmbeddingParsedResponse;
  readonly parseQueryResponse: (
    response: ProviderHttpResponse,
    request: VisualQueryEmbeddingRequest
  ) => ProviderVisualQueryEmbeddingParsedResponse;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ParsedVisualAssetsResponse {
  readonly embeddings: readonly VisualEmbedding[];
  readonly usage?: VisualEmbeddingUsage;
  readonly warnings?: readonly string[];
}

interface ParsedVisualQueryResponse {
  readonly vectors: readonly VisualEmbeddingVector[];
  readonly usage?: VisualEmbeddingUsage;
  readonly warnings?: readonly string[];
}

export class ProviderVisualEmbeddingAdapter implements VisualEmbeddingAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dimensions: number;

  private readonly options: ProviderVisualEmbeddingAdapterOptions;

  constructor(options: ProviderVisualEmbeddingAdapterOptions) {
    validateProviderConfig(options.config);
    validateDimensions(options.dimensions);
    this.id = options.config.id;
    this.provider = options.config.provider;
    this.modelName = options.config.modelName;
    this.dimensions = options.dimensions;
    this.options = options;
  }

  async embedVisualAssets(request: VisualEmbeddingRequest): Promise<VisualEmbeddingBatchResult> {
    const startedAtMs = Date.now();
    const now = this.options.now ?? (() => new Date().toISOString());
    const requestedAt = request.requestedAt ?? now();
    const requestId = `visual_embedding_${requestedAt.replace(/[^0-9a-z]/gi, "")}`;
    const usage = visualAssetsUsageFor(request);
    const attempts: ProviderAttemptTrace[] = [];
    const apiKey = await resolveApiKey(this.options.secrets.apiKeyProvider);

    if (!apiKey) {
      return this.failedVisualAssetsResult({
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

    const headers = this.requestHeaders(apiKey, requestId);
    const httpRequest = {
      requestId,
      url: this.options.config.endpoint,
      method: "POST" as const,
      headers,
      body: this.options.buildVisualAssetsRequestBody(request),
      timeoutMs: this.options.config.timeoutMs
    };
    const maxAttempts = this.options.config.retryPolicy.maxRetries + 1;
    let finalError: ProviderMappedError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.options.transport.send(httpRequest);
        const mapped = mapProviderStatus(response);

        if (!mapped) {
          const parsed = safeParseResponse(() =>
            this.parseVisualAssetsResponse(response, request, apiKey)
          );
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
          return this.successVisualAssetsResult({
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

    return this.failedVisualAssetsResult({
      requestId,
      completedAt: now(),
      latencyMs: totalLatency(attempts) || elapsedMs(startedAtMs),
      usage,
      error: finalError ?? {
        code: "provider_error",
        message: "Provider visual embedding request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  async embedQuery(request: VisualQueryEmbeddingRequest): Promise<VisualQueryEmbeddingResult> {
    const startedAtMs = Date.now();
    const now = this.options.now ?? (() => new Date().toISOString());
    const requestedAt = request.requestedAt ?? now();
    const requestId = `visual_query_embedding_${requestedAt.replace(/[^0-9a-z]/gi, "")}`;
    const usage = visualQueryUsageFor(request);
    const attempts: ProviderAttemptTrace[] = [];
    const apiKey = await resolveApiKey(this.options.secrets.apiKeyProvider);

    if (!apiKey) {
      return this.failedQueryResult({
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

    const headers = this.requestHeaders(apiKey, requestId);
    const httpRequest = {
      requestId,
      url: this.options.config.endpoint,
      method: "POST" as const,
      headers,
      body: this.options.buildQueryRequestBody(request),
      timeoutMs: this.options.config.timeoutMs
    };
    const maxAttempts = this.options.config.retryPolicy.maxRetries + 1;
    let finalError: ProviderMappedError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.options.transport.send(httpRequest);
        const mapped = mapProviderStatus(response);

        if (!mapped) {
          const parsed = safeParseResponse(() =>
            this.parseQueryResponse(response, request, apiKey)
          );
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
          return this.successQueryResult({
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

    return this.failedQueryResult({
      requestId,
      completedAt: now(),
      latencyMs: totalLatency(attempts) || elapsedMs(startedAtMs),
      usage,
      error: finalError ?? {
        code: "provider_error",
        message: "Provider visual query embedding request failed.",
        retryable: false
      },
      attempts,
      secret: apiKey
    });
  }

  private requestHeaders(apiKey: string, requestId: string): Readonly<Record<string, string>> {
    return (
      this.options.buildHeaders?.({
        apiKey,
        requestId
      }) ??
      defaultProviderRequestHeaders({
        apiKey,
        requestId
      })
    );
  }

  private parseVisualAssetsResponse(
    response: ProviderHttpResponse,
    request: VisualEmbeddingRequest,
    secret: string
  ): ParsedVisualAssetsResponse {
    try {
      return normalizeParsedVisualAssetsResponse(
        this.options.parseVisualAssetsResponse(response, request),
        request.inputs,
        this.dimensions
      );
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private parseQueryResponse(
    response: ProviderHttpResponse,
    request: VisualQueryEmbeddingRequest,
    secret: string
  ): ParsedVisualQueryResponse {
    try {
      return normalizeParsedVisualQueryResponse(
        this.options.parseQueryResponse(response, request),
        this.dimensions
      );
    } catch (error) {
      throw new ProviderParseError(redactText(errorMessage(error), [secret]));
    }
  }

  private successVisualAssetsResult(input: {
    readonly parsed: ParsedVisualAssetsResponse;
    readonly fallbackUsage: VisualEmbeddingUsage;
  }): VisualEmbeddingBatchResult {
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      embeddings: input.parsed.embeddings,
      usage: input.parsed.usage ?? {
        ...input.fallbackUsage,
        vectorCount: vectorCountForEmbeddings(input.parsed.embeddings)
      },
      warnings: input.parsed.warnings ?? []
    };
  }

  private successQueryResult(input: {
    readonly parsed: ParsedVisualQueryResponse;
    readonly fallbackUsage: VisualEmbeddingUsage;
  }): VisualQueryEmbeddingResult {
    return {
      status: "succeeded",
      provider: this.provider,
      modelName: this.modelName,
      dimensions: this.dimensions,
      vectors: input.parsed.vectors,
      usage: input.parsed.usage ?? {
        ...input.fallbackUsage,
        vectorCount: input.parsed.vectors.length
      },
      warnings: input.parsed.warnings ?? []
    };
  }

  private failedVisualAssetsResult(input: {
    readonly requestId: string;
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly usage: VisualEmbeddingUsage;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): VisualEmbeddingBatchResult {
    const message = redactedErrorMessage(input.error.message, this.options.secrets, input.secret);
    const warnings = providerFailureWarnings(
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
      warnings,
      errorMessage: message
    };
  }

  private failedQueryResult(input: {
    readonly requestId: string;
    readonly completedAt: string;
    readonly latencyMs: number;
    readonly usage: VisualEmbeddingUsage;
    readonly error: ProviderMappedError;
    readonly attempts: readonly ProviderAttemptTrace[];
    readonly secret?: string;
  }): VisualQueryEmbeddingResult {
    const message = redactedErrorMessage(input.error.message, this.options.secrets, input.secret);
    const warnings = providerFailureWarnings(
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
      vectors: [],
      usage: input.usage,
      warnings,
      errorMessage: message
    };
  }
}

function normalizeParsedVisualAssetsResponse(
  parsed: ProviderVisualEmbeddingParsedResponse,
  inputs: readonly VisualEmbeddingInput[],
  dimensions: number
): ParsedVisualAssetsResponse {
  const inputsById = new Map(inputs.map((input) => [input.id, input]));
  const seenIds = new Set<string>();
  const embeddings: VisualEmbedding[] = [];

  for (const embedding of parsed.embeddings) {
    if (!embedding.id.trim()) {
      throw new Error("Provider visual embedding response included an embedding without an id.");
    }

    if (seenIds.has(embedding.id)) {
      throw new Error(`Provider visual embedding response duplicated id "${embedding.id}".`);
    }
    seenIds.add(embedding.id);

    const input = inputsById.get(embedding.id);
    if (!input) {
      throw new Error(`Provider visual embedding response included unknown id "${embedding.id}".`);
    }

    for (const vector of embedding.vectors) {
      validateVector(vector, dimensions, `Provider visual embedding "${embedding.id}"`);
    }

    embeddings.push({
      id: embedding.id,
      vectors: embedding.vectors,
      textHash: hashText(visualInputBasis(input)),
      ...((embedding.visualAssetId ?? input.visualAssetId)
        ? { visualAssetId: embedding.visualAssetId ?? input.visualAssetId }
        : {})
    });
  }

  const missingCount = inputs.filter((input) => !seenIds.has(input.id)).length;
  const warnings = [
    ...(parsed.warnings ?? []),
    ...(missingCount > 0 ? [`provider_missing_visual_embedding_count:${missingCount}`] : [])
  ];

  return {
    embeddings,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings
  };
}

function normalizeParsedVisualQueryResponse(
  parsed: ProviderVisualQueryEmbeddingParsedResponse,
  dimensions: number
): ParsedVisualQueryResponse {
  if (parsed.vectors.length === 0) {
    throw new Error("Provider visual query response included no vectors.");
  }

  for (const vector of parsed.vectors) {
    validateVector(vector, dimensions, "Provider visual query embedding");
  }

  return {
    vectors: parsed.vectors,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    warnings: parsed.warnings ?? []
  };
}

function validateVector(vector: readonly number[], dimensions: number, label: string): void {
  if (!isFiniteVector(vector)) {
    throw new Error(`${label} must contain finite numeric values.`);
  }

  if (vector.length !== dimensions) {
    throw new Error(
      `${label} dimensions ${vector.length} do not match configured dimensions ${dimensions}.`
    );
  }
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("Provider visual embedding dimensions must be a positive integer.");
  }
}

function visualAssetsUsageFor(request: VisualEmbeddingRequest): VisualEmbeddingUsage {
  return {
    inputCount: request.inputs.length,
    totalInputCharacters: request.inputs.reduce(
      (count, input) => count + visualInputBasis(input).length,
      0
    ),
    vectorCount: 0
  };
}

function visualQueryUsageFor(request: VisualQueryEmbeddingRequest): VisualEmbeddingUsage {
  return {
    inputCount: 1,
    totalInputCharacters: request.query.length,
    vectorCount: 0
  };
}

function visualInputBasis(input: VisualEmbeddingInput): string {
  return [input.text ?? "", input.uri ?? "", input.visualAssetId ?? input.id]
    .filter((value) => value.trim().length > 0)
    .join(" ");
}

function vectorCountForEmbeddings(embeddings: readonly VisualEmbedding[]): number {
  return embeddings.reduce((count, embedding) => count + embedding.vectors.length, 0);
}

function providerFailureWarnings(
  config: ProviderBoundaryConfig,
  requestId: string,
  attempts: readonly ProviderAttemptTrace[],
  error: ProviderMappedError
): readonly string[] {
  const boundary = providerBoundaryTrace(config, requestId, attempts, error);
  return [
    `provider_error_code:${error.code}`,
    `provider_attempts:${attempts.length}`,
    `provider_endpoint_host:${boundary.endpointHost}`
  ];
}

function redactedErrorMessage(
  message: string,
  secrets: ProviderAdapterSecrets,
  secret: string | undefined
): string {
  return redactText(message, [secret ?? "", secrets.secretId ?? ""]);
}

function shouldRetry(error: ProviderMappedError, attempt: number, maxAttempts: number): boolean {
  return error.retryable && attempt < maxAttempts;
}

function safeParseResponse<T>(
  parse: () => T
):
  | { readonly value: T; readonly error?: never }
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
