import assert from "node:assert/strict";
import test from "node:test";

import {
  alertDedupeKey,
  deliverAlerts,
  DryRunAlertDeliverySink,
  type AlertDeliverySink,
  type AlertDeliverySinkRequest,
  type AlertDeliverySinkResult
} from "./alert-delivery.js";
import type { SloAlertEvent } from "./slo.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("alert delivery reports successful sink delivery", async () => {
  const sink = new FakeSink("delivered");
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    deliveryId: "delivery_test",
    mode: "live",
    alerts: [alert()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.deliveredSinkCount, 1);
  assert.equal(report.deliveredAlertCount, 1);
  assert.equal(report.failedAlertCount, 0);
});

test("alert delivery fails closed when required sinks are missing", async () => {
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()],
    sinks: [],
    requireSink: true
  });

  assert.equal(report.status, "failed");
  assert.equal(report.errors.includes("At least one alert delivery sink is required."), true);
});

test("alert delivery captures thrown sink failures", async () => {
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()],
    sinks: [new ThrowingSink()]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedSinkCount, 1);
  assert.equal(report.failedAlertCount, 1);
  assert.equal(report.errors.includes("sink failed"), true);
});

test("dry-run sink records dedupe keys without sending", async () => {
  const sloAlert = alert({ ruleId: "trace_replay_mismatches" });
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    mode: "dry_run",
    alerts: [sloAlert],
    sinks: [new DryRunAlertDeliverySink()]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.skippedSinkCount, 1);
  assert.equal(report.skippedAlertCount, 1);
  assert.equal(report.results[0]?.dedupeKeys[0], alertDedupeKey(sloAlert));
});

test("alert dedupe keys are stable and do not include alert timestamps", () => {
  const first = alert({ generatedAt: "2026-06-24T00:00:00.000Z" });
  const second = alert({ generatedAt: "2026-06-25T00:00:00.000Z" });

  assert.equal(alertDedupeKey(first), alertDedupeKey(second));
});

class FakeSink implements AlertDeliverySink {
  readonly id = "fake_sink";
  readonly kind = "custom";

  constructor(private readonly resultStatus: AlertDeliverySinkResult["status"]) {}

  async deliver(request: AlertDeliverySinkRequest): Promise<AlertDeliverySinkResult> {
    return {
      sinkId: this.id,
      kind: this.kind,
      status: this.resultStatus,
      mode: request.mode,
      deliveredAlertCount: this.resultStatus === "delivered" ? request.alerts.length : 0,
      failedAlertCount: this.resultStatus === "failed" ? request.alerts.length : 0,
      skippedAlertCount: this.resultStatus === "skipped" ? request.alerts.length : 0,
      attempts: [],
      dedupeKeys: request.alerts.map(alertDedupeKey),
      warnings: [],
      errors: this.resultStatus === "failed" ? ["sink failed"] : []
    };
  }
}

class ThrowingSink implements AlertDeliverySink {
  readonly id = "throwing_sink";
  readonly kind = "custom";

  async deliver(_request: AlertDeliverySinkRequest): Promise<AlertDeliverySinkResult> {
    throw new Error("sink failed");
  }
}

function alert(overrides: Partial<SloAlertEvent> = {}): SloAlertEvent {
  return {
    event: "rag_slo_alert",
    alertId: "alert_eval_failed",
    generatedAt: GENERATED_AT,
    ruleId: "eval_failed_case_count",
    ruleName: "No failed eval cases",
    category: "eval_quality",
    severity: "critical",
    signalName: "eval.failedCaseCount",
    observedValue: 1,
    comparator: "lte",
    threshold: 0,
    message: "Observed eval.failedCaseCount=1 violated lte 0.",
    runbook: {
      title: "Resolve failed eval cases",
      summary: "At least one benchmark case failed.",
      immediateActions: ["Review eval report."],
      escalation: "Escalate if expected behavior changed."
    },
    ...overrides
  };
}
