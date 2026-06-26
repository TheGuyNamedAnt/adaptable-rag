import type { AlertDeliveryReport } from "../observability/alert-delivery.js";
import type { SloAlertEvent, SloEvaluationReport, SloRunbook } from "../observability/slo.js";
import { summarizeRunTrace, type TraceSummary } from "../observability/trace-forensics.js";
import type { ProviderSmokeReport } from "../runtime/provider-smoke.js";
import type { RagEvalBenchmarkSnapshot } from "./eval-report.js";
import type { EvalTraceReplayCaseComparison, EvalTraceReplayReport } from "./eval-replay.js";
import type { RagEvalRunSummary } from "./eval-types.js";

export const RAG_INCIDENT_BUNDLE_SCHEMA_VERSION = 1;

export type RagIncidentStatus = "healthy" | "watch" | "incident";
export type RagIncidentSeverity = "none" | "warning" | "high" | "critical";
export type RagIncidentArtifactStatus = "present" | "missing";

export interface RagIncidentArtifactPaths {
  readonly evalBenchmark?: string;
  readonly evalSummary?: string;
  readonly traceReplay?: string;
  readonly sloReport?: string;
  readonly alertDelivery?: string;
  readonly providerSmoke?: string;
}

export interface RagIncidentBundleInput {
  readonly incidentId?: string;
  readonly title?: string;
  readonly generatedAt?: string;
  readonly artifactPaths?: RagIncidentArtifactPaths;
  readonly evalBenchmark?: RagEvalBenchmarkSnapshot;
  readonly evalSummary?: RagEvalRunSummary;
  readonly traceReplay?: EvalTraceReplayReport;
  readonly sloReport?: SloEvaluationReport;
  readonly alertDelivery?: AlertDeliveryReport;
  readonly providerSmoke?: ProviderSmokeReport;
}

export interface RagIncidentSourceArtifact {
  readonly id: keyof RagIncidentArtifactPaths;
  readonly label: string;
  readonly status: RagIncidentArtifactStatus;
  readonly path?: string;
}

export interface RagIncidentMetrics {
  readonly evalPassed?: boolean;
  readonly evalCaseCount?: number;
  readonly evalFailedCaseCount?: number;
  readonly evalPassRate?: number;
  readonly traceReplayStatus?: string;
  readonly traceReplayCaseCount?: number;
  readonly traceReplayMismatchedCount?: number;
  readonly traceReplayNotComparableCount?: number;
  readonly sloStatus?: string;
  readonly sloAlertCount?: number;
  readonly criticalAlertCount?: number;
  readonly highAlertCount?: number;
  readonly warningAlertCount?: number;
  readonly alertDeliveryStatus?: string;
  readonly deliveredAlertCount?: number;
  readonly failedAlertCount?: number;
  readonly skippedAlertCount?: number;
  readonly providerSmokeStatus?: string;
  readonly failedRequiredProviderCount?: number;
}

export interface RagIncidentImpactedProfile {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly caseCount: number;
  readonly failedCaseCount: number;
  readonly missingRequiredChecks: readonly string[];
}

export interface RagIncidentRunbook {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: SloAlertEvent["severity"];
  readonly category: SloAlertEvent["category"];
  readonly runbook: SloRunbook;
}

export interface RagIncidentTraceEvidence {
  readonly profileId: string;
  readonly namespaceId: string;
  readonly caseId: string;
  readonly setKind?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly baselineTrace?: TraceSummary;
  readonly currentTrace?: TraceSummary;
  readonly trace?: TraceSummary;
}

export interface RagIncidentFinding {
  readonly severity: RagIncidentSeverity;
  readonly source: string;
  readonly message: string;
}

export interface RagIncidentBundle {
  readonly schemaVersion: typeof RAG_INCIDENT_BUNDLE_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly generatedAt: string;
  readonly title: string;
  readonly status: RagIncidentStatus;
  readonly severity: RagIncidentSeverity;
  readonly summary: string;
  readonly sourceArtifacts: readonly RagIncidentSourceArtifact[];
  readonly metrics: RagIncidentMetrics;
  readonly impactedProfiles: readonly RagIncidentImpactedProfile[];
  readonly runbooks: readonly RagIncidentRunbook[];
  readonly traceEvidence: readonly RagIncidentTraceEvidence[];
  readonly findings: readonly RagIncidentFinding[];
  readonly recommendedActions: readonly string[];
  readonly evidenceBoundary: readonly string[];
}

const ARTIFACT_LABELS: Readonly<Record<keyof RagIncidentArtifactPaths, string>> = {
  evalBenchmark: "Eval benchmark",
  evalSummary: "Eval safe summary",
  traceReplay: "Trace replay",
  sloReport: "SLO report",
  alertDelivery: "Alert delivery",
  providerSmoke: "Provider smoke"
};

export function buildRagIncidentBundle(input: RagIncidentBundleInput): RagIncidentBundle {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const incidentId = input.incidentId ?? `rag_incident_${safeTimestamp(generatedAt)}`;
  const findings = incidentFindings(input);
  const severity = highestIncidentSeverity(findings);
  const status = incidentStatus(severity);

  return {
    schemaVersion: RAG_INCIDENT_BUNDLE_SCHEMA_VERSION,
    incidentId,
    generatedAt,
    title: input.title ?? defaultTitle(status, severity),
    status,
    severity,
    summary: summaryFor(input, status, severity),
    sourceArtifacts: sourceArtifacts(input),
    metrics: metricsFor(input),
    impactedProfiles: impactedProfiles(input.evalBenchmark),
    runbooks: runbooksFor(input.sloReport),
    traceEvidence: traceEvidenceFor(input),
    findings,
    recommendedActions: recommendedActionsFor(input, findings),
    evidenceBoundary: [
      "Includes artifact paths, ids, statuses, counts, runbooks, failures, warnings, and safe trace summaries.",
      "Excludes raw user questions, raw source bodies, rendered context, generated answer text, bearer tokens, API keys, routing keys, and full principal claims.",
      "Use linked local artifacts for deeper inspection without copying raw prompts or source content into the postmortem."
    ]
  };
}

export function renderRagIncidentMarkdown(bundle: RagIncidentBundle): string {
  return [
    `# ${md(bundle.title)}`,
    "",
    `- Incident ID: \`${md(bundle.incidentId)}\``,
    `- Generated: \`${md(bundle.generatedAt)}\``,
    `- Status: **${md(bundle.status)}**`,
    `- Severity: **${md(bundle.severity)}**`,
    "",
    "## Executive Summary",
    "",
    md(bundle.summary),
    "",
    "## Current Impact",
    "",
    currentImpact(bundle),
    "",
    "## Detection",
    "",
    detection(bundle),
    "",
    "## Artifact Manifest",
    "",
    artifactTable(bundle),
    "",
    "## Findings",
    "",
    findingList(bundle),
    "",
    "## Runbooks",
    "",
    runbookList(bundle),
    "",
    "## Safe Trace Evidence",
    "",
    traceList(bundle),
    "",
    "## Immediate Actions",
    "",
    actionList(bundle.recommendedActions),
    "",
    "## Follow-Ups",
    "",
    "- Assign owners for unresolved high or critical findings.",
    "- Add or update eval cases for every confirmed regression.",
    "- Update the baseline only after review confirms the behavior change is intentional.",
    "",
    "## Evidence Boundary",
    "",
    actionList(bundle.evidenceBoundary),
    ""
  ].join("\n");
}

function metricsFor(input: RagIncidentBundleInput): RagIncidentMetrics {
  return {
    ...(input.evalBenchmark === undefined
      ? {}
      : {
          evalPassed: input.evalBenchmark.passed,
          evalCaseCount: input.evalBenchmark.caseCount,
          evalFailedCaseCount: input.evalBenchmark.failedCaseCount,
          evalPassRate: input.evalBenchmark.passRate
        }),
    ...(input.traceReplay === undefined
      ? {}
      : {
          traceReplayStatus: input.traceReplay.status,
          traceReplayCaseCount: input.traceReplay.caseCount,
          traceReplayMismatchedCount: input.traceReplay.mismatchedCount,
          traceReplayNotComparableCount: input.traceReplay.notComparableCount
        }),
    ...(input.sloReport === undefined
      ? {}
      : {
          sloStatus: input.sloReport.status,
          sloAlertCount: input.sloReport.alertCount,
          criticalAlertCount: input.sloReport.criticalAlertCount,
          highAlertCount: input.sloReport.highAlertCount,
          warningAlertCount: input.sloReport.warningAlertCount
        }),
    ...(input.alertDelivery === undefined
      ? {}
      : {
          alertDeliveryStatus: input.alertDelivery.status,
          deliveredAlertCount: input.alertDelivery.deliveredAlertCount,
          failedAlertCount: input.alertDelivery.failedAlertCount,
          skippedAlertCount: input.alertDelivery.skippedAlertCount
        }),
    ...(input.providerSmoke === undefined
      ? {}
      : {
          providerSmokeStatus: input.providerSmoke.status,
          failedRequiredProviderCount: input.providerSmoke.summary.failedRequiredProviderCount
        })
  };
}

function sourceArtifacts(input: RagIncidentBundleInput): readonly RagIncidentSourceArtifact[] {
  const artifactPaths = input.artifactPaths ?? {};
  return (Object.keys(ARTIFACT_LABELS) as Array<keyof RagIncidentArtifactPaths>).map((id) => ({
    id,
    label: ARTIFACT_LABELS[id],
    status: artifactPresent(input, id) ? "present" : "missing",
    ...(artifactPaths[id] === undefined ? {} : { path: artifactPaths[id] })
  }));
}

function artifactPresent(
  input: RagIncidentBundleInput,
  id: keyof RagIncidentArtifactPaths
): boolean {
  switch (id) {
    case "evalBenchmark":
      return input.evalBenchmark !== undefined;
    case "evalSummary":
      return input.evalSummary !== undefined;
    case "traceReplay":
      return input.traceReplay !== undefined;
    case "sloReport":
      return input.sloReport !== undefined;
    case "alertDelivery":
      return input.alertDelivery !== undefined;
    case "providerSmoke":
      return input.providerSmoke !== undefined;
  }
}

function impactedProfiles(
  benchmark: RagEvalBenchmarkSnapshot | undefined
): readonly RagIncidentImpactedProfile[] {
  return (
    benchmark?.profiles
      .filter(
        (profile) =>
          !profile.passed || profile.failedCaseCount > 0 || profile.missingRequiredChecks.length > 0
      )
      .map((profile) => ({
        profileId: profile.profileId,
        namespaceId: profile.namespaceId,
        passed: profile.passed,
        caseCount: profile.caseCount,
        failedCaseCount: profile.failedCaseCount,
        missingRequiredChecks: profile.missingRequiredChecks
      })) ?? []
  );
}

function runbooksFor(sloReport: SloEvaluationReport | undefined): readonly RagIncidentRunbook[] {
  if (!sloReport) {
    return [];
  }

  const byRuleId = new Map<string, RagIncidentRunbook>();
  for (const alert of sloReport.alerts) {
    if (!byRuleId.has(alert.ruleId)) {
      byRuleId.set(alert.ruleId, {
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        severity: alert.severity,
        category: alert.category,
        runbook: alert.runbook
      });
    }
  }
  return [...byRuleId.values()].sort((first, second) => first.ruleId.localeCompare(second.ruleId));
}

function traceEvidenceFor(input: RagIncidentBundleInput): readonly RagIncidentTraceEvidence[] {
  const evidence: RagIncidentTraceEvidence[] = [];

  for (const comparison of input.traceReplay?.cases ?? []) {
    evidence.push(traceEvidenceFromReplay(comparison));
  }

  for (const suite of input.evalSummary?.suites ?? []) {
    for (const evalCase of suite.cases) {
      if (evalCase.trace) {
        evidence.push({
          profileId: suite.profileId,
          namespaceId: suite.namespaceId,
          caseId: evalCase.id,
          setKind: evalCase.setKind,
          trace: summarizeRunTrace(evalCase.trace),
          ...(evalCase.status === undefined ? {} : { status: evalCase.status })
        });
      }
    }
  }

  return dedupeTraceEvidence(evidence).slice(0, 50);
}

function traceEvidenceFromReplay(
  comparison: EvalTraceReplayCaseComparison
): RagIncidentTraceEvidence {
  return {
    profileId: comparison.profileId,
    namespaceId: comparison.namespaceId,
    caseId: comparison.caseId,
    setKind: comparison.setKind,
    status: comparison.status,
    severity: comparison.severity,
    ...(comparison.baselineTrace === undefined ? {} : { baselineTrace: comparison.baselineTrace }),
    ...(comparison.currentTrace === undefined ? {} : { currentTrace: comparison.currentTrace })
  };
}

function incidentFindings(input: RagIncidentBundleInput): readonly RagIncidentFinding[] {
  const findings: RagIncidentFinding[] = [];

  if (input.evalBenchmark && !input.evalBenchmark.passed) {
    findings.push({
      severity: "critical",
      source: "eval",
      message: `${input.evalBenchmark.failedCaseCount} eval case(s) failed.`
    });
  }

  if (input.traceReplay && input.traceReplay.status === "failed") {
    findings.push({
      severity: input.traceReplay.mismatchedCount > 0 ? "critical" : "high",
      source: "trace_replay",
      message: `${input.traceReplay.mismatchedCount} trace replay mismatch(es), ${input.traceReplay.notComparableCount} not comparable.`
    });
    findings.push(
      ...input.traceReplay.failures.map((message) => finding("high", "trace_replay", message))
    );
    findings.push(
      ...input.traceReplay.warnings.map((message) => finding("warning", "trace_replay", message))
    );
  }

  if (input.sloReport) {
    for (const alert of input.sloReport.alerts) {
      findings.push({
        severity: incidentSeverityForAlert(alert.severity),
        source: "slo",
        message: `${alert.ruleId}: ${alert.message}`
      });
    }
  }

  if (input.alertDelivery && input.alertDelivery.status === "failed") {
    findings.push({
      severity: "high",
      source: "alert_delivery",
      message: `${input.alertDelivery.failedAlertCount} alert delivery failure(s).`
    });
    findings.push(
      ...input.alertDelivery.errors.map((message) => finding("high", "alert_delivery", message))
    );
  }

  if (input.providerSmoke && input.providerSmoke.status === "failed") {
    findings.push({
      severity: "critical",
      source: "provider_smoke",
      message: `${input.providerSmoke.summary.failedRequiredProviderCount} required provider(s) failed smoke checks.`
    });
    findings.push(
      ...input.providerSmoke.failures.map((message) => finding("high", "provider_smoke", message))
    );
  }

  return dedupeFindings(findings);
}

function recommendedActionsFor(
  input: RagIncidentBundleInput,
  findings: readonly RagIncidentFinding[]
): readonly string[] {
  const actions = new Set<string>();

  for (const runbook of runbooksFor(input.sloReport)) {
    for (const action of runbook.runbook.immediateActions) {
      actions.add(action);
    }
    actions.add(runbook.runbook.escalation);
  }

  if (findings.length === 0) {
    actions.add("Keep the bundle with the release artifacts for audit evidence.");
  }

  if (input.traceReplay?.status === "failed") {
    actions.add("Open the trace replay report and compare the first mismatched case.");
  }

  if (input.evalBenchmark && !input.evalBenchmark.passed) {
    actions.add(
      "Open the eval report and patch the layer responsible for the first failing check."
    );
  }

  if (input.alertDelivery?.status === "failed") {
    actions.add("Confirm alert sink credentials and delivery endpoint before re-sending alerts.");
  }

  return [...actions].sort();
}

function highestIncidentSeverity(findings: readonly RagIncidentFinding[]): RagIncidentSeverity {
  const order: Readonly<Record<RagIncidentSeverity, number>> = {
    none: 0,
    warning: 1,
    high: 2,
    critical: 3
  };

  return findings.reduce<RagIncidentSeverity>(
    (highest, finding) => (order[finding.severity] > order[highest] ? finding.severity : highest),
    "none"
  );
}

function incidentStatus(severity: RagIncidentSeverity): RagIncidentStatus {
  if (severity === "critical" || severity === "high") {
    return "incident";
  }
  if (severity === "warning") {
    return "watch";
  }
  return "healthy";
}

function defaultTitle(status: RagIncidentStatus, severity: RagIncidentSeverity): string {
  return status === "healthy"
    ? "RAG Operational Evidence Bundle"
    : `RAG ${severity} ${status} bundle`;
}

function summaryFor(
  input: RagIncidentBundleInput,
  status: RagIncidentStatus,
  severity: RagIncidentSeverity
): string {
  const metrics = metricsFor(input);
  return [
    `Bundle status is ${status} with ${severity} severity.`,
    metrics.evalCaseCount === undefined
      ? "Eval benchmark is missing."
      : `Eval benchmark covered ${metrics.evalCaseCount} case(s) with ${metrics.evalFailedCaseCount ?? 0} failure(s).`,
    metrics.traceReplayCaseCount === undefined
      ? "Trace replay report is missing."
      : `Trace replay compared ${metrics.traceReplayCaseCount} case(s) with ${metrics.traceReplayMismatchedCount ?? 0} mismatch(es).`,
    metrics.sloAlertCount === undefined
      ? "SLO report is missing."
      : `SLO produced ${metrics.sloAlertCount} alert(s).`,
    metrics.alertDeliveryStatus === undefined
      ? "Alert delivery report is missing."
      : `Alert delivery status is ${metrics.alertDeliveryStatus}.`
  ].join(" ");
}

function incidentSeverityForAlert(severity: SloAlertEvent["severity"]): RagIncidentSeverity {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "warning":
      return "warning";
    case "info":
      return "none";
  }
}

function finding(
  severity: RagIncidentSeverity,
  source: string,
  message: string
): RagIncidentFinding {
  return {
    severity,
    source,
    message
  };
}

function dedupeFindings(findings: readonly RagIncidentFinding[]): readonly RagIncidentFinding[] {
  const seen = new Set<string>();
  const output: RagIncidentFinding[] = [];
  for (const findingEntry of findings) {
    const key = `${findingEntry.severity}:${findingEntry.source}:${findingEntry.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(findingEntry);
    }
  }
  return output;
}

function dedupeTraceEvidence(
  evidence: readonly RagIncidentTraceEvidence[]
): readonly RagIncidentTraceEvidence[] {
  const seen = new Set<string>();
  const output: RagIncidentTraceEvidence[] = [];
  for (const entry of evidence) {
    const traceId =
      entry.currentTrace?.traceId ?? entry.baselineTrace?.traceId ?? entry.trace?.traceId ?? "none";
    const key = `${entry.profileId}:${entry.caseId}:${traceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(entry);
    }
  }
  return output;
}

function currentImpact(bundle: RagIncidentBundle): string {
  if (bundle.status === "healthy") {
    return "No active incident was detected by the bundled gates.";
  }

  const impactedProfiles = bundle.impactedProfiles
    .map((profile) => `${profile.profileId}/${profile.namespaceId}`)
    .join(", ");
  return impactedProfiles
    ? `Potentially impacted profiles: ${md(impactedProfiles)}.`
    : "Impact is inferred from operational gates; no profile-specific eval impact was isolated.";
}

function detection(bundle: RagIncidentBundle): string {
  const sources = bundle.findings.map((findingEntry) => findingEntry.source);
  return sources.length === 0
    ? "Detected by routine release evidence generation with no failing findings."
    : `Detected by ${md([...new Set(sources)].sort().join(", "))}.`;
}

function artifactTable(bundle: RagIncidentBundle): string {
  const rows = bundle.sourceArtifacts.map(
    (artifact) => `| ${md(artifact.label)} | ${md(artifact.status)} | ${md(artifact.path ?? "-")} |`
  );
  return ["| Artifact | Status | Path |", "| --- | --- | --- |", ...rows].join("\n");
}

function findingList(bundle: RagIncidentBundle): string {
  if (bundle.findings.length === 0) {
    return "- No findings.";
  }
  return bundle.findings
    .map(
      (findingEntry) =>
        `- **${md(findingEntry.severity)}** \`${md(findingEntry.source)}\`: ${md(findingEntry.message)}`
    )
    .join("\n");
}

function runbookList(bundle: RagIncidentBundle): string {
  if (bundle.runbooks.length === 0) {
    return "- No alert runbooks were attached.";
  }

  return bundle.runbooks
    .map((runbook) =>
      [
        `- **${md(runbook.ruleId)}** (${md(runbook.severity)}, ${md(runbook.category)}): ${md(runbook.runbook.title)}`,
        `  - Summary: ${md(runbook.runbook.summary)}`,
        `  - Actions: ${md(runbook.runbook.immediateActions.join("; "))}`,
        `  - Escalation: ${md(runbook.runbook.escalation)}`
      ].join("\n")
    )
    .join("\n");
}

function traceList(bundle: RagIncidentBundle): string {
  if (bundle.traceEvidence.length === 0) {
    return "- No safe trace evidence was available.";
  }

  return bundle.traceEvidence
    .map((entry) => {
      const traceId =
        entry.currentTrace?.traceId ?? entry.baselineTrace?.traceId ?? entry.trace?.traceId ?? "-";
      const status = entry.status ?? entry.currentTrace?.status ?? entry.trace?.status ?? "-";
      return `- \`${md(entry.profileId)}\` case \`${md(entry.caseId)}\`: status ${md(status)}, trace \`${md(traceId)}\``;
    })
    .join("\n");
}

function actionList(actions: readonly string[]): string {
  if (actions.length === 0) {
    return "- None.";
  }
  return actions.map((action) => `- ${md(action)}`).join("\n");
}

function md(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}
