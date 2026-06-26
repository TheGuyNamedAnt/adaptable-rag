import {
  alertDedupeKey,
  type AlertDeliveryAttempt,
  type AlertDeliverySink,
  type AlertDeliverySinkKind,
  type AlertDeliverySinkRequest,
  type AlertDeliverySinkResult
} from "../observability/alert-delivery.js";
import type { SloAlertEvent } from "../observability/slo.js";
import {
  mapProviderStatus,
  mapTransportError,
  redactText,
  type ProviderAdapterSecrets,
  type ProviderHttpResponse,
  type ProviderRetryPolicy,
  type ProviderTransport
} from "../shared/provider-boundary.js";

export type AlertWebhookFormat = "generic" | "slack" | "pagerduty_events_v2";

export interface AlertWebhookSinkOptions {
  readonly id: string;
  readonly endpoint: string;
  readonly format?: AlertWebhookFormat;
  readonly transport: ProviderTransport;
  readonly timeoutMs?: number;
  readonly retryPolicy?: ProviderRetryPolicy;
  readonly secrets?: ProviderAdapterSecrets;
  readonly pagerDutyRoutingKeyProvider?: () => string | Promise<string>;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class AlertWebhookSink implements AlertDeliverySink {
  readonly id: string;
  readonly kind: AlertDeliverySinkKind;

  private readonly endpoint: string;
  private readonly format: AlertWebhookFormat;
  private readonly transport: ProviderTransport;
  private readonly timeoutMs: number;
  private readonly retryPolicy: ProviderRetryPolicy;
  private readonly secrets: ProviderAdapterSecrets | undefined;
  private readonly pagerDutyRoutingKeyProvider: (() => string | Promise<string>) | undefined;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: AlertWebhookSinkOptions) {
    validateAlertWebhookOptions(options);
    this.id = options.id;
    this.endpoint = options.endpoint;
    this.format = options.format ?? "generic";
    this.kind = sinkKind(this.format);
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retryPolicy = options.retryPolicy ?? {
      maxRetries: 2,
      backoffMs: 250,
      retryStatusCodes: [408, 429, 500, 502, 503, 504]
    };
    this.secrets = options.secrets;
    this.pagerDutyRoutingKeyProvider = options.pagerDutyRoutingKeyProvider;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async deliver(request: AlertDeliverySinkRequest): Promise<AlertDeliverySinkResult> {
    const dedupeKeys = request.alerts.map(alertDedupeKey);
    if (request.alerts.length === 0) {
      return this.skipped(request, dedupeKeys, [
        "No alerts were present; webhook delivery skipped."
      ]);
    }

    if (request.mode === "dry_run") {
      return this.skipped(request, dedupeKeys, ["Dry-run mode skipped webhook delivery."]);
    }

    const secrets = await this.loadSecrets();
    const attempts: AlertDeliveryAttempt[] = [];
    const maxAttempts = this.retryPolicy.maxRetries + 1;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      try {
        const response = await this.transport.send({
          requestId: `${request.deliveryId}_${this.id}_${attemptNumber}`,
          url: this.endpoint,
          method: "POST",
          headers: this.headers(request, secrets.bearerToken),
          body: this.payload(request, dedupeKeys, secrets.pagerDutyRoutingKey),
          timeoutMs: this.timeoutMs
        });
        const mapped = mapProviderStatus(response);
        attempts.push(
          attemptTrace(attemptNumber, response, mapped?.retryable ?? false, mapped?.code)
        );

        if (!mapped) {
          return this.delivered(request, dedupeKeys, attempts);
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

    return this.failed(request, dedupeKeys, attempts, "Webhook delivery failed.");
  }

  private delivered(
    request: AlertDeliverySinkRequest,
    dedupeKeys: readonly string[],
    attempts: readonly AlertDeliveryAttempt[]
  ): AlertDeliverySinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "delivered",
      mode: request.mode,
      deliveredAlertCount: request.alerts.length,
      failedAlertCount: 0,
      skippedAlertCount: 0,
      attempts,
      dedupeKeys,
      warnings: [],
      errors: []
    };
  }

  private skipped(
    request: AlertDeliverySinkRequest,
    dedupeKeys: readonly string[],
    warnings: readonly string[]
  ): AlertDeliverySinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "skipped",
      mode: request.mode,
      deliveredAlertCount: 0,
      failedAlertCount: 0,
      skippedAlertCount: request.alerts.length,
      attempts: [],
      dedupeKeys,
      warnings,
      errors: []
    };
  }

  private failed(
    request: AlertDeliverySinkRequest,
    dedupeKeys: readonly string[],
    attempts: readonly AlertDeliveryAttempt[],
    message: string
  ): AlertDeliverySinkResult {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "failed",
      mode: request.mode,
      deliveredAlertCount: 0,
      failedAlertCount: request.alerts.length,
      skippedAlertCount: 0,
      attempts,
      dedupeKeys,
      warnings: [],
      errors: [message]
    };
  }

  private headers(
    request: AlertDeliverySinkRequest,
    bearerToken: string | undefined
  ): Readonly<Record<string, string>> {
    return {
      "content-type": "application/json",
      "x-request-id": `${request.deliveryId}_${this.id}`,
      ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` })
    };
  }

  private payload(
    request: AlertDeliverySinkRequest,
    dedupeKeys: readonly string[],
    pagerDutyRoutingKey: string | undefined
  ): unknown {
    switch (this.format) {
      case "generic":
        return genericPayload(this.id, request, dedupeKeys);
      case "slack":
        return slackPayload(request);
      case "pagerduty_events_v2":
        if (!pagerDutyRoutingKey) {
          throw new Error("PagerDuty routing key is required for pagerduty_events_v2 delivery.");
        }
        return pagerDutyPayload(request, dedupeKeys, pagerDutyRoutingKey);
    }
  }

  private async loadSecrets(): Promise<{
    readonly bearerToken?: string;
    readonly pagerDutyRoutingKey?: string;
    readonly values: readonly string[];
  }> {
    const bearerToken = this.secrets ? await this.secrets.apiKeyProvider() : undefined;
    const pagerDutyRoutingKey = this.pagerDutyRoutingKeyProvider
      ? await this.pagerDutyRoutingKeyProvider()
      : undefined;
    return {
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(pagerDutyRoutingKey === undefined ? {} : { pagerDutyRoutingKey }),
      values: [bearerToken, pagerDutyRoutingKey].filter((value): value is string => Boolean(value))
    };
  }
}

function validateAlertWebhookOptions(options: AlertWebhookSinkOptions): void {
  if (!options.id.trim()) {
    throw new Error("Alert webhook sink id is required.");
  }

  validateAlertEndpoint(options.endpoint);

  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error("Alert webhook timeoutMs must be an integer between 1 and 120000.");
  }

  const retryPolicy = options.retryPolicy ?? {
    maxRetries: 2,
    backoffMs: 250,
    retryStatusCodes: [408, 429, 500, 502, 503, 504]
  };
  if (options.format === "pagerduty_events_v2" && !options.pagerDutyRoutingKeyProvider) {
    throw new Error("PagerDuty routing key provider is required for pagerduty_events_v2 delivery.");
  }
  if (
    !Number.isInteger(retryPolicy.maxRetries) ||
    retryPolicy.maxRetries < 0 ||
    retryPolicy.maxRetries > 5
  ) {
    throw new Error("Alert webhook retryPolicy.maxRetries must be an integer between 0 and 5.");
  }
  if (
    !Number.isInteger(retryPolicy.backoffMs) ||
    retryPolicy.backoffMs < 0 ||
    retryPolicy.backoffMs > 30000
  ) {
    throw new Error("Alert webhook retryPolicy.backoffMs must be an integer between 0 and 30000.");
  }
}

function validateAlertEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Alert webhook endpoint must be a valid URL.");
  }

  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("Alert webhook endpoint must use https unless it targets localhost.");
  }

  if (!parsed.hostname.trim()) {
    throw new Error("Alert webhook endpoint must include a host.");
  }
}

function sinkKind(format: AlertWebhookFormat): AlertDeliverySinkKind {
  switch (format) {
    case "generic":
      return "webhook";
    case "slack":
      return "slack";
    case "pagerduty_events_v2":
      return "pagerduty";
  }
}

function attemptTrace(
  attempt: number,
  response: ProviderHttpResponse,
  retryable: boolean,
  errorCode?: AlertDeliveryAttempt["errorCode"]
): AlertDeliveryAttempt {
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

function genericPayload(
  sinkId: string,
  request: AlertDeliverySinkRequest,
  dedupeKeys: readonly string[]
): unknown {
  return {
    event: "rag_alert_delivery",
    deliveryId: request.deliveryId,
    generatedAt: request.generatedAt,
    sinkId,
    mode: request.mode,
    alertCount: request.alerts.length,
    alerts: request.alerts.map((alert, index) => ({
      ...deliveryAlert(alert),
      dedupeKey: dedupeKeys[index]
    }))
  };
}

function slackPayload(request: AlertDeliverySinkRequest): unknown {
  const highest = highestSeverity(request.alerts);
  return {
    text: `RAG SLO alerts: ${request.alerts.length} alert(s), highest severity ${highest}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*RAG SLO alerts*\\n${request.alerts.length} alert(s), highest severity *${highest}*.`
        }
      },
      ...request.alerts.slice(0, 10).map((alert) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${alert.severity.toUpperCase()}* \`${alert.ruleId}\` - ${alert.message}`
        }
      }))
    ]
  };
}

function pagerDutyPayload(
  request: AlertDeliverySinkRequest,
  dedupeKeys: readonly string[],
  routingKey: string
): unknown {
  const highest = highestSeverity(request.alerts);
  return {
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: dedupeKeys.join("|"),
    payload: {
      summary: `RAG SLO ${highest} alert: ${request.alerts.length} alert(s)`,
      severity: highest === "critical" ? "critical" : "error",
      source: "adaptable-rag",
      component: "rag-slo",
      group: "rag",
      class: "slo",
      custom_details: {
        deliveryId: request.deliveryId,
        generatedAt: request.generatedAt,
        alerts: request.alerts.map(deliveryAlert)
      }
    }
  };
}

function deliveryAlert(alert: SloAlertEvent): Record<string, unknown> {
  return {
    alertId: alert.alertId,
    generatedAt: alert.generatedAt,
    ruleId: alert.ruleId,
    ruleName: alert.ruleName,
    category: alert.category,
    severity: alert.severity,
    signalName: alert.signalName,
    ...(alert.observedValue === undefined ? {} : { observedValue: alert.observedValue }),
    comparator: alert.comparator,
    threshold: alert.threshold,
    message: alert.message,
    runbook: alert.runbook
  };
}

function highestSeverity(alerts: readonly SloAlertEvent[]): SloAlertEvent["severity"] | "none" {
  const order: Readonly<Record<SloAlertEvent["severity"], number>> = {
    info: 0,
    warning: 1,
    high: 2,
    critical: 3
  };
  return alerts.reduce<SloAlertEvent["severity"] | "none">((highest, alert) => {
    if (highest === "none") {
      return alert.severity;
    }
    return order[alert.severity] > order[highest] ? alert.severity : highest;
  }, "none");
}
