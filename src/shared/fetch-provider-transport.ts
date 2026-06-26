import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "./provider-boundary.js";

export interface FetchProviderRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface FetchProviderResponseHeaders {
  forEach(callback: (value: string, key: string) => void): void;
}

export interface FetchProviderResponse {
  readonly status: number;
  readonly headers: FetchProviderResponseHeaders;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: FetchProviderRequestInit
) => Promise<FetchProviderResponse>;

export interface FetchProviderTransportOptions {
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
}

export class FetchProviderTransport implements ProviderTransport {
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;

  constructor(options: FetchProviderTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetchLike();
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const startedAt = this.nowMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const nodeTimer = timeout as { readonly unref?: () => void };
    nodeTimer.unref?.();

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: serializeJsonBody(request.body),
        signal: controller.signal
      });
      const text = await response.text();

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: parseResponseBody(text),
        latencyMs: Math.max(0, this.nowMs() - startedAt)
      };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error(`Provider request timeout after ${request.timeoutMs} ms.`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function defaultFetchLike(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "Global fetch is not available. Pass a FetchLike implementation to FetchProviderTransport."
    );
  }

  return async (url, init) => globalThis.fetch(url, init);
}

function serializeJsonBody(body: unknown): string {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new Error("Provider request body must be JSON serializable.");
  }

  return serialized;
}

function parseResponseBody(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function headersToRecord(headers: FetchProviderResponseHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}
