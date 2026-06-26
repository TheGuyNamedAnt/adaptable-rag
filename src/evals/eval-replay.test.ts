import assert from "node:assert/strict";
import test from "node:test";

import type { RagRunTrace } from "../observability/trace.js";
import type { RagEvalCaseResult, RagEvalRunSummary } from "./eval-types.js";
import { buildEvalTraceReplayReport, renderEvalTraceReplayHtmlReport } from "./eval-replay.js";

test("eval trace replay matches unchanged eval traces", () => {
  const baseline = summaryWithCase(caseResult());
  const current = summaryWithCase(caseResult());
  const report = buildEvalTraceReplayReport(baseline, current, {
    generatedAt: "2026-06-24T00:00:00.000Z"
  });

  assert.equal(report.status, "passed");
  assert.equal(report.caseCount, 1);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.failures.length, 0);
});

test("eval trace replay can target a single trace id", () => {
  const baseline = summaryWithCase(caseResult({ id: "case_target", traceId: "trace_target" }));
  const current = summaryWithCase(caseResult({ id: "case_target", traceId: "trace_target" }));
  const report = buildEvalTraceReplayReport(baseline, current, {
    target: { traceId: "trace_target" }
  });

  assert.equal(report.status, "passed");
  assert.equal(report.caseCount, 1);
  assert.equal(report.cases[0]?.caseId, "case_target");
});

test("eval trace replay fails when current behavior drifts", () => {
  const baseline = summaryWithCase(caseResult());
  const current = summaryWithCase(
    caseResult({
      passed: false,
      status: "refused",
      retrievedDocumentIds: [],
      trace: sampleTrace({
        status: "refused",
        retrievedChunkIds: []
      })
    })
  );
  const report = buildEvalTraceReplayReport(baseline, current);

  assert.equal(report.status, "failed");
  assert.equal(report.mismatchedCount, 1);
  assert.equal(
    report.failures.some((failure) => failure.includes("Eval pass state changed")),
    true
  );
  assert.equal(
    report.failures.some((failure) => failure.includes('"retrievedChunkIds" changed')),
    true
  );
});

test("eval trace replay fails closed when target does not exist", () => {
  const report = buildEvalTraceReplayReport(
    summaryWithCase(caseResult()),
    summaryWithCase(caseResult()),
    {
      target: { traceId: "missing_trace" }
    }
  );

  assert.equal(report.status, "failed");
  assert.equal(report.caseCount, 0);
  assert.equal(
    report.failures.includes("Replay target did not match any baseline eval case."),
    true
  );
});

test("eval trace replay report escapes case ids and findings", () => {
  const baseline = summaryWithCase(caseResult({ id: 'case_<script>alert("x")</script>' }));
  const current = summaryWithCase(
    caseResult({
      id: 'case_<script>alert("x")</script>',
      trace: sampleTrace({ status: "refused" }),
      status: "refused"
    })
  );
  const report = buildEvalTraceReplayReport(baseline, current);
  const html = renderEvalTraceReplayHtmlReport(report);

  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});

function summaryWithCase(evalCase: RagEvalCaseResult): RagEvalRunSummary {
  return {
    passed: evalCase.passed,
    suiteCount: 1,
    caseCount: 1,
    failures: evalCase.failures,
    suites: [
      {
        profileId: "generic-docs",
        namespaceId: "generic-docs",
        passed: evalCase.passed,
        goldenSetPath: "profiles/generic-docs/evals/golden.jsonl",
        adversarialSetPath: "profiles/generic-docs/evals/adversarial.jsonl",
        requiredChecks: ["retrieval_recall"],
        coveredChecks: ["retrieval_recall"],
        missingRequiredChecks: [],
        caseCount: 1,
        failures: evalCase.failures,
        cases: [evalCase]
      }
    ]
  };
}

function caseResult(overrides: Partial<RagEvalCaseResult> = {}): RagEvalCaseResult {
  const id = overrides.id ?? "case_replay";
  const traceId = overrides.traceId ?? `trace_${id}`;
  return {
    id,
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
    traceId,
    trace: sampleTrace({
      runId: `run_${id}`,
      traceId
    }),
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
    startedAt: "2026-06-24T00:00:00.000Z",
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
        at: "2026-06-24T00:00:00.000Z",
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
