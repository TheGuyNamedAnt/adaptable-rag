import assert from "node:assert/strict";
import test from "node:test";

import type { RagRunTrace } from "../observability/trace.js";
import { sampleSupportProfile } from "../profiles/examples/sample-support.profile.js";
import type { RagIncidentBundle } from "./incident-bundle.js";
import type { RagEvalCaseResult, RagEvalRunSummary } from "./eval-types.js";
import { buildHumanReviewQueue, renderHumanReviewQueueMarkdown } from "./human-review-queue.js";

const GENERATED_AT = "2026-06-24T00:00:00.000Z";

test("human review queue turns review-required evals into routed queue items", () => {
  const queue = buildHumanReviewQueue({
    generatedAt: GENERATED_AT,
    profiles: [sampleSupportProfile],
    evalSummary: evalSummary([
      caseResult({
        id: "sample-refund-triage",
        status: "human_review_required",
        trace: sampleTrace({ status: "human_review_required" })
      })
    ]),
    evalSummaryPath: ".rag/eval-runs/latest/summary.json"
  });

  assert.equal(queue.status, "open");
  assert.equal(queue.metrics.itemCount, 1);
  assert.equal(queue.metrics.mediumItemCount, 1);
  assert.equal(queue.items[0]?.kind, "answer_review");
  assert.equal(queue.items[0]?.destinations.includes("human_support"), true);
  assert.equal(queue.items[0]?.evidence.trace?.linked, true);
  assert.equal(queue.items[0]?.evidence.artifactPaths[0], ".rag/eval-runs/latest/summary.json");
  assert.equal(
    JSON.stringify(queue).includes("Refund policy says billing refunds require review"),
    false
  );
});

test("human review queue does not include expected refusals unless requested", () => {
  const refusedSummary = evalSummary([
    caseResult({
      id: "expected-refusal",
      status: "refused",
      trace: sampleTrace({ status: "refused" })
    })
  ]);

  const defaultQueue = buildHumanReviewQueue({
    generatedAt: GENERATED_AT,
    evalSummary: refusedSummary
  });
  const includeRefusalsQueue = buildHumanReviewQueue({
    generatedAt: GENERATED_AT,
    evalSummary: refusedSummary,
    includeRefusals: true
  });

  assert.equal(defaultQueue.status, "empty");
  assert.equal(defaultQueue.metrics.itemCount, 0);
  assert.equal(includeRefusalsQueue.status, "open");
  assert.equal(includeRefusalsQueue.metrics.itemCount, 1);
  assert.equal(includeRefusalsQueue.items[0]?.priority, "low");
});

test("human review queue creates incident review items for non-healthy incident bundles", () => {
  const queue = buildHumanReviewQueue({
    generatedAt: GENERATED_AT,
    incidentBundle: incidentBundle(),
    incidentBundlePath: ".rag/incidents/latest/incident.json"
  });

  assert.equal(queue.status, "open");
  assert.equal(queue.metrics.criticalItemCount, 1);
  assert.equal(queue.items[0]?.kind, "incident_review");
  assert.equal(queue.items[0]?.destinations[0], "incident_response");
  assert.equal(
    queue.items[0]?.evidence.artifactPaths.includes(".rag/incidents/latest/incident.json"),
    true
  );
  assert.equal(queue.items[0]?.evidence.incidentFindingCount, 1);
});

test("human review queue markdown escapes unsafe values", () => {
  const queue = buildHumanReviewQueue({
    generatedAt: GENERATED_AT,
    evalSummary: evalSummary([
      caseResult({
        id: "case_<script>alert(1)</script>",
        status: "validation_failed",
        passed: false,
        trace: sampleTrace({ status: "validation_failed" })
      })
    ])
  });
  const markdown = renderHumanReviewQueueMarkdown(queue);

  assert.equal(markdown.includes("<script>"), false);
  assert.equal(markdown.includes("&lt;script&gt;"), true);
  assert.equal(markdown.includes("## Evidence Boundary"), true);
});

function evalSummary(cases: readonly RagEvalCaseResult[]): RagEvalRunSummary {
  const passed = cases.every((evalCase) => evalCase.passed);
  return {
    passed,
    suiteCount: 1,
    caseCount: cases.length,
    failures: cases.flatMap((evalCase) => evalCase.failures),
    suites: [
      {
        profileId: "sample-support",
        namespaceId: "sample-support",
        passed,
        goldenSetPath: "profiles/sample-support/evals/golden.jsonl",
        adversarialSetPath: "profiles/sample-support/evals/adversarial.jsonl",
        requiredChecks: ["retrieval_recall", "citation_required", "escalation_rule_match"],
        coveredChecks: ["retrieval_recall", "citation_required", "escalation_rule_match"],
        missingRequiredChecks: [],
        caseCount: cases.length,
        failures: cases.flatMap((evalCase) => evalCase.failures),
        cases
      }
    ]
  };
}

function caseResult(overrides: Partial<RagEvalCaseResult> = {}): RagEvalCaseResult {
  return {
    id: "case_review",
    setKind: "golden",
    checks: ["retrieval_recall", "citation_required", "escalation_rule_match"],
    passed: true,
    failures: [],
    status: "human_review_required",
    contextStatus: "answerable",
    retrievalMode: "keyword",
    retrievedDocumentIds: ["doc_refund"],
    finalCitationCount: 1,
    visualCitationCount: 0,
    traceId: "trace_case_review",
    trace: sampleTrace(),
    ...overrides
  };
}

function sampleTrace(overrides: Partial<RagRunTrace> = {}): RagRunTrace {
  const runId = overrides.runId ?? "run_case_review";
  const traceId = overrides.traceId ?? "trace_case_review";
  return {
    runId,
    traceId,
    profileId: "sample-support",
    namespaceId: "sample-support",
    startedAt: GENERATED_AT,
    finishedAt: "2026-06-24T00:00:01.000Z",
    status: "human_review_required",
    questionHash: "question_hash",
    queryPlanId: `${runId}_query_plan`,
    plannedQueryHashes: ["query_hash"],
    retrievalId: `${runId}_retrieval`,
    contextId: `${runId}_context`,
    answerId: `${runId}_answer`,
    generationId: `${runId}_generation`,
    modelRequestId: `${runId}_model`,
    retrievedChunkIds: ["chunk_refund"],
    rejectedChunkIds: [],
    finalCitations: [
      {
        sourceId: "support_docs",
        chunkId: "chunk_refund",
        title: "Refund Support Policy",
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

function incidentBundle(): RagIncidentBundle {
  return {
    schemaVersion: 1,
    incidentId: "rag_incident_test",
    generatedAt: GENERATED_AT,
    title: "RAG critical incident bundle",
    status: "incident",
    severity: "critical",
    summary: "Critical SLO failure.",
    sourceArtifacts: [
      {
        id: "sloReport",
        label: "SLO report",
        status: "present",
        path: ".rag/slo/latest/slo.json"
      }
    ],
    metrics: {},
    impactedProfiles: [],
    runbooks: [],
    traceEvidence: [],
    findings: [
      {
        severity: "critical",
        source: "slo",
        message: "SLO failed."
      }
    ],
    recommendedActions: ["Open the SLO report."],
    evidenceBoundary: []
  };
}
