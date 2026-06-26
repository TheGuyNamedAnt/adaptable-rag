import {
  compareRunTraces,
  summarizeRunTrace,
  type TraceForensicsSeverity,
  type TraceReplayComparison,
  type TraceReplayStatus,
  type TraceSummary
} from "../observability/trace-forensics.js";
import type { RagEvalCaseResult, RagEvalRunSummary, RagEvalSuiteResult } from "./eval-types.js";

export const EVAL_TRACE_REPLAY_SCHEMA_VERSION = 1;

export type EvalTraceReplayStatus = "passed" | "failed";

export interface EvalTraceReplayTarget {
  readonly traceId?: string;
  readonly profileId?: string;
  readonly caseId?: string;
}

export interface EvalTraceReplayOptions {
  readonly generatedAt?: string;
  readonly target?: EvalTraceReplayTarget;
}

export interface EvalTraceReplayCaseComparison {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly caseId: string;
  readonly setKind: string;
  readonly status: TraceReplayStatus;
  readonly severity: TraceForensicsSeverity;
  readonly baselinePassed: boolean;
  readonly currentPassed: boolean;
  readonly baselineStatus?: string;
  readonly currentStatus?: string;
  readonly baselineTraceId?: string;
  readonly currentTraceId?: string;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly baselineTrace?: TraceSummary;
  readonly currentTrace?: TraceSummary;
  readonly traceComparison?: TraceReplayComparison;
}

export interface EvalTraceReplayReport {
  readonly schemaVersion: typeof EVAL_TRACE_REPLAY_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: EvalTraceReplayStatus;
  readonly target?: EvalTraceReplayTarget;
  readonly baseline: EvalTraceReplayRunSummary;
  readonly current: EvalTraceReplayRunSummary;
  readonly caseCount: number;
  readonly matchedCount: number;
  readonly mismatchedCount: number;
  readonly notComparableCount: number;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly cases: readonly EvalTraceReplayCaseComparison[];
}

export interface EvalTraceReplayRunSummary {
  readonly passed: boolean;
  readonly suiteCount: number;
  readonly caseCount: number;
}

export function buildEvalTraceReplayReport(
  baselineSummary: RagEvalRunSummary,
  currentSummary: RagEvalRunSummary,
  options: EvalTraceReplayOptions = {}
): EvalTraceReplayReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const baselineCases = selectedCases(baselineSummary, options.target);
  const currentCaseMap = new Map(
    flattenCases(currentSummary).map((entry) => [
      caseKey(entry.suite.profileId, entry.case.id),
      entry
    ])
  );
  const comparisons = baselineCases.map((entry) => {
    const current = currentCaseMap.get(caseKey(entry.suite.profileId, entry.case.id));
    return compareEvalCase(entry.suite, entry.case, current?.suite, current?.case);
  });
  const failures = [
    ...(baselineCases.length === 0 ? ["Replay target did not match any baseline eval case."] : []),
    ...comparisons.flatMap((comparison) =>
      comparison.failures.map(
        (failure) => `${comparison.profileId}/${comparison.caseId}: ${failure}`
      )
    )
  ];
  const warnings = [
    ...targetWarnings(baselineCases, options.target),
    ...comparisons.flatMap((comparison) =>
      comparison.warnings.map(
        (warning) => `${comparison.profileId}/${comparison.caseId}: ${warning}`
      )
    )
  ];

  return {
    schemaVersion: EVAL_TRACE_REPLAY_SCHEMA_VERSION,
    generatedAt,
    status: failures.length === 0 ? "passed" : "failed",
    ...(options.target === undefined ? {} : { target: options.target }),
    baseline: runSummary(baselineSummary),
    current: runSummary(currentSummary),
    caseCount: comparisons.length,
    matchedCount: comparisons.filter((comparison) => comparison.status === "matched").length,
    mismatchedCount: comparisons.filter((comparison) => comparison.status === "mismatched").length,
    notComparableCount: comparisons.filter((comparison) => comparison.status === "not_comparable")
      .length,
    failures,
    warnings,
    cases: comparisons
  };
}

export function renderEvalTraceReplayHtmlReport(report: EvalTraceReplayReport): string {
  const statusClass = report.status === "passed" ? "pass" : "fail";
  const target = report.target
    ? [
        report.target.profileId ? `profile=${report.target.profileId}` : "",
        report.target.caseId ? `case=${report.target.caseId}` : "",
        report.target.traceId ? `trace=${report.target.traceId}` : ""
      ]
        .filter(Boolean)
        .join(", ")
    : "all baseline eval cases";
  const failures = report.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("");
  const warnings = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const rows = report.cases.map(caseRow).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RAG Trace Replay Report</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2937; background: #f8fafc; }
    main { max-width: 1180px; margin: 0 auto; }
    h1, h2 { color: #111827; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .metric { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    .pass, .matched, .info { color: #047857; }
    .fail, .mismatched, .critical, .high { color: #b91c1c; }
    .warning, .not_comparable { color: #92400e; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0 28px; }
    th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 10px 12px; vertical-align: top; }
    th { background: #eef2f7; color: #374151; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    .muted { color: #6b7280; }
  </style>
</head>
<body>
<main>
  <h1>RAG Trace Replay Report</h1>
  <p class="${statusClass}"><strong>${escapeHtml(report.status)}</strong> · generated ${escapeHtml(report.generatedAt)}</p>
  <p>Target: <code>${escapeHtml(target)}</code></p>
  <section class="summary">
    ${metric("Cases", report.caseCount)}
    ${metric("Matched", report.matchedCount)}
    ${metric("Mismatched", report.mismatchedCount)}
    ${metric("Not Comparable", report.notComparableCount)}
    ${metric("Baseline Cases", report.baseline.caseCount)}
    ${metric("Current Cases", report.current.caseCount)}
  </section>
  <h2>Failures</h2>
  <ul>${failures || "<li>None</li>"}</ul>
  ${report.warnings.length > 0 ? `<h2>Warnings</h2><ul>${warnings}</ul>` : ""}
  <h2>Cases</h2>
  <table>
    <thead><tr><th>Profile / Case</th><th>Status</th><th>Eval Status</th><th>Trace</th><th>Findings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</main>
</body>
</html>
`;
}

function compareEvalCase(
  baselineSuite: RagEvalSuiteResult,
  baselineCase: RagEvalCaseResult,
  currentSuite: RagEvalSuiteResult | undefined,
  currentCase: RagEvalCaseResult | undefined
): EvalTraceReplayCaseComparison {
  if (!currentSuite || !currentCase) {
    return {
      profileId: baselineSuite.profileId,
      namespaceId: baselineSuite.namespaceId,
      caseId: baselineCase.id,
      setKind: baselineCase.setKind,
      status: "mismatched",
      severity: "high",
      baselinePassed: baselineCase.passed,
      currentPassed: false,
      ...(baselineCase.status === undefined ? {} : { baselineStatus: baselineCase.status }),
      ...(baselineCase.traceId === undefined ? {} : { baselineTraceId: baselineCase.traceId }),
      failures: ["Current eval run is missing this baseline case."],
      warnings: [],
      ...(baselineCase.trace === undefined
        ? {}
        : { baselineTrace: summarizeRunTrace(baselineCase.trace) })
    };
  }

  const failures: string[] = [];
  const warnings: string[] = [];
  if (baselineCase.passed !== currentCase.passed) {
    failures.push(
      `Eval pass state changed from ${String(baselineCase.passed)} to ${String(
        currentCase.passed
      )}.`
    );
  }
  compareOptional("status", baselineCase.status, currentCase.status, failures);
  compareOptional("contextStatus", baselineCase.contextStatus, currentCase.contextStatus, failures);
  compareOptional("retrievalMode", baselineCase.retrievalMode, currentCase.retrievalMode, failures);
  compareStringArray(
    "retrievedDocumentIds",
    baselineCase.retrievedDocumentIds,
    currentCase.retrievedDocumentIds,
    failures
  );
  compareNumber(
    "finalCitationCount",
    baselineCase.finalCitationCount,
    currentCase.finalCitationCount,
    failures
  );
  compareNumber(
    "visualCitationCount",
    baselineCase.visualCitationCount ?? 0,
    currentCase.visualCitationCount ?? 0,
    failures
  );

  const traceComparison = compareRunTraces(baselineCase.trace, currentCase.trace);
  failures.push(...traceComparison.failures);
  warnings.push(...traceComparison.warnings);
  if (traceComparison.status === "not_comparable") {
    failures.push("Trace comparison was not comparable.");
  }

  return {
    profileId: baselineSuite.profileId,
    namespaceId: baselineSuite.namespaceId,
    caseId: baselineCase.id,
    setKind: baselineCase.setKind,
    status: failures.length === 0 ? traceComparison.status : "mismatched",
    severity: failures.length === 0 ? traceComparison.severity : "high",
    baselinePassed: baselineCase.passed,
    currentPassed: currentCase.passed,
    ...(baselineCase.status === undefined ? {} : { baselineStatus: baselineCase.status }),
    ...(currentCase.status === undefined ? {} : { currentStatus: currentCase.status }),
    ...(baselineCase.traceId === undefined ? {} : { baselineTraceId: baselineCase.traceId }),
    ...(currentCase.traceId === undefined ? {} : { currentTraceId: currentCase.traceId }),
    failures,
    warnings,
    ...(traceComparison.baseline === undefined ? {} : { baselineTrace: traceComparison.baseline }),
    ...(traceComparison.current === undefined ? {} : { currentTrace: traceComparison.current }),
    traceComparison
  };
}

function selectedCases(
  summary: RagEvalRunSummary,
  target: EvalTraceReplayTarget | undefined
): readonly { readonly suite: RagEvalSuiteResult; readonly case: RagEvalCaseResult }[] {
  const cases = flattenCases(summary).filter((entry) => {
    if (target?.profileId && entry.suite.profileId !== target.profileId) {
      return false;
    }
    if (target?.caseId && entry.case.id !== target.caseId) {
      return false;
    }
    if (target?.traceId && entry.case.traceId !== target.traceId) {
      return false;
    }
    return true;
  });

  return cases;
}

function targetWarnings(
  baselineCases: readonly unknown[],
  target: EvalTraceReplayTarget | undefined
): readonly string[] {
  if (!target || baselineCases.length > 0) {
    return [];
  }

  return ["Replay target did not match any baseline eval case."];
}

function flattenCases(
  summary: RagEvalRunSummary
): readonly { readonly suite: RagEvalSuiteResult; readonly case: RagEvalCaseResult }[] {
  return summary.suites.flatMap((suite) =>
    suite.cases.map((evalCase) => ({ suite, case: evalCase }))
  );
}

function runSummary(summary: RagEvalRunSummary): EvalTraceReplayRunSummary {
  return {
    passed: summary.passed,
    suiteCount: summary.suiteCount,
    caseCount: summary.caseCount
  };
}

function caseKey(profileId: string, caseId: string): string {
  return `${profileId}:${caseId}`;
}

function compareOptional(
  field: string,
  baseline: string | undefined,
  current: string | undefined,
  failures: string[]
): void {
  if ((baseline ?? "missing") !== (current ?? "missing")) {
    failures.push(
      `Case field "${field}" changed from "${baseline ?? "missing"}" to "${current ?? "missing"}".`
    );
  }
}

function compareNumber(field: string, baseline: number, current: number, failures: string[]): void {
  if (baseline !== current) {
    failures.push(`Case field "${field}" changed from ${baseline} to ${current}.`);
  }
}

function compareStringArray(
  field: string,
  baseline: readonly string[],
  current: readonly string[],
  failures: string[]
): void {
  const baselineValues = [...baseline].sort();
  const currentValues = [...current].sort();
  if (
    baselineValues.length !== currentValues.length ||
    baselineValues.some((value, index) => value !== currentValues[index])
  ) {
    failures.push(
      `Case field "${field}" changed from [${baselineValues.join(", ")}] to [${currentValues.join(", ")}].`
    );
  }
}

function caseRow(comparison: EvalTraceReplayCaseComparison): string {
  const findings = [
    ...comparison.failures.map((failure) => `<li class="fail">${escapeHtml(failure)}</li>`),
    ...comparison.warnings.map((warning) => `<li class="warning">${escapeHtml(warning)}</li>`)
  ].join("");

  return `<tr>
    <td><code>${escapeHtml(comparison.profileId)}</code><br><code>${escapeHtml(comparison.caseId)}</code><br><span class="muted">${escapeHtml(comparison.setKind)}</span></td>
    <td class="${escapeHtml(comparison.status)}">${escapeHtml(comparison.status)}<br><span class="${escapeHtml(comparison.severity)}">${escapeHtml(comparison.severity)}</span></td>
    <td>baseline: ${comparison.baselinePassed ? "passed" : "failed"}${comparison.baselineStatus ? ` / ${escapeHtml(comparison.baselineStatus)}` : ""}<br>current: ${comparison.currentPassed ? "passed" : "failed"}${comparison.currentStatus ? ` / ${escapeHtml(comparison.currentStatus)}` : ""}</td>
    <td>baseline: <code>${escapeHtml(comparison.baselineTraceId ?? "missing")}</code><br>current: <code>${escapeHtml(comparison.currentTraceId ?? "missing")}</code></td>
    <td>${findings ? `<ul>${findings}</ul>` : "none"}</td>
  </tr>`;
}

function metric(label: string, value: number | string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
