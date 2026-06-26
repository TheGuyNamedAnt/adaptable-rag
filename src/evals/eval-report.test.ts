import assert from "node:assert/strict";
import test from "node:test";

import type { RagEvalRunSummary } from "./eval-types.js";
import {
  buildEvalBenchmarkSnapshot,
  compareEvalBenchmarks,
  renderEvalHtmlReport
} from "./eval-report.js";

test("builds deterministic eval benchmark metrics from a run summary", () => {
  const snapshot = buildEvalBenchmarkSnapshot(summaryFixture(), "2026-06-24T00:00:00.000Z");

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, "2026-06-24T00:00:00.000Z");
  assert.equal(snapshot.caseCount, 3);
  assert.equal(snapshot.passedCaseCount, 2);
  assert.equal(snapshot.failedCaseCount, 1);
  assert.equal(snapshot.passRate, 0.666667);
  assert.equal(snapshot.finalCitationCount, 3);
  assert.equal(snapshot.visualCitationCount, 1);
  assert.deepEqual(snapshot.checkCounts, {
    access_boundary: 1,
    citation_required: 1,
    retrieval_recall: 2,
    visual_retrieval: 1
  });
  assert.deepEqual(snapshot.retrievalModeCounts, {
    keyword: 1,
    not_run: 1,
    visual: 1
  });
});

test("compares eval benchmarks and fails on quality regressions", () => {
  const summary = summaryFixture();
  const suite = summary.suites[0];
  assert.ok(suite);
  const baseline = buildEvalBenchmarkSnapshot(summary, "2026-06-24T00:00:00.000Z");
  const regressed = buildEvalBenchmarkSnapshot(
    {
      ...summary,
      passed: true,
      caseCount: 2,
      suites: [
        {
          ...suite,
          caseCount: 1,
          cases: suite.cases.slice(0, 1)
        }
      ]
    },
    "2026-06-24T01:00:00.000Z"
  );

  const result = compareEvalBenchmarks(baseline, regressed);

  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.includes("case count regressed")));
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('Eval check coverage for "visual_retrieval" regressed')
    )
  );
  assert.ok(
    result.failures.some((failure) => failure.includes("Visual retrieval eval coverage regressed"))
  );
});

test("renders an HTML eval report without exposing raw failure markup", () => {
  const summary = summaryFixture();
  const benchmark = buildEvalBenchmarkSnapshot(summary, "2026-06-24T00:00:00.000Z");
  const html = renderEvalHtmlReport({
    summary,
    benchmark,
    regression: compareEvalBenchmarks(benchmark, benchmark)
  });

  assert.match(html, /RAG Eval Report/u);
  assert.match(html, /No benchmark regressions detected/u);
  assert.match(html, /generic-docs/u);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
});

function summaryFixture(): RagEvalRunSummary {
  return {
    passed: false,
    suiteCount: 1,
    caseCount: 3,
    failures: ["generic-docs: denied-case: <script>alert(1)</script>"],
    suites: [
      {
        profileId: "generic-docs",
        namespaceId: "generic-docs",
        passed: false,
        goldenSetPath: "profiles/generic-docs/evals/golden.jsonl",
        adversarialSetPath: "profiles/generic-docs/evals/adversarial.jsonl",
        requiredChecks: ["retrieval_recall", "citation_required", "access_boundary"],
        coveredChecks: [
          "access_boundary",
          "citation_required",
          "retrieval_recall",
          "visual_retrieval"
        ],
        missingRequiredChecks: [],
        caseCount: 3,
        failures: ["denied-case: <script>alert(1)</script>"],
        cases: [
          {
            id: "golden-keyword",
            setKind: "golden",
            checks: ["retrieval_recall", "citation_required"],
            passed: true,
            failures: [],
            status: "succeeded",
            contextStatus: "answerable",
            retrievalMode: "keyword",
            retrievedDocumentIds: ["doc_policy"],
            finalCitationCount: 2,
            visualCitationCount: 0,
            traceId: "trace_keyword"
          },
          {
            id: "visual-case",
            setKind: "golden",
            checks: ["visual_retrieval", "retrieval_recall"],
            passed: true,
            failures: [],
            status: "succeeded",
            contextStatus: "answerable",
            retrievalMode: "visual",
            retrievedDocumentIds: ["doc_visual"],
            finalCitationCount: 1,
            visualCitationCount: 1,
            traceId: "trace_visual"
          },
          {
            id: "denied-case",
            setKind: "adversarial",
            checks: ["access_boundary"],
            passed: false,
            failures: ["<script>alert(1)</script>"],
            retrievedDocumentIds: [],
            finalCitationCount: 0
          }
        ]
      }
    ]
  };
}
