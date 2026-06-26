import assert from "node:assert/strict";
import test from "node:test";

import type { AlertDeliveryReport } from "../observability/alert-delivery.js";
import type { SloAlertEvent, SloEvaluationReport } from "../observability/slo.js";
import type { RagRunTrace } from "../observability/trace.js";
import type { RagEvalBenchmarkSnapshot } from "./eval-report.js";
import type { EvalTraceReplayReport } from "./eval-replay.js";
import type { RagEvalCaseResult, RagEvalRunSummary } from "./eval-types.js";
import { buildRagIncidentBundle, renderRagIncidentMarkdown } from "./incident-bundle.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("incident bundle stays healthy with passing operational artifacts", () => {
  const bundle = buildRagIncidentBundle({
    generatedAt: GENERATED_AT,
    evalBenchmark: evalBenchmark(),
    evalSummary: evalSummary(),
    traceReplay: traceReplay(),
    sloReport: sloReport(),
    alertDelivery: alertDelivery(),
    artifactPaths: {
      evalBenchmark: ".rag/eval-runs/latest/benchmark.json",
      evalSummary: ".rag/eval-runs/latest/summary.json",
      traceReplay: ".rag/trace-replay/latest/replay.json",
      sloReport: ".rag/slo/latest/slo.json",
      alertDelivery: ".rag/alert-delivery/latest/delivery.json"
    }
  });

  assert.equal(bundle.status, "healthy");
  assert.equal(bundle.severity, "none");
  assert.equal(bundle.metrics.evalCaseCount, 1);
  assert.equal(bundle.findings.length, 0);
  assert.equal(bundle.traceEvidence.length, 1);
  assert.equal(
    bundle.sourceArtifacts.find((artifact) => artifact.id === "evalSummary")?.status,
    "present"
  );
});

test("incident bundle escalates failed eval, replay, SLO, and delivery artifacts", () => {
  const bundle = buildRagIncidentBundle({
    generatedAt: GENERATED_AT,
    evalBenchmark: evalBenchmark({
      passed: false,
      passedCaseCount: 0,
      failedCaseCount: 1,
      passRate: 0,
      profiles: [
        {
          profileId: "generic-docs",
          namespaceId: "generic-docs",
          passed: false,
          caseCount: 1,
          passedCaseCount: 0,
          failedCaseCount: 1,
          passRate: 0,
          requiredChecks: ["retrieval_recall", "grounding_faithfulness"],
          coveredChecks: ["retrieval_recall"],
          missingRequiredChecks: ["grounding_faithfulness"],
          finalCitationCount: 0,
          visualCitationCount: 0,
          statusCounts: { refused: 1 },
          checkCounts: { retrieval_recall: 1 },
          retrievalModeCounts: { keyword: 1 }
        }
      ]
    }),
    traceReplay: traceReplay({
      status: "failed",
      matchedCount: 0,
      mismatchedCount: 1,
      failures: ["generic-docs/case_replay: Eval pass state changed."]
    }),
    sloReport: sloReport({
      status: "failed",
      failedRuleCount: 1,
      alertCount: 1,
      criticalAlertCount: 1,
      alerts: [
        sloAlert({
          ruleId: "trace_replay_mismatches",
          ruleName: "Trace replay mismatches",
          severity: "critical",
          category: "trace_replay",
          message: 'Observed 1 trace replay mismatch for "<script>".'
        })
      ]
    }),
    alertDelivery: alertDelivery({
      status: "failed",
      failedSinkCount: 1,
      failedAlertCount: 1,
      errors: ["delivery failed"]
    })
  });

  assert.equal(bundle.status, "incident");
  assert.equal(bundle.severity, "critical");
  assert.equal(bundle.impactedProfiles.length, 1);
  assert.equal(bundle.runbooks.length, 1);
  assert.equal(
    bundle.findings.some((finding) => finding.source === "trace_replay"),
    true
  );
  assert.equal(
    bundle.recommendedActions.some((action) => action.includes("trace replay report")),
    true
  );
});

test("incident markdown escapes unsafe values", () => {
  const bundle = buildRagIncidentBundle({
    title: "<script>alert(1)</script>",
    generatedAt: GENERATED_AT,
    sloReport: sloReport({
      status: "failed",
      failedRuleCount: 1,
      alertCount: 1,
      criticalAlertCount: 1,
      alerts: [sloAlert({ message: "Unsafe <script>alert(1)</script> marker." })]
    })
  });
  const markdown = renderRagIncidentMarkdown(bundle);

  assert.equal(markdown.includes("<script>"), false);
  assert.equal(markdown.includes("&lt;script&gt;"), true);
  assert.equal(markdown.includes("## Evidence Boundary"), true);
});

test("incident bundle marks unavailable source artifacts as missing", () => {
  const bundle = buildRagIncidentBundle({
    generatedAt: GENERATED_AT,
    sloReport: sloReport()
  });

  assert.equal(
    bundle.sourceArtifacts.find((artifact) => artifact.id === "evalBenchmark")?.status,
    "missing"
  );
  assert.equal(
    bundle.sourceArtifacts.find((artifact) => artifact.id === "sloReport")?.status,
    "present"
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

function evalSummary(overrides: Partial<RagEvalRunSummary> = {}): RagEvalRunSummary {
  const evalCase = caseResult();
  return {
    passed: true,
    suiteCount: 1,
    caseCount: 1,
    failures: [],
    suites: [
      {
        profileId: "generic-docs",
        namespaceId: "generic-docs",
        passed: true,
        goldenSetPath: "profiles/generic-docs/evals/golden.jsonl",
        adversarialSetPath: "profiles/generic-docs/evals/adversarial.jsonl",
        requiredChecks: ["retrieval_recall"],
        coveredChecks: ["retrieval_recall"],
        missingRequiredChecks: [],
        caseCount: 1,
        failures: [],
        cases: [evalCase]
      }
    ],
    ...overrides
  };
}

function caseResult(overrides: Partial<RagEvalCaseResult> = {}): RagEvalCaseResult {
  return {
    id: "case_replay",
    setKind: "golden",
    checks: ["retrieval_recall"],
    passed: true,
    failures: [],
    status: "succeeded",
    contextStatus: "answerable",
    retrievalMode: "keyword",
    retrievedDocumentIds: ["doc_1"],
    finalCitationCount: 1,
    visualCitationCount: 0,
    traceId: "trace_case_replay",
    trace: sampleTrace(),
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

function sloReport(overrides: Partial<SloEvaluationReport> = {}): SloEvaluationReport {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    status: "passed",
    evaluatedRuleCount: 1,
    passedRuleCount: 1,
    failedRuleCount: 0,
    missingSignalCount: 0,
    alertCount: 0,
    criticalAlertCount: 0,
    highAlertCount: 0,
    warningAlertCount: 0,
    signals: [],
    evaluations: [],
    alerts: [],
    ...overrides
  };
}

function sloAlert(overrides: Partial<SloAlertEvent> = {}): SloAlertEvent {
  return {
    event: "rag_slo_alert",
    alertId: "alert_trace_replay",
    generatedAt: GENERATED_AT,
    ruleId: "trace_replay_mismatches",
    ruleName: "Trace replay mismatches",
    category: "trace_replay",
    severity: "critical",
    signalName: "trace_replay.mismatched_count",
    observedValue: 1,
    comparator: "eq",
    threshold: 0,
    message: "Observed 1 trace replay mismatch.",
    runbook: {
      title: "Investigate trace replay drift",
      summary: "Trace replay detected behavior drift.",
      immediateActions: ["Open the trace replay report and compare mismatched cases."],
      escalation: "Escalate to the RAG owner if drift affects production profiles."
    },
    ...overrides
  };
}

function alertDelivery(overrides: Partial<AlertDeliveryReport> = {}): AlertDeliveryReport {
  return {
    schemaVersion: 1,
    deliveryId: "alert_delivery_test",
    generatedAt: GENERATED_AT,
    mode: "dry_run",
    status: "passed",
    alertCount: 0,
    sinkCount: 1,
    deliveredSinkCount: 0,
    failedSinkCount: 0,
    skippedSinkCount: 1,
    deliveredAlertCount: 0,
    failedAlertCount: 0,
    skippedAlertCount: 0,
    warnings: [],
    errors: [],
    results: [],
    ...overrides
  };
}

function sampleTrace(overrides: Partial<RagRunTrace> = {}): RagRunTrace {
  const runId = overrides.runId ?? "run_case_replay";
  const traceId = overrides.traceId ?? "trace_case_replay";
  return {
    runId,
    traceId,
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    startedAt: GENERATED_AT,
    finishedAt: "2026-06-24T00:00:01.000Z",
    status: "succeeded",
    questionHash: "question_hash",
    queryPlanId: `${runId}_query_plan`,
    plannedQueryHashes: ["query_hash"],
    retrievalId: `${runId}_retrieval`,
    contextId: `${runId}_context`,
    answerId: `${runId}_answer`,
    generationId: `${runId}_generation`,
    modelRequestId: `${runId}_model`,
    retrievedChunkIds: ["chunk_1"],
    rejectedChunkIds: [],
    finalCitations: [
      {
        sourceId: "source_1",
        chunkId: "chunk_1",
        title: "Source One",
        locator: "line 1"
      }
    ],
    safetyFlags: [],
    events: [
      {
        runId,
        traceId,
        kind: "run_started",
        at: GENERATED_AT,
        message: "started"
      },
      {
        runId,
        traceId,
        kind: "run_finished",
        at: "2026-06-24T00:00:01.000Z",
        message: "finished"
      }
    ],
    ...overrides
  };
}
