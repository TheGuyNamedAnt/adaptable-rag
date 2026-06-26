import assert from "node:assert/strict";
import test from "node:test";

import { deliverAlerts } from "../observability/alert-delivery.js";
import type { SloAlertEvent } from "../observability/slo.js";
import type {
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderTransport
} from "../shared/provider-boundary.js";
import { AlertWebhookSink } from "./alert-webhook-sink.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("webhook alert sink dry-run does not send HTTP requests", async () => {
  const transport = new RecordingTransport([{ status: 200 }]);
  const sink = new AlertWebhookSink({
    id: "alerts",
    endpoint: "https://alerts.example.test/webhook",
    transport
  });
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    deliveryId: "delivery_dry_run",
    mode: "dry_run",
    alerts: [alert()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.skippedAlertCount, 1);
  assert.equal(transport.requests.length, 0);
});

test("webhook alert sink sends generic redacted alert payloads", async () => {
  const transport = new RecordingTransport([{ status: 202 }]);
  const sink = new AlertWebhookSink({
    id: "alerts",
    endpoint: "https://alerts.example.test/webhook",
    transport,
    secrets: {
      apiKeyProvider: () => "live-alert-token",
      secretId: "ALERT_WEBHOOK_TOKEN"
    }
  });
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    deliveryId: "delivery_live",
    mode: "live",
    alerts: [alert()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.deliveredAlertCount, 1);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.headers["authorization"], "Bearer live-alert-token");
  assert.equal(JSON.stringify(report).includes("live-alert-token"), false);

  const body = transport.requests[0]?.body as {
    readonly event: string;
    readonly alerts: readonly [{ readonly dedupeKey: string; readonly ruleId: string }];
  };
  assert.equal(body.event, "rag_alert_delivery");
  assert.equal(body.alerts[0]?.ruleId, "eval_failed_case_count");
  assert.equal(body.alerts[0]?.dedupeKey.includes("eval_failed_case_count"), true);
});

test("webhook alert sink retries retryable responses", async () => {
  const transport = new RecordingTransport([{ status: 500 }, { status: 200 }]);
  const sleeps: number[] = [];
  const sink = new AlertWebhookSink({
    id: "alerts",
    endpoint: "https://alerts.example.test/webhook",
    transport,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 5,
      retryStatusCodes: [500]
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()],
    sinks: [sink]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.results[0]?.attempts.length, 2);
  assert.deepEqual(sleeps, [5]);
});

test("webhook alert sink redacts secrets from failed responses", async () => {
  const transport = new RecordingTransport([
    {
      status: 401,
      body: { error: { message: "bad bearer live-alert-token" } }
    }
  ]);
  const sink = new AlertWebhookSink({
    id: "alerts",
    endpoint: "https://alerts.example.test/webhook",
    transport,
    secrets: {
      apiKeyProvider: () => "live-alert-token"
    }
  });
  const report = await deliverAlerts({
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()],
    sinks: [sink]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.errors[0]?.includes("live-alert-token"), false);
  assert.equal(JSON.stringify(report).includes("live-alert-token"), false);
  assert.equal(report.results[0]?.attempts[0]?.errorCode, "auth_error");
});

test("webhook alert sink builds Slack and PagerDuty payload shapes", async () => {
  const slackTransport = new RecordingTransport([{ status: 200 }]);
  const pagerDutyTransport = new RecordingTransport([{ status: 202 }]);
  await new AlertWebhookSink({
    id: "slack",
    endpoint: "https://hooks.slack.example.test/services/test",
    format: "slack",
    transport: slackTransport
  }).deliver({
    deliveryId: "delivery_slack",
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()]
  });
  await new AlertWebhookSink({
    id: "pagerduty",
    endpoint: "https://events.pagerduty.example.test/v2/enqueue",
    format: "pagerduty_events_v2",
    transport: pagerDutyTransport,
    pagerDutyRoutingKeyProvider: () => "routing-secret"
  }).deliver({
    deliveryId: "delivery_pagerduty",
    generatedAt: GENERATED_AT,
    mode: "live",
    alerts: [alert()]
  });

  assert.equal(
    (slackTransport.requests[0]?.body as { readonly text: string }).text.includes("RAG SLO"),
    true
  );
  const pagerDutyBody = pagerDutyTransport.requests[0]?.body as {
    readonly routing_key: string;
    readonly event_action: string;
    readonly payload: { readonly component: string };
  };
  assert.equal(pagerDutyBody.routing_key, "routing-secret");
  assert.equal(pagerDutyBody.event_action, "trigger");
  assert.equal(pagerDutyBody.payload.component, "rag-slo");
});

test("webhook alert sink rejects unsafe non-local HTTP endpoints", () => {
  assert.throws(
    () =>
      new AlertWebhookSink({
        id: "alerts",
        endpoint: "http://alerts.example.test/webhook",
        transport: new RecordingTransport([])
      }),
    /https unless it targets localhost/u
  );
});

class RecordingTransport implements ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private nextIndex = 0;

  constructor(private readonly responses: readonly Partial<ProviderHttpResponse>[]) {}

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const response = this.responses[this.nextIndex] ?? { status: 200 };
    this.nextIndex += 1;
    return {
      status: response.status ?? 200,
      headers: response.headers ?? {},
      body: response.body ?? {},
      latencyMs: response.latencyMs ?? 1
    };
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
