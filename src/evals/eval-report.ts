import type { RagEvalCaseResult, RagEvalRunSummary, RagEvalSuiteResult } from "./eval-types.js";

export interface RagEvalProfileBenchmark {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly failedCaseCount: number;
  readonly passRate: number;
  readonly requiredChecks: readonly string[];
  readonly coveredChecks: readonly string[];
  readonly missingRequiredChecks: readonly string[];
  readonly finalCitationCount: number;
  readonly visualCitationCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly checkCounts: Readonly<Record<string, number>>;
  readonly retrievalModeCounts: Readonly<Record<string, number>>;
}

export interface RagEvalBenchmarkSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly suiteCount: number;
  readonly caseCount: number;
  readonly passedCaseCount: number;
  readonly failedCaseCount: number;
  readonly passRate: number;
  readonly finalCitationCount: number;
  readonly visualCitationCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly checkCounts: Readonly<Record<string, number>>;
  readonly retrievalModeCounts: Readonly<Record<string, number>>;
  readonly profiles: readonly RagEvalProfileBenchmark[];
}

export interface RagEvalRegressionOptions {
  readonly maxPassRateDrop?: number;
  readonly allowCaseCountDecrease?: boolean;
  readonly allowCheckCoverageDecrease?: boolean;
  readonly allowVisualCoverageDecrease?: boolean;
  readonly allowCitationDecrease?: boolean;
}

export interface RagEvalRegressionDelta {
  readonly metric: string;
  readonly baseline: number | string;
  readonly current: number | string;
  readonly change: number | string;
}

export interface RagEvalRegressionResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly deltas: readonly RagEvalRegressionDelta[];
}

export interface RagEvalReportBundle {
  readonly summary: RagEvalRunSummary;
  readonly benchmark: RagEvalBenchmarkSnapshot;
  readonly regression?: RagEvalRegressionResult;
}

const SNAPSHOT_SCHEMA_VERSION = 1;

export function buildEvalBenchmarkSnapshot(
  summary: RagEvalRunSummary,
  generatedAt: string = new Date().toISOString()
): RagEvalBenchmarkSnapshot {
  const cases = summary.suites.flatMap((suite) => suite.cases);
  const profiles = summary.suites.map((suite) => profileBenchmark(suite));
  const passedCaseCount = cases.filter((evalCase) => evalCase.passed).length;
  const failedCaseCount = cases.length - passedCaseCount;

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    passed: summary.passed,
    suiteCount: summary.suiteCount,
    caseCount: summary.caseCount,
    passedCaseCount,
    failedCaseCount,
    passRate: rate(passedCaseCount, summary.caseCount),
    finalCitationCount: sum(cases.map((evalCase) => evalCase.finalCitationCount)),
    visualCitationCount: sum(cases.map((evalCase) => evalCase.visualCitationCount ?? 0)),
    statusCounts: countBy(cases.map((evalCase) => evalCase.status ?? "not_run")),
    checkCounts: countBy(cases.flatMap((evalCase) => evalCase.checks)),
    retrievalModeCounts: countBy(cases.map((evalCase) => evalCase.retrievalMode ?? "not_run")),
    profiles
  };
}

export function compareEvalBenchmarks(
  baseline: RagEvalBenchmarkSnapshot,
  current: RagEvalBenchmarkSnapshot,
  options: RagEvalRegressionOptions = {}
): RagEvalRegressionResult {
  validateSnapshot(baseline, "baseline");
  validateSnapshot(current, "current");

  const failures: string[] = [];
  const warnings: string[] = [];
  const deltas: RagEvalRegressionDelta[] = [
    numericDelta("caseCount", baseline.caseCount, current.caseCount),
    numericDelta("passedCaseCount", baseline.passedCaseCount, current.passedCaseCount),
    numericDelta("failedCaseCount", baseline.failedCaseCount, current.failedCaseCount),
    numericDelta("passRate", baseline.passRate, current.passRate),
    numericDelta("finalCitationCount", baseline.finalCitationCount, current.finalCitationCount),
    numericDelta("visualCitationCount", baseline.visualCitationCount, current.visualCitationCount)
  ];

  if (!options.allowCaseCountDecrease && current.caseCount < baseline.caseCount) {
    failures.push(`Eval case count regressed from ${baseline.caseCount} to ${current.caseCount}.`);
  }

  const maxPassRateDrop = options.maxPassRateDrop ?? 0;
  if (current.passRate + maxPassRateDrop < baseline.passRate) {
    failures.push(
      `Eval pass rate regressed from ${formatPercent(baseline.passRate)} to ${formatPercent(
        current.passRate
      )}.`
    );
  }

  if (!options.allowCheckCoverageDecrease) {
    for (const check of Object.keys(baseline.checkCounts).sort()) {
      if ((current.checkCounts[check] ?? 0) < (baseline.checkCounts[check] ?? 0)) {
        failures.push(
          `Eval check coverage for "${check}" regressed from ${
            baseline.checkCounts[check] ?? 0
          } to ${current.checkCounts[check] ?? 0}.`
        );
      }
    }
  }

  if (
    !options.allowVisualCoverageDecrease &&
    (current.retrievalModeCounts["visual"] ?? 0) < (baseline.retrievalModeCounts["visual"] ?? 0)
  ) {
    failures.push(
      `Visual retrieval eval coverage regressed from ${
        baseline.retrievalModeCounts["visual"] ?? 0
      } to ${current.retrievalModeCounts["visual"] ?? 0}.`
    );
  }

  if (!options.allowCitationDecrease) {
    if (current.finalCitationCount < baseline.finalCitationCount) {
      failures.push(
        `Final citation count regressed from ${baseline.finalCitationCount} to ${current.finalCitationCount}.`
      );
    }
    if (current.visualCitationCount < baseline.visualCitationCount) {
      failures.push(
        `Visual citation count regressed from ${baseline.visualCitationCount} to ${current.visualCitationCount}.`
      );
    }
  }

  compareProfiles(baseline, current, options, failures, warnings, deltas);

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    deltas
  };
}

export function renderEvalHtmlReport(bundle: RagEvalReportBundle): string {
  const { summary, benchmark, regression } = bundle;
  const statusClass = summary.passed && (regression?.passed ?? true) ? "pass" : "fail";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RAG Eval Report</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2937; background: #f8fafc; }
    main { max-width: 1180px; margin: 0 auto; }
    h1, h2 { color: #111827; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .metric { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    .pass { color: #047857; }
    .fail { color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0 28px; }
    th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 10px 12px; vertical-align: top; }
    th { background: #eef2f7; color: #374151; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    .failures { color: #991b1b; }
    .muted { color: #6b7280; }
  </style>
</head>
<body>
<main>
  <h1>RAG Eval Report</h1>
  <p class="${statusClass}"><strong>${escapeHtml(
    summary.passed && (regression?.passed ?? true) ? "Passed" : "Failed"
  )}</strong> · generated ${escapeHtml(benchmark.generatedAt)}</p>
  <section class="summary">
    ${metric("Suites", benchmark.suiteCount)}
    ${metric("Cases", benchmark.caseCount)}
    ${metric("Pass Rate", formatPercent(benchmark.passRate))}
    ${metric("Final Citations", benchmark.finalCitationCount)}
    ${metric("Visual Citations", benchmark.visualCitationCount)}
    ${metric("Visual Cases", benchmark.retrievalModeCounts["visual"] ?? 0)}
  </section>
  ${regression ? regressionSection(regression) : ""}
  <h2>Profiles</h2>
  <table>
    <thead><tr><th>Profile</th><th>Status</th><th>Cases</th><th>Pass Rate</th><th>Checks</th><th>Missing</th></tr></thead>
    <tbody>
      ${benchmark.profiles.map(profileRow).join("\n")}
    </tbody>
  </table>
  <h2>Cases</h2>
  <table>
    <thead><tr><th>Profile</th><th>Set</th><th>Case</th><th>Status</th><th>Retrieval</th><th>Citations</th><th>Checks</th><th>Failures</th></tr></thead>
    <tbody>
      ${summary.suites.flatMap((suite) => suite.cases.map((evalCase) => caseRow(suite, evalCase))).join("\n")}
    </tbody>
  </table>
</main>
</body>
</html>
`;
}

function profileBenchmark(suite: RagEvalSuiteResult): RagEvalProfileBenchmark {
  const passedCaseCount = suite.cases.filter((evalCase) => evalCase.passed).length;
  const failedCaseCount = suite.caseCount - passedCaseCount;

  return {
    profileId: suite.profileId,
    namespaceId: suite.namespaceId,
    passed: suite.passed,
    caseCount: suite.caseCount,
    passedCaseCount,
    failedCaseCount,
    passRate: rate(passedCaseCount, suite.caseCount),
    requiredChecks: suite.requiredChecks,
    coveredChecks: suite.coveredChecks,
    missingRequiredChecks: suite.missingRequiredChecks,
    finalCitationCount: sum(suite.cases.map((evalCase) => evalCase.finalCitationCount)),
    visualCitationCount: sum(suite.cases.map((evalCase) => evalCase.visualCitationCount ?? 0)),
    statusCounts: countBy(suite.cases.map((evalCase) => evalCase.status ?? "not_run")),
    checkCounts: countBy(suite.cases.flatMap((evalCase) => evalCase.checks)),
    retrievalModeCounts: countBy(suite.cases.map((evalCase) => evalCase.retrievalMode ?? "not_run"))
  };
}

function compareProfiles(
  baseline: RagEvalBenchmarkSnapshot,
  current: RagEvalBenchmarkSnapshot,
  options: RagEvalRegressionOptions,
  failures: string[],
  warnings: string[],
  deltas: RagEvalRegressionDelta[]
): void {
  const currentByProfile = new Map(current.profiles.map((profile) => [profile.profileId, profile]));

  for (const baselineProfile of baseline.profiles) {
    const currentProfile = currentByProfile.get(baselineProfile.profileId);
    if (!currentProfile) {
      failures.push(`Profile "${baselineProfile.profileId}" is missing from current eval run.`);
      continue;
    }

    deltas.push(
      numericDelta(
        `profiles.${baselineProfile.profileId}.caseCount`,
        baselineProfile.caseCount,
        currentProfile.caseCount
      ),
      numericDelta(
        `profiles.${baselineProfile.profileId}.passRate`,
        baselineProfile.passRate,
        currentProfile.passRate
      )
    );

    if (!options.allowCaseCountDecrease && currentProfile.caseCount < baselineProfile.caseCount) {
      failures.push(
        `Profile "${baselineProfile.profileId}" case count regressed from ${baselineProfile.caseCount} to ${currentProfile.caseCount}.`
      );
    }

    const maxPassRateDrop = options.maxPassRateDrop ?? 0;
    if (currentProfile.passRate + maxPassRateDrop < baselineProfile.passRate) {
      failures.push(
        `Profile "${baselineProfile.profileId}" pass rate regressed from ${formatPercent(
          baselineProfile.passRate
        )} to ${formatPercent(currentProfile.passRate)}.`
      );
    }

    for (const check of baselineProfile.coveredChecks) {
      if (!currentProfile.coveredChecks.includes(check)) {
        failures.push(
          `Profile "${baselineProfile.profileId}" no longer covers eval check "${check}".`
        );
      }
    }
  }

  for (const currentProfile of current.profiles) {
    if (!baseline.profiles.some((profile) => profile.profileId === currentProfile.profileId)) {
      warnings.push(`Profile "${currentProfile.profileId}" is new relative to the baseline.`);
    }
  }
}

function validateSnapshot(snapshot: RagEvalBenchmarkSnapshot, label: string): void {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${label} eval benchmark schemaVersion "${snapshot.schemaVersion}".`
    );
  }

  if (!Number.isInteger(snapshot.caseCount) || snapshot.caseCount < 0) {
    throw new Error(`${label} eval benchmark caseCount must be a non-negative integer.`);
  }

  if (!Number.isFinite(snapshot.passRate) || snapshot.passRate < 0 || snapshot.passRate > 1) {
    throw new Error(`${label} eval benchmark passRate must be between 0 and 1.`);
  }
}

function regressionSection(regression: RagEvalRegressionResult): string {
  const rows = regression.deltas
    .map(
      (delta) =>
        `<tr><td><code>${escapeHtml(delta.metric)}</code></td><td>${escapeHtml(
          String(delta.baseline)
        )}</td><td>${escapeHtml(String(delta.current))}</td><td>${escapeHtml(
          String(delta.change)
        )}</td></tr>`
    )
    .join("\n");
  const failures = regression.failures
    .map((failure) => `<li>${escapeHtml(failure)}</li>`)
    .join("\n");
  const warnings = regression.warnings
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join("\n");

  return `<h2>Regression</h2>
  ${regression.passed ? `<p class="pass">No benchmark regressions detected.</p>` : `<ul class="failures">${failures}</ul>`}
  ${regression.warnings.length > 0 ? `<ul class="muted">${warnings}</ul>` : ""}
  <table>
    <thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function profileRow(profile: RagEvalProfileBenchmark): string {
  return `<tr>
    <td><code>${escapeHtml(profile.profileId)}</code><br><span class="muted">${escapeHtml(profile.namespaceId)}</span></td>
    <td class="${profile.passed ? "pass" : "fail"}">${profile.passed ? "passed" : "failed"}</td>
    <td>${profile.passedCaseCount}/${profile.caseCount}</td>
    <td>${formatPercent(profile.passRate)}</td>
    <td>${profile.coveredChecks.map((check) => `<code>${escapeHtml(check)}</code>`).join(" ")}</td>
    <td>${profile.missingRequiredChecks.map((check) => `<code>${escapeHtml(check)}</code>`).join(" ") || "none"}</td>
  </tr>`;
}

function caseRow(suite: RagEvalSuiteResult, evalCase: RagEvalCaseResult): string {
  return `<tr>
    <td><code>${escapeHtml(suite.profileId)}</code></td>
    <td>${escapeHtml(evalCase.setKind)}</td>
    <td><code>${escapeHtml(evalCase.id)}</code>${evalCase.traceId ? `<br><span class="muted">${escapeHtml(evalCase.traceId)}</span>` : ""}</td>
    <td class="${evalCase.passed ? "pass" : "fail"}">${evalCase.passed ? "passed" : "failed"}${evalCase.status ? `<br><span class="muted">${escapeHtml(evalCase.status)}</span>` : ""}</td>
    <td>${escapeHtml(evalCase.retrievalMode ?? "not_run")}</td>
    <td>${evalCase.finalCitationCount}${evalCase.visualCitationCount ? ` (${evalCase.visualCitationCount} visual)` : ""}</td>
    <td>${evalCase.checks.map((check) => `<code>${escapeHtml(check)}</code>`).join(" ")}</td>
    <td>${evalCase.failures.length > 0 ? `<ul class="failures">${evalCase.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul>` : "none"}</td>
  </tr>`;
}

function metric(label: string, value: number | string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function numericDelta(
  metricName: string,
  baseline: number,
  current: number
): RagEvalRegressionDelta {
  return {
    metric: metricName,
    baseline,
    current,
    change: round(current - baseline)
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([first], [second]) => first.localeCompare(second))
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
