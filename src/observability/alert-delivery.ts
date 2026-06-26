import type { SloAlertEvent } from "./slo.js";

export const ALERT_DELIVERY_SCHEMA_VERSION = 1;

export type AlertDeliveryMode = "dry_run" | "live";
export type AlertDeliveryReportStatus = "passed" | "failed";
export type AlertDeliverySinkStatus = "delivered" | "failed" | "skipped";
export type AlertDeliverySinkKind = "dry_run" | "webhook" | "slack" | "pagerduty" | "custom";
export type AlertDeliveryErrorCode =
  | "auth_error"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_response"
  | "invalid_configuration";

export interface AlertDeliveryAttempt {
  readonly attempt: number;
  readonly status?: number;
  readonly latencyMs: number;
  readonly errorCode?: AlertDeliveryErrorCode;
  readonly retryable: boolean;
}

export interface AlertDeliverySinkRequest {
  readonly deliveryId: string;
  readonly generatedAt: string;
  readonly mode: AlertDeliveryMode;
  readonly alerts: readonly SloAlertEvent[];
}

export interface AlertDeliverySinkResult {
  readonly sinkId: string;
  readonly kind: AlertDeliverySinkKind;
  readonly status: AlertDeliverySinkStatus;
  readonly mode: AlertDeliveryMode;
  readonly deliveredAlertCount: number;
  readonly failedAlertCount: number;
  readonly skippedAlertCount: number;
  readonly attempts: readonly AlertDeliveryAttempt[];
  readonly dedupeKeys: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface AlertDeliverySink {
  readonly id: string;
  readonly kind: AlertDeliverySinkKind;
  deliver(request: AlertDeliverySinkRequest): Promise<AlertDeliverySinkResult>;
}

export interface DeliverAlertsRequest {
  readonly alerts: readonly SloAlertEvent[];
  readonly sinks: readonly AlertDeliverySink[];
  readonly mode: AlertDeliveryMode;
  readonly generatedAt?: string;
  readonly deliveryId?: string;
  readonly requireSink?: boolean;
}

export interface AlertDeliveryReport {
  readonly schemaVersion: typeof ALERT_DELIVERY_SCHEMA_VERSION;
  readonly deliveryId: string;
  readonly generatedAt: string;
  readonly mode: AlertDeliveryMode;
  readonly status: AlertDeliveryReportStatus;
  readonly alertCount: number;
  readonly sinkCount: number;
  readonly deliveredSinkCount: number;
  readonly failedSinkCount: number;
  readonly skippedSinkCount: number;
  readonly deliveredAlertCount: number;
  readonly failedAlertCount: number;
  readonly skippedAlertCount: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly results: readonly AlertDeliverySinkResult[];
}

export interface DryRunAlertDeliverySinkOptions {
  readonly id?: string;
  readonly kind?: AlertDeliverySinkKind;
}

export class DryRunAlertDeliverySink implements AlertDeliverySink {
  readonly id: string;
  readonly kind: AlertDeliverySinkKind;

  constructor(options: DryRunAlertDeliverySinkOptions = {}) {
    this.id = options.id ?? "dry_run";
    this.kind = options.kind ?? "dry_run";
  }

  async deliver(request: AlertDeliverySinkRequest): Promise<AlertDeliverySinkResult> {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: "skipped",
      mode: request.mode,
      deliveredAlertCount: 0,
      failedAlertCount: 0,
      skippedAlertCount: request.alerts.length,
      attempts: [],
      dedupeKeys: request.alerts.map(alertDedupeKey),
      warnings:
        request.alerts.length === 0
          ? ["No alerts were present; dry-run delivery skipped."]
          : ["Dry-run mode recorded alerts without sending them."],
      errors: []
    };
  }
}

export async function deliverAlerts(request: DeliverAlertsRequest): Promise<AlertDeliveryReport> {
  const generatedAt = request.generatedAt ?? new Date().toISOString();
  const deliveryId = request.deliveryId ?? `alert_delivery_${safeTimestamp(generatedAt)}`;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (request.sinks.length === 0 && request.requireSink === true) {
    errors.push("At least one alert delivery sink is required.");
  }

  const results: AlertDeliverySinkResult[] = [];
  for (const sink of request.sinks) {
    try {
      results.push(
        await sink.deliver({
          deliveryId,
          generatedAt,
          mode: request.mode,
          alerts: request.alerts
        })
      );
    } catch (error) {
      results.push(failedSinkResult(sink, request, error));
    }
  }

  warnings.push(...results.flatMap((result) => result.warnings));
  errors.push(...results.flatMap((result) => result.errors));

  const failedSinkCount = results.filter((result) => result.status === "failed").length;
  return {
    schemaVersion: ALERT_DELIVERY_SCHEMA_VERSION,
    deliveryId,
    generatedAt,
    mode: request.mode,
    status: errors.length > 0 || failedSinkCount > 0 ? "failed" : "passed",
    alertCount: request.alerts.length,
    sinkCount: request.sinks.length,
    deliveredSinkCount: results.filter((result) => result.status === "delivered").length,
    failedSinkCount,
    skippedSinkCount: results.filter((result) => result.status === "skipped").length,
    deliveredAlertCount: sum(results.map((result) => result.deliveredAlertCount)),
    failedAlertCount: sum(results.map((result) => result.failedAlertCount)),
    skippedAlertCount: sum(results.map((result) => result.skippedAlertCount)),
    warnings: uniqueSorted(warnings),
    errors: uniqueSorted(errors),
    results
  };
}

export function alertDedupeKey(alert: SloAlertEvent): string {
  return [
    "rag_slo_alert",
    alert.ruleId,
    alert.category,
    alert.severity,
    alert.signalName,
    String(alert.threshold)
  ]
    .map(safeKeyPart)
    .join(":");
}

function failedSinkResult(
  sink: AlertDeliverySink,
  request: DeliverAlertsRequest,
  error: unknown
): AlertDeliverySinkResult {
  return {
    sinkId: sink.id,
    kind: sink.kind,
    status: "failed",
    mode: request.mode,
    deliveredAlertCount: 0,
    failedAlertCount: request.alerts.length,
    skippedAlertCount: 0,
    attempts: [],
    dedupeKeys: request.alerts.map(alertDedupeKey),
    warnings: [],
    errors: [error instanceof Error ? error.message : "Alert delivery sink failed."]
  };
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function safeKeyPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^0-9a-z._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "unknown";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
