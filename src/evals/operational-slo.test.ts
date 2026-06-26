import assert from "node:assert/strict";
import test from "node:test";

import type { ProductionHttpMetricsSnapshot } from "../runtime/production-http-server.js";
import type { ProviderSmokeReport } from "../runtime/provider-smoke.js";
import type { RagEvalBenchmarkSnapshot } from "./eval-report.js";
import type { EvalTraceReplayReport } from "./eval-replay.js";
import {
  buildRagOperationalSloReport,
  ragOperationalSloRules,
  ragOperationalSloSignals
} from "./operational-slo.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("RAG operational SLO passes with healthy artifacts", () => {
  const input = {
    generatedAt: GENERATED_AT,
    evalBenchmark: evalBenchmark(),
    traceReplay: traceReplay(),
    providerSmoke: providerSmoke(),
    httpMetrics: httpMetrics()
  };
  const report = buildRagOperationalSloReport(input);

  assert.equal(report.status, "passed");
  assert.equal(report.alertCount, 0);
  assert.equal(
    ragOperationalSloSignals(input).some((signal) => signal.name === "http.ready"),
    true
  );
  assert.equal(
    ragOperationalSloRules(input).some((rule) => rule.id === "trace_replay_passed"),
    true
  );
});

test("RAG operational SLO fails on trace replay drift", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    traceReplay: traceReplay({
      status: "failed",
      mismatchedCount: 1,
      matchedCount: 0,
      failures: ["generic-docs/case: Eval pass state changed."]
    })
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "trace_replay_mismatches"),
    true
  );
  assert.equal(report.criticalAlertCount > 0, true);
});

test("RAG operational SLO fails on provider smoke failures", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    providerSmoke: providerSmoke({
      status: "failed",
      summary: {
        requiredProviderCount: 1,
        passedRequiredProviderCount: 0,
        failedRequiredProviderCount: 1,
        providerProbeCheckCount: 1,
        failedProviderProbeCheckCount: 1,
        skippedProviderProbeCheckCount: 0
      },
      failures: ['Required provider "model" smoke status was failed.']
    })
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "provider_required_failures"),
    true
  );
});

test("RAG operational SLO fails on HTTP server errors", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    httpMetrics: httpMetrics({ serverErrors: 1, byStatusCode: { "500": 1 } })
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "http_server_errors"),
    true
  );
});

test("RAG operational SLO keeps HTTP warning alerts non-blocking", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    httpMetrics: httpMetrics({ rateLimited: 2, byStatusCode: { "429": 2 } })
  });

  assert.equal(report.status, "passed");
  assert.equal(report.warningAlertCount, 1);
  assert.equal(report.alerts[0]?.ruleId, "http_rate_limited");
});

function evalBenchmark(
  overrides: Partial<RagEvalBenchmarkSnapshot> = {}
): RagEvalBenchmarkSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    passed: true,
    suiteCount: 1,
    caseCount: 1,
    passedCaseCount: 1,
    failedCaseCount: 0,
    passRate: 1,
    finalCitationCount: 1,
    visualCitationCount: 0,
    statusCounts: { succeeded: 1 },
    checkCounts: { retrieval_recall: 1 },
    retrievalModeCounts: { keyword: 1 },
    profiles: [
      {
        profileId: "generic-docs",
        namespaceId: "generic-docs",
        passed: true,
        caseCount: 1,
        passedCaseCount: 1,
        failedCaseCount: 0,
        passRate: 1,
        requiredChecks: ["retrieval_recall"],
        coveredChecks: ["retrieval_recall"],
        missingRequiredChecks: [],
        finalCitationCount: 1,
        visualCitationCount: 0,
        statusCounts: { succeeded: 1 },
        checkCounts: { retrieval_recall: 1 },
        retrievalModeCounts: { keyword: 1 }
      }
    ],
    ...overrides
  };
}

function traceReplay(overrides: Partial<EvalTraceReplayReport> = {}): EvalTraceReplayReport {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    status: "passed",
    baseline: {
      passed: true,
      suiteCount: 1,
      caseCount: 1
    },
    current: {
      passed: true,
      suiteCount: 1,
      caseCount: 1
    },
    caseCount: 1,
    matchedCount: 1,
    mismatchedCount: 0,
    notComparableCount: 0,
    failures: [],
    warnings: [],
    cases: [],
    ...overrides
  };
}

function providerSmoke(overrides: Partial<ProviderSmokeReport> = {}): ProviderSmokeReport {
  return {
    schemaVersion: 1,
    status: "passed",
    runId: "provider_smoke_test",
    checkedAt: GENERATED_AT,
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    retrievalMode: "keyword",
    requiredProviders: ["model"],
    summary: {
      requiredProviderCount: 1,
      passedRequiredProviderCount: 1,
      failedRequiredProviderCount: 0,
      providerProbeCheckCount: 1,
      failedProviderProbeCheckCount: 0,
      skippedProviderProbeCheckCount: 0
    },
    failures: [],
    warnings: [],
    providerCoverage: [],
    selfTest: {
      status: "passed",
      checkedAt: GENERATED_AT,
      profileId: "generic-docs",
      namespaceId: "generic-docs",
      retrievalMode: "keyword",
      probeProviders: true,
      checkCount: 1,
      failedCount: 0,
      skippedCount: 0,
      checks: []
    },
    ...overrides
  };
}

function httpMetrics(
  overrides: Partial<ProductionHttpMetricsSnapshot> = {}
): ProductionHttpMetricsSnapshot {
  return {
    startedAt: GENERATED_AT,
    uptimeMs: 1000,
    ready: true,
    draining: false,
    totalRequests: 1,
    activeRequests: 0,
    completedRequests: 1,
    byStatusCode: { "200": 1 },
    byRoute: { answer: 1 },
    byOutcome: { answer_succeeded: 1 },
    authDenied: 0,
    rateLimited: 0,
    answerSucceeded: 1,
    answerRefused: 0,
    answerFailed: 0,
    requestErrors: 0,
    serverErrors: 0,
    ...overrides
  };
}
