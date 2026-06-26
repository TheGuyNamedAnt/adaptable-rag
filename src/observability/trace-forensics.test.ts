import assert from "node:assert/strict";
import test from "node:test";

import type { RagRunTrace } from "./trace.js";
import { compareRunTraces, summarizeRunTrace, traceStatusSeverity } from "./trace-forensics.js";

test("trace forensics matches identical safe traces", () => {
  const trace = sampleTrace();
  const summary = summarizeRunTrace(trace);
  const comparison = compareRunTraces(trace, sampleTrace());

  assert.equal(summary.linked, true);
  assert.equal(summary.finalCitationCount, 1);
  assert.equal(comparison.status, "matched");
  assert.equal(comparison.failures.length, 0);
});

test("trace forensics detects status and retrieval drift", () => {
  const baseline = sampleTrace();
  const current = sampleTrace({
    status: "refused",
    retrievedChunkIds: []
  });
  const comparison = compareRunTraces(baseline, current);

  assert.equal(comparison.status, "mismatched");
  assert.equal(
    comparison.failures.some((failure) => failure.includes('"status" changed')),
    true
  );
  assert.equal(
    comparison.failures.some((failure) => failure.includes('"retrievedChunkIds" changed')),
    true
  );
});

test("trace forensics reports not comparable missing traces", () => {
  const comparison = compareRunTraces(undefined, sampleTrace());

  assert.equal(comparison.status, "not_comparable");
  assert.equal(comparison.severity, "warning");
  assert.equal(comparison.warnings.includes("Baseline trace is missing."), true);
});

test("trace forensics escalates unlinked current traces", () => {
  const baseline = sampleTrace();
  const current = sampleTrace({
    events: [
      {
        runId: "wrong_run",
        traceId: "trace_eval_case",
        kind: "run_started",
        at: "2026-06-24T00:00:00.000Z",
        message: "started"
      }
    ]
  });
  const comparison = compareRunTraces(baseline, current);

  assert.equal(comparison.status, "mismatched");
  assert.equal(
    comparison.failures.includes("Current trace events are not linked to one runId and traceId."),
    true
  );
});

test("trace status severity maps operational failure stages", () => {
  assert.equal(traceStatusSeverity("succeeded"), "info");
  assert.equal(traceStatusSeverity("refused"), "warning");
  assert.equal(traceStatusSeverity("retrieval_failed"), "high");
  assert.equal(traceStatusSeverity("generation_failed"), "critical");
});

function sampleTrace(overrides: Partial<RagRunTrace> = {}): RagRunTrace {
  return {
    runId: "run_eval_case",
    traceId: "trace_eval_case",
    profileId: "generic-docs",
    namespaceId: "generic-docs",
    startedAt: "2026-06-24T00:00:00.000Z",
    finishedAt: "2026-06-24T00:00:01.000Z",
    status: "succeeded",
    questionHash: "question_hash",
    queryPlanId: "run_eval_case_query_plan",
    plannedQueryHashes: ["query_hash"],
    retrievalId: "run_eval_case_retrieval",
    contextId: "run_eval_case_context",
    answerId: "run_eval_case_answer",
    generationId: "run_eval_case_generation",
    modelRequestId: "run_eval_case_model",
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
        runId: "run_eval_case",
        traceId: "trace_eval_case",
        kind: "run_started",
        at: "2026-06-24T00:00:00.000Z",
        message: "started"
      },
      {
        runId: "run_eval_case",
        traceId: "trace_eval_case",
        kind: "run_finished",
        at: "2026-06-24T00:00:01.000Z",
        message: "finished"
      }
    ],
    ...overrides
  };
}
