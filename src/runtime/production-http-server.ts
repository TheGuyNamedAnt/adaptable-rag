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
import {
  PrincipalResolutionError,
  verifySignedPrincipalPayload
} from "../security/principal-resolver.js";

const MAX_LATENCY_SAMPLES = 1_000;

export interface ProductionRagHttpServerOptions {
  readonly app: ProductionRagApp;
  readonly http?: Partial<ProductionHttpConfig>;
  readonly readiness?: ProductionHttpReadinessOptions;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly logger?: ProductionHttpOperationsLogger;
}

export interface ProductionHttpReadinessOptions {
  readonly mode?: "flag" | "self_test";
  readonly probeProviders?: boolean;
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
  readonly byAnswerStatus: Readonly<Record<string, number>>;
  readonly latencyMs: ProductionHttpLatencySummary;
  readonly byRouteLatencyMs: Readonly<Record<string, ProductionHttpLatencySummary>>;
  readonly authDenied: number;
  readonly rateLimited: number;
  readonly answerSucceeded: number;
  readonly answerRefused: number;
  readonly answerFailed: number;
  readonly requestErrors: number;
  readonly serverErrors: number;
  readonly rag: ProductionRagHttpMetricsSnapshot;
}

export interface ProductionHttpLatencySummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface ProductionRagHttpMetricsSnapshot {
  readonly answerCount: number;
  readonly retrievedChunkCount: number;
  readonly rejectedRetrievalCount: number;
  readonly citationCount: number;
  readonly lowCitationAnswerCount: number;
  readonly noEvidenceAnswerCount: number;
  readonly humanReviewRequiredCount: number;
  readonly byEvidenceStatus: Readonly<Record<string, number>>;
  readonly byProfile: Readonly<Record<string, number>>;
  readonly byNamespace: Readonly<Record<string, number>>;
  readonly byTenantHash: Readonly<Record<string, number>>;
  readonly modelPromptTokens: number;
  readonly modelCompletionTokens: number;
  readonly modelTotalTokens: number;
  readonly estimatedCostUsd: number;
  readonly retrievalLatencyMs: ProductionHttpLatencySummary;
  readonly contextLatencyMs: ProductionHttpLatencySummary;
  readonly generationLatencyMs: ProductionHttpLatencySummary;
  readonly modelLatencyMs: ProductionHttpLatencySummary;
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
  readonly answerTelemetry?: ProductionAnswerTelemetry;
}

interface ProductionAnswerTelemetry {
  readonly profileId?: string;
  readonly namespaceId?: string;
  readonly tenantHash?: string;
  readonly retrievedChunkCount: number;
  readonly rejectedRetrievalCount: number;
  readonly citationCount: number;
  readonly evidenceStatus?: string;
  readonly modelPromptTokens: number;
  readonly modelCompletionTokens: number;
  readonly modelTotalTokens: number;
  readonly estimatedCostUsd: number;
  readonly retrievalLatencyMs?: number;
  readonly contextLatencyMs?: number;
  readonly generationLatencyMs?: number;
  readonly modelLatencyMs?: number;
}

interface ReadinessResponse {
  readonly statusCode: number;
  readonly body: unknown;
  readonly outcome: string;
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
    void handleProductionRagHttpRequest(
      options.app,
      request,
      response,
      http,
      edge,
      operations,
      options.readiness
    );
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
  }),
  readiness: ProductionHttpReadinessOptions = {}
): Promise<void> {
  let context: RequestOperationContext | undefined;
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    context = operations.begin(request, url.pathname, routeName(url.pathname, http));

    if (request.method === "GET" && url.pathname === "/health") {
      complete(response, operations, context, 200, await productionAppHealth(app), {}, "health");
      return;
    }

    if (request.method === "GET" && url.pathname === http.operations.readinessPath) {
      const result = await readinessResponse(app, operations, readiness);
      complete(response, operations, context, result.statusCode, result.body, {}, result.outcome);
      return;
    }

    if (request.method === "GET" && url.pathname === http.operations.metricsPath) {
      const metrics = operations.snapshot();
      if (url.searchParams.get("format") === "prometheus") {
        writeText(response, 200, renderPrometheusMetrics(metrics), {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          [context.requestIdHeader]: context.requestId
        });
        operations.complete(context, 200, "metrics", {});
        return;
      }

      complete(response, operations, context, 200, metrics, {}, "metrics");
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

      const body = resolveHttpAnswerPrincipal(
        (await readJsonBody(request, http.maxBodyBytes)) as ProductionRagAnswerInput,
        request,
        http,
        app.profile.namespaceId,
        () => edge.currentTimeMs()
      );
      const result = await app.answer(body);
      complete(response, operations, context, 200, result, rateLimitHeaders(rateLimit), "answer", {
        answerStatus: result.status,
        runId: result.trace.runId,
        traceId: result.trace.traceId,
        authResult: http.auth.mode === "disabled" ? "disabled" : "passed",
        answerTelemetry: answerTelemetry(result, body),
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

function resolveHttpAnswerPrincipal(
  input: ProductionRagAnswerInput,
  request: IncomingMessage,
  http: ProductionHttpConfig,
  defaultNamespaceId: string,
  nowMs: () => number
): ProductionRagAnswerInput {
  if (http.principal?.mode !== "signed_header") {
    return input;
  }

  const record = asRecord(input);
  if (!record) {
    throw new ProductionRagRequestError("Answer request must be a JSON object.");
  }

  const tenantId = stringField(record, "tenantId");
  if (tenantId === undefined) {
    throw new ProductionRagRequestError("tenantId must be a non-empty string.");
  }
  const namespaceId = stringField(record, "namespaceId") ?? defaultNamespaceId;
  const payload = firstHeader(request, http.principal.headerName);
  const signature = firstHeader(request, http.principal.signatureHeaderName);
  if (payload === undefined || signature === undefined) {
    throw new ProductionRagRequestError("Signed principal headers are required.", 401);
  }

  try {
    const principal = verifySignedPrincipalPayload({
      payload,
      signature,
      secrets: http.principal.signingSecrets,
      context: { tenantId, namespaceId },
      verification: {
        ...(http.principal.maxAgeMs === undefined ? {} : { maxAgeMs: http.principal.maxAgeMs }),
        ...(http.principal.clockSkewMs === undefined
          ? {}
          : { clockSkewMs: http.principal.clockSkewMs }),
        ...(http.principal.issuer === undefined ? {} : { expectedIssuer: http.principal.issuer }),
        nowMs
      }
    });
    return {
      ...record,
      principal
    } as ProductionRagAnswerInput;
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      throw new ProductionRagRequestError(error.message, error.statusCode);
    }
    throw error;
  }
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

  currentTimeMs(): number {
    return this.nowMs();
  }

  clientKey(request: IncomingMessage): string {
    return `ip:${clientIp(request, this.http.rateLimit.clientIpHeader)}`;
  }
}

async function readinessResponse(
  app: ProductionRagApp,
  operations: ProductionHttpOperationsRuntime,
  options: ProductionHttpReadinessOptions
): Promise<ReadinessResponse> {
  if (!operations.ready()) {
    return {
      statusCode: 503,
      body: {
        status: "draining",
        ready: false
      },
      outcome: "not_ready"
    };
  }

  if (options.mode !== "self_test") {
    return {
      statusCode: 200,
      body: {
        status: "ready",
        ready: true,
        health: await productionAppHealth(app)
      },
      outcome: "ready"
    };
  }

  const selfTest = await app.selfTest({
    probeProviders: options.probeProviders === true
  });
  const ready = selfTest.status === "passed";
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? "ready" : "not_ready",
      ready,
      health: await productionAppHealth(app),
      selfTest
    },
    outcome: ready ? "ready" : "not_ready"
  };
}

async function productionAppHealth(
  app: ProductionRagApp
): Promise<ReturnType<ProductionRagApp["health"]>> {
  return app.healthAsync === undefined ? app.health() : app.healthAsync();
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
    byAnswerStatus: new Map<string, number>(),
    authDenied: 0,
    rateLimited: 0,
    answerSucceeded: 0,
    answerRefused: 0,
    answerFailed: 0,
    requestErrors: 0,
    serverErrors: 0
  };
  private readonly durationsMs: number[] = [];
  private readonly routeDurationsMs = new Map<string, number[]>();
  private readonly rag = {
    answerCount: 0,
    retrievedChunkCount: 0,
    rejectedRetrievalCount: 0,
    citationCount: 0,
    lowCitationAnswerCount: 0,
    noEvidenceAnswerCount: 0,
    humanReviewRequiredCount: 0,
    byEvidenceStatus: new Map<string, number>(),
    byProfile: new Map<string, number>(),
    byNamespace: new Map<string, number>(),
    byTenantHash: new Map<string, number>(),
    modelPromptTokens: 0,
    modelCompletionTokens: 0,
    modelTotalTokens: 0,
    estimatedCostUsd: 0,
    retrievalLatencyMs: [] as number[],
    contextLatencyMs: [] as number[],
    generationLatencyMs: [] as number[],
    modelLatencyMs: [] as number[]
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
    recordDuration(this.durationsMs, durationMs);
    recordDurationForRoute(this.routeDurationsMs, context.route, durationMs);
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
      byAnswerStatus: mapToRecord(this.counters.byAnswerStatus),
      latencyMs: latencySummary(this.durationsMs),
      byRouteLatencyMs: routeLatencySummary(this.routeDurationsMs),
      authDenied: this.counters.authDenied,
      rateLimited: this.counters.rateLimited,
      answerSucceeded: this.counters.answerSucceeded,
      answerRefused: this.counters.answerRefused,
      answerFailed: this.counters.answerFailed,
      requestErrors: this.counters.requestErrors,
      serverErrors: this.counters.serverErrors,
      rag: {
        answerCount: this.rag.answerCount,
        retrievedChunkCount: this.rag.retrievedChunkCount,
        rejectedRetrievalCount: this.rag.rejectedRetrievalCount,
        citationCount: this.rag.citationCount,
        lowCitationAnswerCount: this.rag.lowCitationAnswerCount,
        noEvidenceAnswerCount: this.rag.noEvidenceAnswerCount,
        humanReviewRequiredCount: this.rag.humanReviewRequiredCount,
        byEvidenceStatus: mapToRecord(this.rag.byEvidenceStatus),
        byProfile: mapToRecord(this.rag.byProfile),
        byNamespace: mapToRecord(this.rag.byNamespace),
        byTenantHash: mapToRecord(this.rag.byTenantHash),
        modelPromptTokens: this.rag.modelPromptTokens,
        modelCompletionTokens: this.rag.modelCompletionTokens,
        modelTotalTokens: this.rag.modelTotalTokens,
        estimatedCostUsd: roundMetric(this.rag.estimatedCostUsd),
        retrievalLatencyMs: latencySummary(this.rag.retrievalLatencyMs),
        contextLatencyMs: latencySummary(this.rag.contextLatencyMs),
        generationLatencyMs: latencySummary(this.rag.generationLatencyMs),
        modelLatencyMs: latencySummary(this.rag.modelLatencyMs)
      }
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
    if (details.answerStatus !== undefined) {
      increment(this.counters.byAnswerStatus, details.answerStatus);
    }
    if (details.answerTelemetry !== undefined) {
      this.applyAnswerTelemetry(details.answerStatus, details.answerTelemetry);
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

  private applyAnswerTelemetry(
    status: ProductionRagAnswerResponse["status"] | undefined,
    telemetry: ProductionAnswerTelemetry
  ): void {
    this.rag.answerCount += 1;
    this.rag.retrievedChunkCount += telemetry.retrievedChunkCount;
    this.rag.rejectedRetrievalCount += telemetry.rejectedRetrievalCount;
    this.rag.citationCount += telemetry.citationCount;
    this.rag.modelPromptTokens += telemetry.modelPromptTokens;
    this.rag.modelCompletionTokens += telemetry.modelCompletionTokens;
    this.rag.modelTotalTokens += telemetry.modelTotalTokens;
    this.rag.estimatedCostUsd += telemetry.estimatedCostUsd;
    if (telemetry.citationCount === 0 && status !== "retrieval_failed") {
      this.rag.lowCitationAnswerCount += 1;
    }
    if (status === "human_review_required") {
      this.rag.humanReviewRequiredCount += 1;
    }
    if (telemetry.evidenceStatus !== undefined) {
      increment(this.rag.byEvidenceStatus, telemetry.evidenceStatus);
      if (telemetry.evidenceStatus === "no_evidence") {
        this.rag.noEvidenceAnswerCount += 1;
      }
    }
    if (telemetry.profileId !== undefined) {
      increment(this.rag.byProfile, telemetry.profileId);
    }
    if (telemetry.namespaceId !== undefined) {
      increment(this.rag.byNamespace, telemetry.namespaceId);
    }
    if (telemetry.tenantHash !== undefined) {
      increment(this.rag.byTenantHash, telemetry.tenantHash);
    }
    if (telemetry.retrievalLatencyMs !== undefined) {
      recordDuration(this.rag.retrievalLatencyMs, telemetry.retrievalLatencyMs);
    }
    if (telemetry.contextLatencyMs !== undefined) {
      recordDuration(this.rag.contextLatencyMs, telemetry.contextLatencyMs);
    }
    if (telemetry.generationLatencyMs !== undefined) {
      recordDuration(this.rag.generationLatencyMs, telemetry.generationLatencyMs);
    }
    if (telemetry.modelLatencyMs !== undefined) {
      recordDuration(this.rag.modelLatencyMs, telemetry.modelLatencyMs);
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

function recordDuration(values: number[], durationMs: number): void {
  values.push(durationMs);
  if (values.length > MAX_LATENCY_SAMPLES) {
    values.splice(0, values.length - MAX_LATENCY_SAMPLES);
  }
}

function recordDurationForRoute(
  routes: Map<string, number[]>,
  route: string,
  durationMs: number
): void {
  const values = routes.get(route) ?? [];
  recordDuration(values, durationMs);
  routes.set(route, values);
}

function latencySummary(values: readonly number[]): ProductionHttpLatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: roundMetric(sum / sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function routeLatencySummary(
  routes: ReadonlyMap<string, readonly number[]>
): Readonly<Record<string, ProductionHttpLatencySummary>> {
  const result: Record<string, ProductionHttpLatencySummary> = {};
  for (const [route, values] of routes) {
    result[route] = latencySummary(values);
  }
  return result;
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return roundMetric(sortedValues[index] ?? 0);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function answerTelemetry(
  result: ProductionRagAnswerResponse,
  input: ProductionRagAnswerInput
): ProductionAnswerTelemetry {
  const retrievalTrace = asRecord(result.retrieval?.trace);
  const contextTrace = asRecord(result.context?.trace);
  const generationTrace = asRecord(result.generation?.trace);
  const modelTrace = asRecord(generationTrace?.["model"]);
  const evidence = asRecord(result.context?.evidence);
  const evidenceStatus = stringField(evidence, "status");
  const tenantId = typeof input.tenantId === "string" ? input.tenantId : undefined;
  return {
    profileId: result.trace.profileId,
    namespaceId: result.trace.namespaceId,
    ...(tenantId === undefined ? {} : { tenantHash: sha256Hex(tenantId) }),
    retrievedChunkCount: numberField(retrievalTrace, "returnedCount") ?? 0,
    rejectedRetrievalCount: numberField(retrievalTrace, "rejectedCount") ?? 0,
    citationCount: result.citations?.length ?? result.citationChunkIds?.length ?? 0,
    ...(evidenceStatus === undefined ? {} : { evidenceStatus }),
    modelPromptTokens: numberField(modelTrace, "promptTokens") ?? 0,
    modelCompletionTokens: numberField(modelTrace, "completionTokens") ?? 0,
    modelTotalTokens: numberField(modelTrace, "totalTokens") ?? 0,
    estimatedCostUsd: numberField(modelTrace, "estimatedCostUsd") ?? 0,
    ...optionalMetric("retrievalLatencyMs", durationBetweenTraceDates(retrievalTrace)),
    ...optionalMetric("contextLatencyMs", durationBetweenTraceDates(contextTrace)),
    ...optionalMetric("generationLatencyMs", durationBetweenTraceDates(generationTrace)),
    ...optionalMetric("modelLatencyMs", numberField(modelTrace, "latencyMs"))
  };
}

function optionalMetric<TKey extends string>(
  key: TKey,
  value: number | undefined
): { readonly [K in TKey]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [K in TKey]?: number };
}

function durationBetweenTraceDates(
  trace: Readonly<Record<string, unknown>> | undefined
): number | undefined {
  const startedAt = stringField(trace, "startedAt");
  const finishedAt = stringField(trace, "finishedAt");
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }

  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return undefined;
  }

  return Math.max(0, finished - started);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function numberField(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function renderPrometheusMetrics(metrics: ProductionHttpMetricsSnapshot): string {
  const lines: string[] = [
    prometheusMetric("rag_http_requests_total", metrics.totalRequests),
    prometheusMetric("rag_http_active_requests", metrics.activeRequests),
    prometheusMetric("rag_http_auth_denied_total", metrics.authDenied),
    prometheusMetric("rag_http_rate_limited_total", metrics.rateLimited),
    prometheusMetric("rag_http_server_errors_total", metrics.serverErrors),
    prometheusMetric("rag_http_request_errors_total", metrics.requestErrors),
    prometheusMetric("rag_http_latency_ms_p50", metrics.latencyMs.p50),
    prometheusMetric("rag_http_latency_ms_p95", metrics.latencyMs.p95),
    prometheusMetric("rag_http_latency_ms_p99", metrics.latencyMs.p99),
    prometheusMetric("rag_answers_total", metrics.rag.answerCount),
    prometheusMetric("rag_retrieved_chunks_total", metrics.rag.retrievedChunkCount),
    prometheusMetric("rag_rejected_retrievals_total", metrics.rag.rejectedRetrievalCount),
    prometheusMetric("rag_citations_total", metrics.rag.citationCount),
    prometheusMetric("rag_low_citation_answers_total", metrics.rag.lowCitationAnswerCount),
    prometheusMetric("rag_no_evidence_answers_total", metrics.rag.noEvidenceAnswerCount),
    prometheusMetric("rag_human_review_required_total", metrics.rag.humanReviewRequiredCount),
    prometheusMetric("rag_model_prompt_tokens_total", metrics.rag.modelPromptTokens),
    prometheusMetric("rag_model_completion_tokens_total", metrics.rag.modelCompletionTokens),
    prometheusMetric("rag_model_total_tokens_total", metrics.rag.modelTotalTokens),
    prometheusMetric("rag_estimated_cost_usd_total", metrics.rag.estimatedCostUsd),
    prometheusMetric("rag_model_latency_ms_p95", metrics.rag.modelLatencyMs.p95)
  ];

  for (const [route, count] of Object.entries(metrics.byRoute)) {
    lines.push(prometheusMetric("rag_http_route_requests_total", count, { route }));
  }
  for (const [status, count] of Object.entries(metrics.byAnswerStatus)) {
    lines.push(prometheusMetric("rag_answer_status_total", count, { status }));
  }
  for (const [status, count] of Object.entries(metrics.rag.byEvidenceStatus)) {
    lines.push(prometheusMetric("rag_context_evidence_status_total", count, { status }));
  }
  for (const [profile, count] of Object.entries(metrics.rag.byProfile)) {
    lines.push(prometheusMetric("rag_answers_by_profile_total", count, { profile }));
  }
  for (const [namespace, count] of Object.entries(metrics.rag.byNamespace)) {
    lines.push(prometheusMetric("rag_answers_by_namespace_total", count, { namespace }));
  }
  for (const [tenantHash, count] of Object.entries(metrics.rag.byTenantHash)) {
    lines.push(prometheusMetric("rag_answers_by_tenant_hash_total", count, { tenantHash }));
  }

  return `${lines.join("\n")}\n`;
}

function prometheusMetric(
  name: string,
  value: number,
  labels: Readonly<Record<string, string>> = {}
): string {
  const labelEntries = Object.entries(labels);
  const renderedLabels =
    labelEntries.length === 0
      ? ""
      : `{${labelEntries
          .map(([key, labelValue]) => `${key}="${escapePrometheusLabel(labelValue)}"`)
          .join(",")}}`;
  return `${name}${renderedLabels} ${Number.isFinite(value) ? value : 0}`;
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
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
  const principal = override?.principal ?? base.principal;
  return {
    host: override?.host ?? base.host,
    port: override?.port ?? base.port,
    maxBodyBytes: override?.maxBodyBytes ?? base.maxBodyBytes,
    auth: override?.auth ?? base.auth,
    ...(principal === undefined ? {} : { principal }),
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

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, {
    ...headers,
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AddressInfo };
