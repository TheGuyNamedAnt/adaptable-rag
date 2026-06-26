import {
  type ReviewTicketExternalRef,
  type ReviewTicketPayload,
  type ReviewTicketSyncAttempt,
  type ReviewTicketSyncSink,
  type ReviewTicketSyncSinkKind,
  type ReviewTicketSyncSinkRequest,
  type ReviewTicketSyncSinkResult
} from "../observability/review-ticket-sync.js";
import {
  mapProviderStatus,
  mapTransportError,
  redactText,
  type ProviderAdapterSecrets,
  type ProviderHttpResponse,
  type ProviderRetryPolicy,
  type ProviderTransport
} from "../shared/provider-boundary.js";

export interface ReviewTicketWebhookSinkOptions {
  readonly id: string;
  readonly endpoint: string;
  readonly transport: ProviderTransport;
  readonly timeoutMs?: number;
  readonly retryPolicy?: ProviderRetryPolicy;
  readonly secrets?: ProviderAdapterSecrets;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class ReviewTicketWebhookSink implements ReviewTicketSyncSink {
  readonly id: string;
  readonly kind: ReviewTicketSyncSinkKind = "webhook";

  private readonly endpoint: string;
  private readonly transport: ProviderTransport;
  private readonly timeoutMs: number;
  private readonly retryPolicy: ProviderRetryPolicy;
  private readonly secrets: ProviderAdapterSecrets | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ReviewTicketWebhookSinkOptions) {
    validateReviewTicketWebhookOptions(options);
    this.id = options.id;
    this.endpoint = options.endpoint;
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retryPolicy = options.retryPolicy ?? {
      maxRetries: 2,
      backoffMs: 250,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    };
    this.secrets = options.secrets;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async sync(request: ReviewTicketSyncSinkRequest): Promise<ReviewTicketSyncSinkResult> {
    const dedupeKeys = request.tickets.map((ticket) => ticket.dedupeKey);
    if (request.tickets.length === 0) {
      return this.skipped(request, dedupeKeys, [
        "No review tickets were present; webhook sync skipped."
      ]);
    }

    if (request.mode === "dry_run") {
      return this.skipped(request, dedupeKeys, [
        "Dry-run mode skipped review ticket webhook sync."
      ]);
    }

    const secrets = await this.loadSecrets();
    const attempts: ReviewTicketSyncAttempt[] = [];
    const maxAttempts = this.retryPolicy.maxRetries + 1;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      try {
        const response = await this.transport.send({
          requestId: `${request.syncId}_${this.id}_${attemptNumber}`,
          url: this.endpoint,
          method: "POST",
          headers: this.headers(request, secrets.bearerToken),
          body: webhookPayload(this.id, request),
          timeoutMs: this.timeoutMs
        });
        const mapped = mapProviderStatus(response);
        attempts.push(
          attemptTrace(attemptNumber, response, mapped?.retryable ?? false, mapped?.code)
        );

        if (!mapped) {
          return this.synced(
            request,
            dedupeKeys,
            attempts,
            externalRefs(response, request.tickets)
          );
        }

        if (
          !shouldRetry(
            attemptNumber,
            maxAttempts,
            response.status,
            mapped.retryable,
            this.retryPolicy
          )
        ) {
          return this.failed(
            request,
            dedupeKeys,
            attempts,
            redactText(mapped.message, secrets.values)
          );
        }
      } catch (error) {
        const mapped = mapTransportError(error);
        attempts.push({
          attempt: attemptNumber,
          latencyMs: 0,
          errorCode: mapped.code,
          retryable: mapped.retryable
        });

        if (
          !shouldRetry(
            attemptNumber,
            maxAttempts,
            mapped.status,
            mapped.retryable,
            this.retryPolicy
          )
        ) {
          return this.failed(
            request,
            dedupeKeys,
            attempts,
            redactText(mapped.message, secrets.values)
          );
        }
      }

      await this.sleep(this.retryPolicy.backoffMs);
    }

    return this.failed(request, dedupeKeys, attempts, "Review ticket webhook sync failed.");
  }

  private synced(
    request: ReviewTicketSyncSinkRequest,
    dedupeKeys: readonly string[],
    attempts: readonly ReviewTicketSyncAttempt[],
    externalRefs: readonly ReviewTicketExternalRef[]
  ): ReviewTicketSyncSinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "synced",
      mode: request.mode,
      syncedTicketCount: request.tickets.length,
      failedTicketCount: 0,
      skippedTicketCount: 0,
      attempts,
      dedupeKeys,
      externalIds: externalRefs.map((ref) => ref.externalId),
      externalRefs,
      warnings: [],
      errors: []
    };
  }

  private skipped(
    request: ReviewTicketSyncSinkRequest,
    dedupeKeys: readonly string[],
    warnings: readonly string[]
  ): ReviewTicketSyncSinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "skipped",
      mode: request.mode,
      syncedTicketCount: 0,
      failedTicketCount: 0,
      skippedTicketCount: request.tickets.length,
      attempts: [],
      dedupeKeys,
      externalIds: [],
      externalRefs: [],
      warnings,
      errors: []
    };
  }

  private failed(
    request: ReviewTicketSyncSinkRequest,
    dedupeKeys: readonly string[],
    attempts: readonly ReviewTicketSyncAttempt[],
    message: string
  ): ReviewTicketSyncSinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "failed",
      mode: request.mode,
      syncedTicketCount: 0,
      failedTicketCount: request.tickets.length,
      skippedTicketCount: 0,
      attempts,
      dedupeKeys,
      externalIds: [],
      externalRefs: [],
      warnings: [],
      errors: [message]
    };
  }

  private headers(
    request: ReviewTicketSyncSinkRequest,
    bearerToken: string | undefined
  ): Readonly<Record<string, string>> {
    return {
      "content-type": "application/json",
      "x-request-id": `${request.syncId}_${this.id}`,
      ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` })
    };
  }

  private async loadSecrets(): Promise<{
    readonly bearerToken?: string;
    readonly values: readonly string[];
  }> {
    const bearerToken = this.secrets ? await this.secrets.apiKeyProvider() : undefined;
    return {
      ...(bearerToken === undefined ? {} : { bearerToken }),
      values: [bearerToken].filter((value): value is string => Boolean(value))
    };
  }
}

function validateReviewTicketWebhookOptions(options: ReviewTicketWebhookSinkOptions): void {
  if (!options.id.trim()) {
    throw new Error("Review ticket webhook sink id is required.");
  }

  validateReviewTicketEndpoint(options.endpoint);

  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error("Review ticket webhook timeoutMs must be an integer between 1 and 120000.");
  }

  const retryPolicy = options.retryPolicy ?? {
    maxRetries: 2,
    backoffMs: 250,
    retryStatusCodes: [408, 429, 500, 502, 503, 504]
  };
  if (
    !Number.isInteger(retryPolicy.maxRetries) ||
    retryPolicy.maxRetries < 0 ||
    retryPolicy.maxRetries > 5
  ) {
    throw new Error(
      "Review ticket webhook retryPolicy.maxRetries must be an integer between 0 and 5."
    );
  }
  if (
    !Number.isInteger(retryPolicy.backoffMs) ||
    retryPolicy.backoffMs < 0 ||
    retryPolicy.backoffMs > 30000
  ) {
    throw new Error(
      "Review ticket webhook retryPolicy.backoffMs must be an integer between 0 and 30000."
    );
  }
}

function validateReviewTicketEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Review ticket webhook endpoint must be a valid URL.");
  }

  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("Review ticket webhook endpoint must use https unless it targets localhost.");
  }

  if (!parsed.hostname.trim()) {
    throw new Error("Review ticket webhook endpoint must include a host.");
  }
}

function attemptTrace(
  attempt: number,
  response: ProviderHttpResponse,
  retryable: boolean,
  errorCode?: ReviewTicketSyncAttempt["errorCode"]
): ReviewTicketSyncAttempt {
  return {
    attempt,
    status: response.status,
    latencyMs: response.latencyMs,
    ...(errorCode === undefined ? {} : { errorCode }),
    retryable
  };
}

function shouldRetry(
  attempt: number,
  maxAttempts: number,
  status: number | undefined,
  retryable: boolean,
  retryPolicy: ProviderRetryPolicy
): boolean {
  if (attempt >= maxAttempts || !retryable) {
    return false;
  }

  return status === undefined || retryPolicy.retryStatusCodes.includes(status);
}

function webhookPayload(sinkId: string, request: ReviewTicketSyncSinkRequest): unknown {
  return {
    event: "rag_review_ticket_sync",
    syncId: request.syncId,
    generatedAt: request.generatedAt,
    sinkId,
    mode: request.mode,
    ticketCount: request.tickets.length,
    tickets: request.tickets.map(ticketPayload)
  };
}

function ticketPayload(ticket: ReviewTicketPayload): Record<string, unknown> {
  return {
    payloadId: ticket.payloadId,
    kind: ticket.kind,
    operation: ticket.operation,
    dedupeKey: ticket.dedupeKey,
    title: ticket.title,
    body: ticket.body,
    priority: ticket.priority,
    status: ticket.status,
    source: ticket.source,
    ...(ticket.destination === undefined ? {} : { destination: ticket.destination }),
    labels: ticket.labels,
    artifactPaths: ticket.artifactPaths,
    metadata: ticket.metadata
  };
}

function externalRefs(
  response: ProviderHttpResponse,
  tickets: readonly ReviewTicketPayload[]
): readonly ReviewTicketExternalRef[] {
  const body = response.body;
  if (typeof body !== "object" || body === null) {
    return [];
  }

  if ("externalRefs" in body && Array.isArray(body.externalRefs)) {
    return body.externalRefs.flatMap((entry): readonly ReviewTicketExternalRef[] => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      if (
        !("dedupeKey" in entry) ||
        typeof entry.dedupeKey !== "string" ||
        !("externalId" in entry) ||
        typeof entry.externalId !== "string"
      ) {
        return [];
      }
      return [
        {
          dedupeKey: entry.dedupeKey,
          externalId: entry.externalId,
          ...("url" in entry && typeof entry.url === "string" ? { url: entry.url } : {}),
          ...("status" in entry && typeof entry.status === "string"
            ? { status: entry.status }
            : {}),
          ...("syncedAt" in entry && typeof entry.syncedAt === "string"
            ? { syncedAt: entry.syncedAt }
            : {})
        }
      ];
    });
  }

  if (
    "externalIds" in body &&
    Array.isArray(body.externalIds) &&
    body.externalIds.every((value) => typeof value === "string")
  ) {
    return body.externalIds.flatMap((externalId, index): readonly ReviewTicketExternalRef[] => {
      const ticket = tickets[index];
      if (!ticket) {
        return [];
      }
      return [
        {
          dedupeKey: ticket.dedupeKey,
          externalId
        }
      ];
    });
  }

  if (
    tickets.length === 1 &&
    "id" in body &&
    typeof body.id === "string" &&
    body.id.trim().length > 0
  ) {
    const ticket = tickets[0];
    if (!ticket) {
      return [];
    }
    return [
      {
        dedupeKey: ticket.dedupeKey,
        externalId: body.id
      }
    ];
  }

  return [];
}
