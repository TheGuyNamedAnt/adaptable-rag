import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSloRules, renderSloHtmlReport, type SloRule } from "./slo.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("SLO evaluation passes when all rules are satisfied", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [{ name: "eval.passRate", value: 1, unit: "ratio" }],
    rules: [rule({ signalName: "eval.passRate", comparator: "gte", threshold: 1 })]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.passedRuleCount, 1);
  assert.equal(report.alertCount, 0);
});

test("SLO evaluation emits failed alerts for critical violations", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [{ name: "traceReplay.mismatchedCount", value: 1, unit: "cases" }],
    rules: [
      rule({
        id: "trace_replay_mismatches",
        signalName: "traceReplay.mismatchedCount",
        comparator: "lte",
        threshold: 0,
        severity: "critical"
      })
    ]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failedRuleCount, 1);
  assert.equal(report.criticalAlertCount, 1);
  assert.equal(report.alerts[0]?.event, "rag_slo_alert");
  assert.equal(report.alerts[0]?.ruleId, "trace_replay_mismatches");
});

test("warning SLO violations are visible but non-blocking", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [{ name: "http.rateLimited", value: 2, unit: "requests" }],
    rules: [
      rule({
        id: "http_rate_limited",
        signalName: "http.rateLimited",
        comparator: "lte",
        threshold: 0,
        severity: "warning"
      })
    ]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.failedRuleCount, 1);
  assert.equal(report.warningAlertCount, 1);
});

test("required missing SLO signals fail closed", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [],
    rules: [rule({ signalName: "providerSmoke.passed", comparator: "eq", threshold: true })]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.missingSignalCount, 0);
  assert.equal(report.failedRuleCount, 1);
  assert.equal(report.alertCount, 1);
});

test("optional missing SLO signals are reported without alerts", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [],
    rules: [
      rule({
        signalName: "optional.http.activeRequests",
        comparator: "lte",
        threshold: 10,
        required: false
      })
    ]
  });

  assert.equal(report.status, "passed");
  assert.equal(report.missingSignalCount, 1);
  assert.equal(report.failedRuleCount, 0);
  assert.equal(report.alertCount, 0);
  assert.equal(report.evaluations[0]?.status, "missing");
});

test("SLO HTML report escapes rule and runbook text", () => {
  const report = evaluateSloRules({
    generatedAt: GENERATED_AT,
    signals: [{ name: "unsafe.signal", value: false }],
    rules: [
      rule({
        id: "unsafe_rule",
        name: '<script>alert("x")</script>',
        signalName: "unsafe.signal",
        comparator: "eq",
        threshold: true,
        runbook: {
          title: "<script>runbook</script>",
          summary: "Check escaped report output.",
          immediateActions: ['Open <script>alert("x")</script>'],
          escalation: "Escalate safely."
        }
      })
    ]
  });
  const html = renderSloHtmlReport(report);

  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});

function rule(overrides: Partial<SloRule> = {}): SloRule {
  return {
    id: "slo_rule",
    name: "SLO rule",
    category: "custom",
    severity: "critical",
    signalName: "signal",
    comparator: "eq",
    threshold: true,
    description: "A test SLO rule.",
    runbook: {
      title: "Test runbook",
      summary: "Use the test fixture.",
      immediateActions: ["Inspect the failing test."],
      escalation: "Escalate to the test owner."
    },
    ...overrides
  };
}
