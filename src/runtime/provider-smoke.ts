import type { ProductionRagApp } from "./production-app.js";
import type { StartupSelfTestCheck, StartupSelfTestResult } from "./startup-self-test.js";
import { redactText } from "../shared/provider-boundary.js";

export const PROVIDER_SMOKE_SCHEMA_VERSION = 1;

export const PROVIDER_SMOKE_PROVIDERS = [
  "model",
  "embedding",
  "visual_embedding",
  "rerank",
  "grounding_judge"
] as const;

export type ProviderSmokeProvider = (typeof PROVIDER_SMOKE_PROVIDERS)[number];
export type ProviderSmokeStatus = "passed" | "failed";
export type ProviderSmokeProbeStatus = "passed" | "failed" | "skipped" | "missing";

export interface ProviderSmokePackOptions {
  readonly app: ProductionRagApp;
  readonly requestedAt?: string;
  readonly runId?: string;
  readonly requiredProviders?: readonly ProviderSmokeProvider[];
}

export interface ProviderSmokeProviderCoverage {
  readonly provider: ProviderSmokeProvider;
  readonly required: boolean;
  readonly status: ProviderSmokeProbeStatus;
  readonly checkIds: readonly string[];
  readonly passedCheckIds: readonly string[];
  readonly failedCheckIds: readonly string[];
  readonly skippedCheckIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProviderSmokeSummary {
  readonly requiredProviderCount: number;
  readonly passedRequiredProviderCount: number;
  readonly failedRequiredProviderCount: number;
  readonly providerProbeCheckCount: number;
  readonly failedProviderProbeCheckCount: number;
  readonly skippedProviderProbeCheckCount: number;
}

export interface ProviderSmokeReport {
  readonly schemaVersion: typeof PROVIDER_SMOKE_SCHEMA_VERSION;
  readonly status: ProviderSmokeStatus;
  readonly runId: string;
  readonly checkedAt: string;
  readonly profileId: string;
  readonly namespaceId: string;
  readonly retrievalMode: ProductionRagApp["profile"]["retrieval"]["mode"];
  readonly requiredProviders: readonly ProviderSmokeProvider[];
  readonly summary: ProviderSmokeSummary;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly providerCoverage: readonly ProviderSmokeProviderCoverage[];
  readonly selfTest: StartupSelfTestResult;
}

const PROVIDER_CHECK_IDS: Readonly<Record<ProviderSmokeProvider, readonly string[]>> = {
  model: ["model_provider_probe"],
  embedding: ["embedding_provider_probe"],
  visual_embedding: [
    "visual_embedding_provider_asset_probe",
    "visual_embedding_provider_query_probe"
  ],
  rerank: ["rerank_provider_probe"],
  grounding_judge: ["grounding_judge_provider_probe"]
};

export async function runProviderSmokePack(
  options: ProviderSmokePackOptions
): Promise<ProviderSmokeReport> {
  const checkedAt = options.requestedAt ?? new Date().toISOString();
  const requiredProviders = normalizeRequiredProviders(
    options.requiredProviders ?? defaultRequiredProviders(options.app)
  );
  const selfTest = redactSelfTest(
    await options.app.selfTest({
      probeProviders: true,
      requestedAt: checkedAt
    })
  );
  const providerCoverage = PROVIDER_SMOKE_PROVIDERS.map((provider) =>
    providerCoverageFor(provider, selfTest.checks, requiredProviders.includes(provider))
  );
  const failures = smokeFailures(selfTest, providerCoverage);
  const warnings = smokeWarnings(providerCoverage);
  const summary = smokeSummary(providerCoverage, selfTest.checks);

  return {
    schemaVersion: PROVIDER_SMOKE_SCHEMA_VERSION,
    status: failures.length === 0 ? "passed" : "failed",
    runId: options.runId ?? `provider_smoke_${safeTimestamp(checkedAt)}`,
    checkedAt,
    profileId: options.app.profile.id,
    namespaceId: options.app.profile.namespaceId,
    retrievalMode: options.app.profile.retrieval.mode,
    requiredProviders,
    summary,
    failures,
    warnings,
    providerCoverage,
    selfTest
  };
}

export function renderProviderSmokeHtmlReport(report: ProviderSmokeReport): string {
  const failedRows = report.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("");
  const coverageRows = report.providerCoverage
    .map(
      (coverage) => `<tr>
        <td>${escapeHtml(coverage.provider)}</td>
        <td>${coverage.required ? "yes" : "no"}</td>
        <td class="${escapeHtml(coverage.status)}">${escapeHtml(coverage.status)}</td>
        <td>${escapeHtml(coverage.checkIds.join(", ") || "none")}</td>
        <td>${escapeHtml(coverage.warnings.join(", ") || "-")}</td>
      </tr>`
    )
    .join("");
  const checkRows = report.selfTest.checks
    .map(
      (check) => `<tr>
        <td>${escapeHtml(check.id)}</td>
        <td>${escapeHtml(check.kind)}</td>
        <td class="${escapeHtml(check.status)}">${escapeHtml(check.status)}</td>
        <td>${escapeHtml(check.provider ?? "-")}</td>
        <td>${escapeHtml(check.modelName ?? "-")}</td>
        <td>${escapeHtml(check.message)}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Provider Smoke Report</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2933; }
      table { border-collapse: collapse; width: 100%; margin: 16px 0 28px; }
      th, td { border: 1px solid #d9e2ec; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f0f4f8; }
      .passed { color: #0f7b3b; font-weight: 700; }
      .failed { color: #b42318; font-weight: 700; }
      .skipped, .missing { color: #925a00; font-weight: 700; }
      .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; }
      code { background: #f0f4f8; padding: 2px 4px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Provider Smoke Report</h1>
    <div class="meta">
      <div>Status: <strong class="${escapeHtml(report.status)}">${escapeHtml(report.status)}</strong></div>
      <div>Run: <code>${escapeHtml(report.runId)}</code></div>
      <div>Checked at: ${escapeHtml(report.checkedAt)}</div>
      <div>Profile: ${escapeHtml(report.profileId)} / ${escapeHtml(report.namespaceId)}</div>
      <div>Retrieval mode: ${escapeHtml(report.retrievalMode)}</div>
      <div>Required providers: ${escapeHtml(report.requiredProviders.join(", ") || "none")}</div>
    </div>
    <h2>Summary</h2>
    <ul>
      <li>Required providers passed: ${report.summary.passedRequiredProviderCount}/${report.summary.requiredProviderCount}</li>
      <li>Provider probe checks failed: ${report.summary.failedProviderProbeCheckCount}</li>
      <li>Provider probe checks skipped: ${report.summary.skippedProviderProbeCheckCount}</li>
      <li>Startup self-test checks failed: ${report.selfTest.failedCount}</li>
    </ul>
    <h2>Failures</h2>
    <ul>${failedRows || "<li>None</li>"}</ul>
    <h2>Provider Coverage</h2>
    <table>
      <thead><tr><th>Provider</th><th>Required</th><th>Status</th><th>Checks</th><th>Warnings</th></tr></thead>
      <tbody>${coverageRows}</tbody>
    </table>
    <h2>Self-Test Checks</h2>
    <table>
      <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Provider</th><th>Model</th><th>Message</th></tr></thead>
      <tbody>${checkRows}</tbody>
    </table>
  </body>
</html>
`;
}

export function defaultRequiredProviders(app: ProductionRagApp): readonly ProviderSmokeProvider[] {
  const providers: ProviderSmokeProvider[] = ["model"];

  if (app.runtime.embeddingAdapter || app.config.providers.embeddingMode === "required") {
    providers.push("embedding");
  }

  if (
    app.runtime.visualEmbeddingAdapter ||
    app.visualEmbeddingAdapter ||
    app.config.providers.visualEmbeddingMode === "required"
  ) {
    providers.push("visual_embedding");
  }

  if (
    app.runtime.reranker?.mode === "model" ||
    app.config.providers.rerankProviderMode === "required"
  ) {
    providers.push("rerank");
  }

  if (
    app.runtime.groundingJudge ||
    app.config.providers.groundingJudgeProviderMode === "required"
  ) {
    providers.push("grounding_judge");
  }

  return normalizeRequiredProviders(providers);
}

function providerCoverageFor(
  provider: ProviderSmokeProvider,
  checks: readonly StartupSelfTestCheck[],
  required: boolean
): ProviderSmokeProviderCoverage {
  const expectedIds = PROVIDER_CHECK_IDS[provider];
  const providerChecks = expectedIds
    .map((id) => checks.find((check) => check.id === id))
    .filter((check): check is StartupSelfTestCheck => check !== undefined);
  const checkIds = providerChecks.map((check) => check.id);
  const passedCheckIds = providerChecks
    .filter((check) => check.status === "passed")
    .map((check) => check.id);
  const failedCheckIds = providerChecks
    .filter((check) => check.status === "failed")
    .map((check) => check.id);
  const skippedCheckIds = providerChecks
    .filter((check) => check.status === "skipped")
    .map((check) => check.id);

  return {
    provider,
    required,
    status: providerStatus(expectedIds, providerChecks),
    checkIds,
    passedCheckIds,
    failedCheckIds,
    skippedCheckIds,
    warnings: uniqueSorted(providerChecks.flatMap((check) => check.warnings ?? []))
  };
}

function redactSelfTest(selfTest: StartupSelfTestResult): StartupSelfTestResult {
  return {
    ...selfTest,
    checks: selfTest.checks.map((check) => ({
      ...check,
      message: redactText(check.message),
      ...(check.warnings === undefined
        ? {}
        : { warnings: check.warnings.map((warning) => redactText(warning)) })
    }))
  };
}

function providerStatus(
  expectedIds: readonly string[],
  checks: readonly StartupSelfTestCheck[]
): ProviderSmokeProbeStatus {
  if (checks.length !== expectedIds.length) {
    return "missing";
  }

  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  if (checks.some((check) => check.status === "skipped")) {
    return "skipped";
  }

  return "passed";
}

function smokeFailures(
  selfTest: StartupSelfTestResult,
  providerCoverage: readonly ProviderSmokeProviderCoverage[]
): readonly string[] {
  const failures = selfTest.checks
    .filter((check) => check.status === "failed")
    .map((check) => redactText(`Self-test check "${check.id}" failed: ${check.message}`));

  for (const coverage of providerCoverage) {
    if (coverage.required && coverage.status !== "passed") {
      failures.push(
        redactText(`Required provider "${coverage.provider}" smoke status was ${coverage.status}.`)
      );
    }
  }

  return failures;
}

function smokeWarnings(
  providerCoverage: readonly ProviderSmokeProviderCoverage[]
): readonly string[] {
  const warnings = providerCoverage.flatMap((coverage) => [
    ...coverage.warnings.map((warning) => redactText(`${coverage.provider}: ${warning}`)),
    ...(coverage.required || coverage.status === "passed"
      ? []
      : [`Optional provider "${coverage.provider}" smoke status was ${coverage.status}.`])
  ]);

  return uniqueSorted(warnings);
}

function smokeSummary(
  providerCoverage: readonly ProviderSmokeProviderCoverage[],
  checks: readonly StartupSelfTestCheck[]
): ProviderSmokeSummary {
  const requiredCoverage = providerCoverage.filter((coverage) => coverage.required);
  const providerProbeChecks = checks.filter((check) => check.kind === "provider_probe");

  return {
    requiredProviderCount: requiredCoverage.length,
    passedRequiredProviderCount: requiredCoverage.filter((coverage) => coverage.status === "passed")
      .length,
    failedRequiredProviderCount: requiredCoverage.filter((coverage) => coverage.status !== "passed")
      .length,
    providerProbeCheckCount: providerProbeChecks.length,
    failedProviderProbeCheckCount: providerProbeChecks.filter((check) => check.status === "failed")
      .length,
    skippedProviderProbeCheckCount: providerProbeChecks.filter(
      (check) => check.status === "skipped"
    ).length
  };
}

function normalizeRequiredProviders(
  providers: readonly ProviderSmokeProvider[]
): readonly ProviderSmokeProvider[] {
  return PROVIDER_SMOKE_PROVIDERS.filter((provider) => providers.includes(provider));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
