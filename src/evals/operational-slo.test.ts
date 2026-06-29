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

test("RAG operational SLO warns on high HTTP latency", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    httpMetrics: httpMetrics({
      latencyMs: latencySummary({ p95: 45000, p99: 60000 })
    })
  });

  assert.equal(report.status, "passed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "http_latency_p95"),
    true
  );
});

test("RAG operational SLO fails on low-citation answers", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    httpMetrics: httpMetrics({
      rag: ragMetrics({ lowCitationAnswerCount: 1, citationCount: 0 })
    })
  });

  assert.equal(report.status, "failed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "rag_low_citation_answers"),
    true
  );
});

test("RAG operational SLO warns on no-evidence answers and model latency", () => {
  const report = buildRagOperationalSloReport({
    generatedAt: GENERATED_AT,
    httpMetrics: httpMetrics({
      rag: ragMetrics({
        noEvidenceAnswerCount: 1,
        byEvidenceStatus: { no_evidence: 1 },
        modelLatencyMs: latencySummary({ p95: 45000, p99: 50000 })
      })
    })
  });

  assert.equal(report.status, "passed");
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "rag_no_evidence_answers"),
    true
  );
  assert.equal(
    report.alerts.some((alert) => alert.ruleId === "rag_model_latency_p95"),
    true
  );
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
    retrievalQuality: retrievalQuality(),
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
        retrievalModeCounts: { keyword: 1 },
        retrievalQuality: retrievalQuality()
      }
    ],
    ...overrides
  };
}

function retrievalQuality() {
  return {
    recallAtK: 1,
    mrr: 1,
    citationPrecision: 1,
    citationRecall: 1,
    refusalCorrectnessRate: 1,
    accessBoundaryCorrectnessRate: 1,
    staleSourceRefusalRate: 0,
    parserQualityImpact: 0,
    graphPathGrounding: 0,
    latencyMsP50: 0,
    estimatedCostUsdTotal: 0
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
    byAnswerStatus: { succeeded: 1 },
    latencyMs: latencySummary(),
    byRouteLatencyMs: { answer: latencySummary() },
    authDenied: 0,
    rateLimited: 0,
    answerSucceeded: 1,
    answerRefused: 0,
    answerFailed: 0,
    requestErrors: 0,
    serverErrors: 0,
    rag: ragMetrics(),
    ...overrides
  };
}

function ragMetrics(
  overrides: Partial<ProductionHttpMetricsSnapshot["rag"]> = {}
): ProductionHttpMetricsSnapshot["rag"] {
  return {
    answerCount: 1,
    retrievedChunkCount: 1,
    rejectedRetrievalCount: 0,
    citationCount: 1,
    lowCitationAnswerCount: 0,
    noEvidenceAnswerCount: 0,
    humanReviewRequiredCount: 0,
    byEvidenceStatus: { answerable: 1 },
    byProfile: { "generic-docs": 1 },
    byNamespace: { "generic-docs": 1 },
    byTenantHash: { tenant_hash: 1 },
    modelPromptTokens: 10,
    modelCompletionTokens: 5,
    modelTotalTokens: 15,
    estimatedCostUsd: 0,
    retrievalLatencyMs: latencySummary(),
    contextLatencyMs: latencySummary(),
    generationLatencyMs: latencySummary(),
    modelLatencyMs: latencySummary(),
    ...overrides
  };
}

function latencySummary(
  overrides: Partial<ProductionHttpMetricsSnapshot["latencyMs"]> = {}
): ProductionHttpMetricsSnapshot["latencyMs"] {
  return {
    count: 1,
    min: 10,
    max: 10,
    avg: 10,
    p50: 10,
    p95: 10,
    p99: 10,
    ...overrides
  };
}
