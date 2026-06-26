import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ProductionRagRequestError,
  type ProductionHttpAuthConfig,
  type ProductionHttpConfig,
  type ProductionHttpRateLimitConfig,
  type ProductionRagAnswerResponse,
  type ProductionRagApp,
  type ProductionRagAnswerInput
} from "./production-app.js";

export interface ProductionRagHttpServerOptions {
  readonly app: ProductionRagApp;
  readonly http?: Partial<ProductionHttpConfig>;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly logger?: ProductionHttpOperationsLogger;
}

export interface ProductionRagHttpServer {
  readonly server: Server;
  listen(): Promise<{
    readonly host: string;
    readonly port: number;
  }>;
  close(): Promise<void>;
  setReady(ready: boolean): void;
  ready(): boolean;
  metrics(): ProductionHttpMetricsSnapshot;
}

export type ProductionHttpOperationsLogger = (event: ProductionHttpLogEvent) => void;

export type ProductionHttpLogEvent = ProductionHttpAccessLogEvent | ProductionHttpLifecycleLogEvent;

export interface ProductionHttpAccessLogEvent {
  readonly event: "http_access";
  readonly timestamp: string;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly answerStatus?: ProductionRagAnswerResponse["status"];
  readonly runId?: string;
  readonly traceId?: string;
  readonly authResult?: "passed" | "missing_or_invalid" | "disabled";
  readonly errorName?: string;
}

export interface ProductionHttpLifecycleLogEvent {
  readonly event: "server_listening" | "server_draining" | "server_stopped";
  readonly timestamp: string;
  readonly host?: string;
  readonly port?: number;
  readonly reason?: string;
}

export interface ProductionHttpMetricsSnapshot {
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly ready: boolean;
  readonly draining: boolean;
  readonly totalRequests: number;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly byStatusCode: Readonly<Record<string, number>>;
  readonly byRoute: Readonly<Record<string, number>>;
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly authDenied: number;
  readonly rateLimited: number;
  readonly answerSucceeded: number;
  readonly answerRefused: number;
  readonly answerFailed: number;
  readonly requestErrors: number;
  readonly serverErrors: number;
}

interface RequestOperationContext {
  readonly requestId: string;
  readonly requestIdHeader: string;
  readonly method: string;
  readonly path: string;
  readonly route: string;
  readonly startedAtMs: number;
}

interface RequestCompletionDetails {
  readonly answerStatus?: ProductionRagAnswerResponse["status"];
  readonly runId?: string;
  readonly traceId?: string;
  readonly authResult?: "passed" | "missing_or_invalid" | "disabled";
  readonly errorName?: string;
}

export function createProductionRagHttpServer(
  options: ProductionRagHttpServerOptions
): ProductionRagHttpServer {
  const http = mergeHttpConfig(options.app.config.http, options.http);
  const nowMs = options.nowMs ?? Date.now;
  const operations = new ProductionHttpOperationsRuntime({
    config: http,
    nowMs,
    requestId: options.requestId ?? randomUUID,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  const edge = new ProductionHttpEdgeGuard(http, nowMs);
  const server = createServer((request, response) => {
    void handleProductionRagHttpRequest(options.app, request, response, http, edge, operations);
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(http.port, http.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (typeof address === "object" && address !== null) {
            const result = {
              host: address.address,
              port: address.port
            };
            operations.logLifecycle("server_listening", result);
            resolve(result);
            return;
          }

          const result = { host: http.host, port: http.port };
          operations.logLifecycle("server_listening", result);
          resolve(result);
        });
      }),
    close: async () => {
      operations.markDraining("close");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      operations.logLifecycle("server_stopped", {});
    },
    setReady: (ready) => {
      operations.setReady(ready);
    },
    ready: () => operations.ready(),
    metrics: () => operations.snapshot()
  };
}

export async function handleProductionRagHttpRequest(
  app: ProductionRagApp,
  request: IncomingMessage,
  response: ServerResponse,
  http: ProductionHttpConfig = app.config.http,
  edge = new ProductionHttpEdgeGuard(http, Date.now),
  operations = new ProductionHttpOperationsRuntime({
    config: http,
    nowMs: Date.now,
    requestId: randomUUID
  })
): Promise<void> {
  let context: RequestOperationContext | undefined;
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    context = operations.begin(request, url.pathname, routeName(url.pathname, http));

    if (request.method === "GET" && url.pathname === "/health") {
      complete(response, operations, context, 200, app.health(), {}, "health");
      return;
    }

    if (request.method === "GET" && url.pathname === http.operations.readinessPath) {
      if (operations.ready()) {
        complete(
          response,
          operations,
          context,
          200,
          {
            status: "ready",
            ready: true,
            health: app.health()
          },
          {},
          "ready"
        );
        return;
      }

      complete(
        response,
        operations,
        context,
        503,
        {
          status: "draining",
          ready: false
        },
        {},
        "not_ready"
      );
      return;
    }

    if (request.method === "GET" && url.pathname === http.operations.metricsPath) {
      complete(response, operations, context, 200, operations.snapshot(), {}, "metrics");
      return;
    }

    if (request.method === "POST" && url.pathname === "/answer") {
      const auth = edge.authenticate(request);
      const rateLimit = edge.rateLimit(auth.rateLimitKey ?? edge.clientKey(request));
      if (!rateLimit.allowed) {
        complete(
          response,
          operations,
          context,
          429,
          {
            error: {
              name: "RateLimitExceeded",
              message: "Too many requests."
            }
          },
          rateLimitHeaders(rateLimit),
          "rate_limited",
          {
            authResult: auth.allowed ? "passed" : "missing_or_invalid"
          }
        );
        return;
      }

      if (!auth.allowed) {
        complete(
          response,
          operations,
          context,
          401,
          {
            error: {
              name: "Unauthorized",
              message: "Unauthorized."
            }
          },
          {
            ...rateLimitHeaders(rateLimit),
            "www-authenticate": "Bearer"
          },
          "auth_denied",
          { authResult: "missing_or_invalid" }
        );
        return;
      }

      const body = (await readJsonBody(request, http.maxBodyBytes)) as ProductionRagAnswerInput;
      const result = await app.answer(body);
      complete(response, operations, context, 200, result, rateLimitHeaders(rateLimit), "answer", {
        answerStatus: result.status,
        runId: result.trace.runId,
        traceId: result.trace.traceId,
        authResult: http.auth.mode === "disabled" ? "disabled" : "passed",
        ...safeFailureDetails(result)
      });
      return;
    }

    if (knownPath(url.pathname, http)) {
      complete(
        response,
        operations,
        context,
        405,
        {
          error: {
            name: "MethodNotAllowed",
            message: "Method is not allowed for this endpoint."
          }
        },
        {},
        "method_not_allowed"
      );
      return;
    }

    complete(
      response,
      operations,
      context,
      404,
      {
        error: {
          name: "NotFound",
          message: "Endpoint not found."
        }
      },
      {},
      "not_found"
    );
  } catch (error) {
    const statusCode =
      error instanceof ProductionRagRequestError
        ? error.statusCode
        : error instanceof RequestBodyTooLargeError
          ? 413
          : error instanceof InvalidJsonBodyError
            ? 400
            : 500;
    const body = {
      error: {
        name: errorName(error),
        message: statusCode >= 500 ? "RAG request failed." : errorMessage(error)
      }
    };
    if (context === undefined) {
      writeJson(response, statusCode, body);
      return;
    }

    complete(response, operations, context, statusCode, body, {}, errorOutcome(statusCode, error), {
      errorName: errorName(error)
    });
  }
}

class RequestBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes.`);
    this.name = "RequestBodyTooLargeError";
  }
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("Request body must be valid JSON.");
    this.name = "InvalidJsonBodyError";
  }
}

function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let bodyTooLarge = false;

    request.on("data", (chunk: Buffer) => {
      if (bodyTooLarge) {
        return;
      }

      received += chunk.byteLength;
      if (received > maxBodyBytes) {
        bodyTooLarge = true;
        chunks.length = 0;
        return;
      }

      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        if (bodyTooLarge) {
          reject(new RequestBodyTooLargeError(maxBodyBytes));
          return;
        }

        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.trim() ? (JSON.parse(raw) as unknown) : {});
      } catch {
        reject(new InvalidJsonBodyError());
      }
    });
  });
}

interface AuthDecision {
  readonly allowed: boolean;
  readonly rateLimitKey?: string;
}

interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

class ProductionHttpEdgeGuard {
  private readonly limiter: FixedWindowRateLimiter;

  constructor(
    private readonly http: ProductionHttpConfig,
    private readonly nowMs: () => number
  ) {
    this.limiter = new FixedWindowRateLimiter(http.rateLimit, nowMs);
  }

  authenticate(request: IncomingMessage): AuthDecision {
    const auth = this.http.auth;
    if (auth.mode === "disabled") {
      return { allowed: true, rateLimitKey: this.clientKey(request) };
    }

    const token = bearerToken(request, auth);
    if (token === undefined) {
      return { allowed: false };
    }

    const tokenSha256 = sha256Hex(token);
    const matched = auth.tokenSha256s.some((expected) => secureHexEqual(tokenSha256, expected));
    return matched ? { allowed: true, rateLimitKey: `token:${tokenSha256}` } : { allowed: false };
  }

  rateLimit(key: string): RateLimitDecision {
    if (this.http.rateLimit.mode === "disabled") {
      return {
        allowed: true,
        limit: this.http.rateLimit.maxRequests,
        remaining: this.http.rateLimit.maxRequests,
        resetAtMs: this.nowMs() + this.http.rateLimit.windowMs
      };
    }

    return this.limiter.check(key);
  }

  clientKey(request: IncomingMessage): string {
    return `ip:${clientIp(request, this.http.rateLimit.clientIpHeader)}`;
  }
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAtMs: number }>();

  constructor(
    private readonly config: ProductionHttpRateLimitConfig,
    private readonly nowMs: () => number
  ) {}

  check(key: string): RateLimitDecision {
    const now = this.nowMs();
    this.sweepExpired(now);
    const current = this.entries.get(key);
    const entry =
      current && current.resetAtMs > now
        ? current
        : {
            count: 0,
            resetAtMs: now + this.config.windowMs
          };

    entry.count += 1;
    this.entries.set(key, entry);
    this.enforceMaxKeys();

    return {
      allowed: entry.count <= this.config.maxRequests,
      limit: this.config.maxRequests,
      remaining: Math.max(this.config.maxRequests - entry.count, 0),
      resetAtMs: entry.resetAtMs
    };
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }

  private enforceMaxKeys(): void {
    while (this.entries.size > this.config.maxKeys) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }
}

class ProductionHttpOperationsRuntime {
  private readonly startedAtMs: number;
  private readonly counters = {
    totalRequests: 0,
    activeRequests: 0,
    completedRequests: 0,
    byStatusCode: new Map<string, number>(),
    byRoute: new Map<string, number>(),
    byOutcome: new Map<string, number>(),
    authDenied: 0,
    rateLimited: 0,
    answerSucceeded: 0,
    answerRefused: 0,
    answerFailed: 0,
    requestErrors: 0,
    serverErrors: 0
  };
  private readyState = true;
  private drainingState = false;

  constructor(
    private readonly options: {
      readonly config: ProductionHttpConfig;
      readonly nowMs: () => number;
      readonly requestId: () => string;
      readonly logger?: ProductionHttpOperationsLogger;
    }
  ) {
    this.startedAtMs = options.nowMs();
  }

  begin(request: IncomingMessage, pathName: string, route: string): RequestOperationContext {
    const context = {
      requestId: requestIdFor(request, this.options.config, this.options.requestId),
      requestIdHeader: this.options.config.operations.requestIdHeader,
      method: request.method ?? "UNKNOWN",
      path: pathName,
      route,
      startedAtMs: this.options.nowMs()
    };
    this.counters.totalRequests += 1;
    this.counters.activeRequests += 1;
    increment(this.counters.byRoute, route);
    return context;
  }

  complete(
    context: RequestOperationContext,
    statusCode: number,
    outcome: string,
    details: RequestCompletionDetails
  ): void {
    const durationMs = Math.max(0, this.options.nowMs() - context.startedAtMs);
    this.counters.activeRequests = Math.max(0, this.counters.activeRequests - 1);
    this.counters.completedRequests += 1;
    increment(this.counters.byStatusCode, String(statusCode));
    increment(this.counters.byOutcome, outcome);
    this.applySpecialCounters(statusCode, outcome, details);
    this.emit({
      event: "http_access",
      timestamp: new Date(this.options.nowMs()).toISOString(),
      requestId: context.requestId,
      method: context.method,
      path: context.path,
      route: context.route,
      statusCode,
      durationMs,
      outcome,
      ...(details.answerStatus === undefined ? {} : { answerStatus: details.answerStatus }),
      ...(details.runId === undefined ? {} : { runId: details.runId }),
      ...(details.traceId === undefined ? {} : { traceId: details.traceId }),
      ...(details.authResult === undefined ? {} : { authResult: details.authResult }),
      ...(details.errorName === undefined ? {} : { errorName: details.errorName })
    });
  }

  setReady(ready: boolean): void {
    this.readyState = ready;
    this.drainingState = !ready;
    if (!ready) {
      this.logLifecycle("server_draining", { reason: "readiness_disabled" });
    }
  }

  markDraining(reason: string): void {
    this.readyState = false;
    this.drainingState = true;
    this.logLifecycle("server_draining", { reason });
  }

  ready(): boolean {
    return this.readyState && !this.drainingState;
  }

  snapshot(): ProductionHttpMetricsSnapshot {
    const now = this.options.nowMs();
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: Math.max(0, now - this.startedAtMs),
      ready: this.ready(),
      draining: this.drainingState,
      totalRequests: this.counters.totalRequests,
      activeRequests: this.counters.activeRequests,
      completedRequests: this.counters.completedRequests,
      byStatusCode: mapToRecord(this.counters.byStatusCode),
      byRoute: mapToRecord(this.counters.byRoute),
      byOutcome: mapToRecord(this.counters.byOutcome),
      authDenied: this.counters.authDenied,
      rateLimited: this.counters.rateLimited,
      answerSucceeded: this.counters.answerSucceeded,
      answerRefused: this.counters.answerRefused,
      answerFailed: this.counters.answerFailed,
      requestErrors: this.counters.requestErrors,
      serverErrors: this.counters.serverErrors
    };
  }

  logLifecycle(
    event: ProductionHttpLifecycleLogEvent["event"],
    details: Omit<ProductionHttpLifecycleLogEvent, "event" | "timestamp">
  ): void {
    this.emit({
      event,
      timestamp: new Date(this.options.nowMs()).toISOString(),
      ...details
    });
  }

  private applySpecialCounters(
    statusCode: number,
    outcome: string,
    details: RequestCompletionDetails
  ): void {
    if (outcome === "auth_denied") {
      this.counters.authDenied += 1;
    }
    if (outcome === "rate_limited") {
      this.counters.rateLimited += 1;
    }
    if (details.answerStatus === "succeeded") {
      this.counters.answerSucceeded += 1;
    }
    if (details.answerStatus === "refused") {
      this.counters.answerRefused += 1;
    }
    if (details.answerStatus?.endsWith("_failed")) {
      this.counters.answerFailed += 1;
    }
    if (statusCode >= 400 && statusCode < 500) {
      this.counters.requestErrors += 1;
    }
    if (statusCode >= 500) {
      this.counters.serverErrors += 1;
    }
  }

  private emit(event: ProductionHttpLogEvent): void {
    if (this.options.config.operations.logMode === "disabled") {
      return;
    }

    const logger = this.options.logger ?? defaultOperationsLogger;
    try {
      logger(event);
    } catch {
      // Logging must never change request behavior.
    }
  }
}

function complete(
  response: ServerResponse,
  operations: ProductionHttpOperationsRuntime,
  context: RequestOperationContext,
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
  outcome: string,
  details: RequestCompletionDetails = {}
): void {
  writeJson(response, statusCode, body, {
    ...headers,
    [context.requestIdHeader]: context.requestId
  });
  operations.complete(context, statusCode, outcome, details);
}

function mergeHttpConfig(
  base: ProductionHttpConfig,
  override: Partial<ProductionHttpConfig> | undefined
): ProductionHttpConfig {
  return {
    host: override?.host ?? base.host,
    port: override?.port ?? base.port,
    maxBodyBytes: override?.maxBodyBytes ?? base.maxBodyBytes,
    auth: override?.auth ?? base.auth,
    rateLimit: override?.rateLimit ?? base.rateLimit,
    operations: override?.operations ?? base.operations
  };
}

function routeName(pathName: string, http: ProductionHttpConfig): string {
  if (pathName === "/health") {
    return "health";
  }
  if (pathName === http.operations.readinessPath) {
    return "ready";
  }
  if (pathName === http.operations.metricsPath) {
    return "metrics";
  }
  if (pathName === "/answer") {
    return "answer";
  }
  return "unknown";
}

function knownPath(pathName: string, http: ProductionHttpConfig): boolean {
  return (
    pathName === "/health" ||
    pathName === "/answer" ||
    pathName === http.operations.readinessPath ||
    pathName === http.operations.metricsPath
  );
}

function bearerToken(request: IncomingMessage, auth: ProductionHttpAuthConfig): string | undefined {
  const value = firstHeader(request, auth.headerName);
  if (value === undefined) {
    return undefined;
  }

  if (auth.headerName === "authorization") {
    const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
    return match?.[1]?.trim() || undefined;
  }

  return value.trim() || undefined;
}

function firstHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function clientIp(request: IncomingMessage, trustedHeader: string | undefined): string {
  if (trustedHeader !== undefined) {
    const header = firstHeader(request, trustedHeader);
    const forwardedIp = header?.split(",")[0]?.trim();
    if (forwardedIp) {
      return forwardedIp;
    }
  }

  return request.socket.remoteAddress ?? "unknown";
}

function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": String(Math.ceil(decision.resetAtMs / 1000)),
    ...(decision.allowed
      ? {}
      : { "retry-after": String(Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000))) })
  };
}

function requestIdFor(
  request: IncomingMessage,
  http: ProductionHttpConfig,
  fallback: () => string
): string {
  const headerValue = firstHeader(request, http.operations.requestIdHeader)?.trim();
  if (headerValue && /^[A-Za-z0-9._:-]{1,128}$/u.test(headerValue)) {
    return headerValue;
  }

  return fallback();
}

function safeFailureDetails(result: ProductionRagAnswerResponse): RequestCompletionDetails {
  if (!result.status.endsWith("_failed") || !isRecord(result.failure)) {
    return {};
  }

  const stage = typeof result.failure["stage"] === "string" ? result.failure["stage"] : undefined;
  return stage === undefined ? {} : { errorName: `failure_stage:${stage}` };
}

function errorOutcome(statusCode: number, error: unknown): string {
  if (error instanceof RequestBodyTooLargeError) {
    return "body_too_large";
  }
  if (error instanceof InvalidJsonBodyError) {
    return "invalid_json";
  }
  if (statusCode >= 500) {
    return "server_error";
  }
  return "request_error";
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRecord(map: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries(map.entries()) as Readonly<Record<string, number>>;
}

function defaultOperationsLogger(event: ProductionHttpLogEvent): void {
  console.log(JSON.stringify(event));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized)
  });
  response.end(serialized);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AddressInfo };
