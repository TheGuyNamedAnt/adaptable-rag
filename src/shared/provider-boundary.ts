export type ProviderHttpMethod = "POST";

export type ProviderErrorCode =
  | "auth_error"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_response"
  | "invalid_configuration";

export interface ProviderPricing {
  readonly promptUsdPer1kTokens: number;
  readonly completionUsdPer1kTokens: number;
}

export interface ProviderRetryPolicy {
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly retryStatusCodes: readonly number[];
}

export interface ProviderBoundaryConfig {
  readonly id: string;
  readonly provider: string;
  readonly modelName: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly retryPolicy: ProviderRetryPolicy;
  readonly pricing?: ProviderPricing;
}

export interface ProviderHttpRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: ProviderHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
}

export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly latencyMs: number;
}

export interface ProviderTransport {
  send(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

export interface ProviderMappedError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface ProviderAdapterSecrets {
  readonly apiKeyProvider: () => string | Promise<string>;
  readonly secretId?: string;
}

export interface ProviderRequestHeadersInput {
  readonly apiKey: string;
  readonly requestId: string;
}

export type ProviderRequestHeadersBuilder = (
  input: ProviderRequestHeadersInput
) => Readonly<Record<string, string>>;

export interface ProviderAttemptTrace {
  readonly attempt: number;
  readonly status?: number;
  readonly latencyMs: number;
  readonly errorCode?: ProviderErrorCode;
  readonly retryable: boolean;
}

export interface ProviderCallBoundaryTrace {
  readonly requestId: string;
  readonly provider: string;
  readonly modelName: string;
  readonly endpointHost: string;
  readonly attempts: readonly ProviderAttemptTrace[];
  readonly finalErrorCode?: ProviderErrorCode;
}

const DEFAULT_REDACTION = "[REDACTED]";

export class ProviderParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderParseError";
  }
}

export function defaultProviderRequestHeaders(
  input: ProviderRequestHeadersInput
): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    "x-request-id": input.requestId
  };
}

export function validateProviderConfig(config: ProviderBoundaryConfig): void {
  if (!config.id.trim()) {
    throw new Error("Provider config id is required.");
  }

  if (!config.provider.trim()) {
    throw new Error("Provider config provider is required.");
  }

  if (!config.modelName.trim()) {
    throw new Error("Provider config modelName is required.");
  }

  validateEndpoint(config.endpoint);

  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000) {
    throw new Error("Provider timeoutMs must be an integer between 1 and 120000.");
  }

  if (
    !Number.isInteger(config.retryPolicy.maxRetries) ||
    config.retryPolicy.maxRetries < 0 ||
    config.retryPolicy.maxRetries > 5
  ) {
    throw new Error("Provider retryPolicy.maxRetries must be an integer between 0 and 5.");
  }

  if (
    !Number.isInteger(config.retryPolicy.backoffMs) ||
    config.retryPolicy.backoffMs < 0 ||
    config.retryPolicy.backoffMs > 30000
  ) {
    throw new Error("Provider retryPolicy.backoffMs must be an integer between 0 and 30000.");
  }

  if (
    config.pricing &&
    (config.pricing.promptUsdPer1kTokens < 0 || config.pricing.completionUsdPer1kTokens < 0)
  ) {
    throw new Error("Provider pricing values cannot be negative.");
  }
}

export function mapProviderStatus(response: ProviderHttpResponse): ProviderMappedError | undefined {
  if (response.status >= 200 && response.status < 300) {
    return undefined;
  }

  const message = providerErrorMessage(response);

  if (response.status === 401 || response.status === 403) {
    return {
      code: "auth_error",
      message,
      retryable: false,
      status: response.status
    };
  }

  if (response.status === 429) {
    return {
      code: "rate_limited",
      message,
      retryable: true,
      status: response.status
    };
  }

  if (response.status === 408 || response.status === 504) {
    return {
      code: "timeout",
      message,
      retryable: true,
      status: response.status
    };
  }

  return {
    code: "provider_error",
    message,
    retryable: response.status >= 500,
    status: response.status
  };
}

export function mapTransportError(error: unknown): ProviderMappedError {
  const message = errorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("aborted")) {
    return {
      code: "timeout",
      message,
      retryable: true
    };
  }

  if (error instanceof ProviderParseError) {
    return {
      code: "invalid_response",
      message,
      retryable: false
    };
  }

  return {
    code: "network_error",
    message,
    retryable: true
  };
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let output = value;

  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join(DEFAULT_REDACTION);
    }
  }

  return output
    .replace(/bearer\s+[a-z0-9._-]+/gi, `Bearer ${DEFAULT_REDACTION}`)
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, `api_key=${DEFAULT_REDACTION}`)
    .replace(/password\s*[:=]\s*\S+/gi, `password=${DEFAULT_REDACTION}`)
    .replace(/secret\s*[:=]\s*\S+/gi, `secret=${DEFAULT_REDACTION}`)
    .replace(/token\s*[:=]\s*\S+/gi, `token=${DEFAULT_REDACTION}`);
}

export function providerBoundaryTrace(
  config: ProviderBoundaryConfig,
  requestId: string,
  attempts: readonly ProviderAttemptTrace[],
  finalError?: ProviderMappedError
): ProviderCallBoundaryTrace {
  return {
    requestId,
    provider: config.provider,
    modelName: config.modelName,
    endpointHost: new URL(config.endpoint).host,
    attempts,
    ...(finalError ? { finalErrorCode: finalError.code } : {})
  };
}

function validateEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Provider endpoint must be a valid URL.");
  }

  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("Provider endpoint must use https unless it targets localhost.");
  }
}

function providerErrorMessage(response: ProviderHttpResponse): string {
  if (typeof response.body === "string") {
    return response.body;
  }

  if (isRecord(response.body)) {
    const error = response.body["error"];
    if (typeof error === "string") {
      return error;
    }
    if (isRecord(error) && typeof error["message"] === "string") {
      return error["message"];
    }
    if (typeof response.body["message"] === "string") {
      return response.body["message"];
    }
  }

  return `Provider request failed with HTTP ${response.status}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
