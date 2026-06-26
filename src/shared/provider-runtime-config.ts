import {
  validateProviderConfig,
  type ProviderAdapterSecrets,
  type ProviderBoundaryConfig,
  type ProviderPricing,
  type ProviderRetryPolicy
} from "./provider-boundary.js";

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderRuntimeConfigDefaults {
  readonly timeoutMs: number;
  readonly retryPolicy: ProviderRetryPolicy;
  readonly pricing?: ProviderPricing;
}

export interface LoadProviderRuntimeConfigFromEnvOptions {
  readonly prefix: string;
  readonly env?: ProviderEnv;
  readonly defaults?: Partial<ProviderRuntimeConfigDefaults>;
  readonly requireApiKey?: boolean;
}

export interface LoadedProviderRuntimeConfig {
  readonly config: ProviderBoundaryConfig;
  readonly secrets: ProviderAdapterSecrets;
}

export interface LoadedEmbeddingProviderRuntimeConfig extends LoadedProviderRuntimeConfig {
  readonly dimensions: number;
}

export const DEFAULT_PROVIDER_RUNTIME_CONFIG: ProviderRuntimeConfigDefaults = {
  timeoutMs: 30000,
  retryPolicy: {
    maxRetries: 2,
    backoffMs: 250,
    retryStatusCodes: [408, 429, 500, 502, 503, 504]
  }
};

export class ProviderRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeConfigError";
  }
}

export function hasProviderRuntimeEnv(env: ProviderEnv, prefix: string): boolean {
  const normalizedPrefix = normalizePrefix(prefix);
  return ["ID", "PROVIDER", "MODEL_NAME", "ENDPOINT", "API_KEY", "API_KEY_ENV"].some(
    (suffix) => readOptionalEnv(env, envName(normalizedPrefix, suffix)) !== undefined
  );
}

export function loadProviderRuntimeConfigFromEnv(
  options: LoadProviderRuntimeConfigFromEnvOptions
): LoadedProviderRuntimeConfig {
  const env = options.env ?? process.env;
  const prefix = normalizePrefix(options.prefix);
  const missing: string[] = [];
  const id = readOptionalEnv(env, envName(prefix, "ID")) ?? prefix.toLowerCase().replace(/_/g, "-");
  const provider = readRequiredEnv(env, envName(prefix, "PROVIDER"), missing);
  const modelName = readRequiredEnv(env, envName(prefix, "MODEL_NAME"), missing);
  const endpoint = readRequiredEnv(env, envName(prefix, "ENDPOINT"), missing);
  const secret = resolveSecret(env, prefix, options.requireApiKey !== false);

  missing.push(...secret.missing);
  if (missing.length > 0) {
    throw new ProviderRuntimeConfigError(
      `Missing provider environment values: ${missing.join(", ")}`
    );
  }

  const config: ProviderBoundaryConfig = {
    id,
    provider,
    modelName,
    endpoint,
    timeoutMs: readIntegerEnv(
      env,
      envName(prefix, "TIMEOUT_MS"),
      options.defaults?.timeoutMs ?? DEFAULT_PROVIDER_RUNTIME_CONFIG.timeoutMs,
      { minimum: 1, maximum: 120000 }
    ),
    retryPolicy: readRetryPolicy(env, prefix, options.defaults?.retryPolicy),
    ...readPricing(env, prefix, options.defaults?.pricing)
  };
  validateProviderConfig(config);

  return {
    config,
    secrets: {
      apiKeyProvider: () => readOptionalEnv(env, secret.envName) ?? "",
      secretId: secret.envName
    }
  };
}

export function loadEmbeddingProviderRuntimeConfigFromEnv(
  options: LoadProviderRuntimeConfigFromEnvOptions
): LoadedEmbeddingProviderRuntimeConfig {
  const env = options.env ?? process.env;
  const prefix = normalizePrefix(options.prefix);
  const loaded = loadProviderRuntimeConfigFromEnv({
    ...options,
    env,
    prefix
  });
  const dimensionsName = envName(prefix, "DIMENSIONS");
  const dimensions = readIntegerEnv(env, dimensionsName, undefined, {
    minimum: 1,
    maximum: 100000
  });

  if (dimensions === undefined) {
    throw new ProviderRuntimeConfigError(`Missing provider environment values: ${dimensionsName}`);
  }

  return {
    ...loaded,
    dimensions
  };
}

function resolveSecret(
  env: ProviderEnv,
  prefix: string,
  requireApiKey: boolean
): { readonly envName: string; readonly missing: readonly string[] } {
  const directSecretName = envName(prefix, "API_KEY");
  const secretReferenceName = envName(prefix, "API_KEY_ENV");
  const referencedEnvName = readOptionalEnv(env, secretReferenceName);
  const secretEnvName = referencedEnvName ?? directSecretName;
  const secretValue = readOptionalEnv(env, secretEnvName);

  if (!requireApiKey || secretValue !== undefined) {
    return { envName: secretEnvName, missing: [] };
  }

  return {
    envName: secretEnvName,
    missing: [
      referencedEnvName === undefined
        ? `${directSecretName} or ${secretReferenceName}`
        : `${referencedEnvName} referenced by ${secretReferenceName}`
    ]
  };
}

function readRetryPolicy(
  env: ProviderEnv,
  prefix: string,
  defaults: ProviderRetryPolicy | undefined
): ProviderRetryPolicy {
  const fallback = defaults ?? DEFAULT_PROVIDER_RUNTIME_CONFIG.retryPolicy;
  return {
    maxRetries: readIntegerEnv(env, envName(prefix, "MAX_RETRIES"), fallback.maxRetries, {
      minimum: 0,
      maximum: 5
    }),
    backoffMs: readIntegerEnv(env, envName(prefix, "BACKOFF_MS"), fallback.backoffMs, {
      minimum: 0,
      maximum: 30000
    }),
    retryStatusCodes: readStatusCodesEnv(
      env,
      envName(prefix, "RETRY_STATUS_CODES"),
      fallback.retryStatusCodes
    )
  };
}

function readPricing(
  env: ProviderEnv,
  prefix: string,
  defaults: ProviderPricing | undefined
): { readonly pricing?: ProviderPricing } {
  const prompt = readNumberEnv(
    env,
    envName(prefix, "PROMPT_USD_PER_1K_TOKENS"),
    defaults?.promptUsdPer1kTokens
  );
  const completion = readNumberEnv(
    env,
    envName(prefix, "COMPLETION_USD_PER_1K_TOKENS"),
    defaults?.completionUsdPer1kTokens
  );

  if (prompt === undefined && completion === undefined) {
    return {};
  }

  return {
    pricing: {
      promptUsdPer1kTokens: prompt ?? 0,
      completionUsdPer1kTokens: completion ?? 0
    }
  };
}

function readRequiredEnv(env: ProviderEnv, name: string, missing: string[]): string {
  const value = readOptionalEnv(env, name);
  if (value === undefined) {
    missing.push(name);
    return "";
  }

  return value;
}

function readOptionalEnv(env: ProviderEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readIntegerEnv(
  env: ProviderEnv,
  name: string,
  fallback: number,
  bounds: { readonly minimum: number; readonly maximum: number }
): number;
function readIntegerEnv(
  env: ProviderEnv,
  name: string,
  fallback: undefined,
  bounds: { readonly minimum: number; readonly maximum: number }
): number | undefined;
function readIntegerEnv(
  env: ProviderEnv,
  name: string,
  fallback: number | undefined,
  bounds: { readonly minimum: number; readonly maximum: number }
): number | undefined {
  const value = readOptionalEnv(env, name);
  if (value === undefined) {
    return fallback;
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new ProviderRuntimeConfigError(`${name} must be an integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    throw new ProviderRuntimeConfigError(
      `${name} must be between ${bounds.minimum} and ${bounds.maximum}.`
    );
  }

  return parsed;
}

function readNumberEnv(
  env: ProviderEnv,
  name: string,
  fallback: number | undefined
): number | undefined {
  const value = readOptionalEnv(env, name);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ProviderRuntimeConfigError(`${name} must be a non-negative number.`);
  }

  return parsed;
}

function readStatusCodesEnv(
  env: ProviderEnv,
  name: string,
  fallback: readonly number[]
): readonly number[] {
  const value = readOptionalEnv(env, name);
  if (value === undefined) {
    return fallback;
  }

  const parsed = value.split(",").map((item) => item.trim());
  if (parsed.length === 0) {
    throw new ProviderRuntimeConfigError(`${name} must include status codes.`);
  }

  return parsed.map((item) => {
    if (!/^[0-9]{3}$/.test(item)) {
      throw new ProviderRuntimeConfigError(`${name} must include HTTP status codes.`);
    }
    return Number.parseInt(item, 10);
  });
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw new ProviderRuntimeConfigError(
      "Provider environment prefix must contain only uppercase letters, numbers, and underscores."
    );
  }

  return normalized;
}

function envName(prefix: string, suffix: string): string {
  return `${prefix}_${suffix}`;
}
