export const SLO_SCHEMA_VERSION = 1;

export type SloStatus = "passed" | "failed";
export type SloEvaluationStatus = "passed" | "failed" | "missing";
export type SloSeverity = "info" | "warning" | "high" | "critical";
export type SloComparator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
export type SloSignalValue = number | string | boolean;
export type SloAlertCategory =
  | "eval_quality"
  | "trace_replay"
  | "provider_health"
  | "http_edge"
  | "rag_quality"
  | "readiness"
  | "custom";

export interface SloSignal {
  readonly name: string;
  readonly value: SloSignalValue;
  readonly unit?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface SloRunbook {
  readonly title: string;
  readonly summary: string;
  readonly immediateActions: readonly string[];
  readonly escalation: string;
}

export interface SloRule {
  readonly id: string;
  readonly name: string;
  readonly category: SloAlertCategory;
  readonly severity: SloSeverity;
  readonly signalName: string;
  readonly comparator: SloComparator;
  readonly threshold: SloSignalValue;
  readonly description: string;
  readonly runbook: SloRunbook;
  readonly required?: boolean;
}

export interface SloEvaluation {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly category: SloAlertCategory;
  readonly severity: SloSeverity;
  readonly status: SloEvaluationStatus;
  readonly signalName: string;
  readonly observedValue?: SloSignalValue;
  readonly comparator: SloComparator;
  readonly threshold: SloSignalValue;
  readonly message: string;
}

export interface SloAlertEvent {
  readonly event: "rag_slo_alert";
  readonly alertId: string;
  readonly generatedAt: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly category: SloAlertCategory;
  readonly severity: SloSeverity;
  readonly signalName: string;
  readonly observedValue?: SloSignalValue;
  readonly comparator: SloComparator;
  readonly threshold: SloSignalValue;
  readonly message: string;
  readonly runbook: SloRunbook;
}

export interface SloEvaluationReport {
  readonly schemaVersion: typeof SLO_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: SloStatus;
  readonly evaluatedRuleCount: number;
  readonly passedRuleCount: number;
  readonly failedRuleCount: number;
  readonly missingSignalCount: number;
  readonly alertCount: number;
  readonly criticalAlertCount: number;
  readonly highAlertCount: number;
  readonly warningAlertCount: number;
  readonly signals: readonly SloSignal[];
  readonly evaluations: readonly SloEvaluation[];
  readonly alerts: readonly SloAlertEvent[];
}

export interface EvaluateSloRulesRequest {
  readonly signals: readonly SloSignal[];
  readonly rules: readonly SloRule[];
  readonly generatedAt?: string;
}

export function evaluateSloRules(request: EvaluateSloRulesRequest): SloEvaluationReport {
  const generatedAt = request.generatedAt ?? new Date().toISOString();
  const signalsByName = new Map(request.signals.map((signal) => [signal.name, signal]));
  const evaluations = request.rules.map((rule) =>
    evaluateRule(rule, signalsByName.get(rule.signalName))
  );
  const failed = evaluations.filter((evaluation) => evaluation.status === "failed");
  const missing = evaluations.filter((evaluation) => evaluation.status === "missing");
  const alerts = failed.map((evaluation) =>
    alertForEvaluation(evaluation, request.rules, generatedAt)
  );

  return {
    schemaVersion: SLO_SCHEMA_VERSION,
    generatedAt,
    status: alerts.some((alert) => alert.severity === "high" || alert.severity === "critical")
      ? "failed"
      : "passed",
    evaluatedRuleCount: evaluations.length,
    passedRuleCount: evaluations.filter((evaluation) => evaluation.status === "passed").length,
    failedRuleCount: failed.length,
    missingSignalCount: missing.length,
    alertCount: alerts.length,
    criticalAlertCount: alerts.filter((alert) => alert.severity === "critical").length,
    highAlertCount: alerts.filter((alert) => alert.severity === "high").length,
    warningAlertCount: alerts.filter((alert) => alert.severity === "warning").length,
    signals: [...request.signals].sort((first, second) => first.name.localeCompare(second.name)),
    evaluations,
    alerts
  };
}

export function renderSloHtmlReport(report: SloEvaluationReport): string {
  const statusClass = report.status === "passed" ? "passed" : "failed";
  const alertRows = report.alerts.map(alertRow).join("\n");
  const evaluationRows = report.evaluations.map(evaluationRow).join("\n");
  const signalRows = report.signals.map(signalRow).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RAG SLO Report</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2937; background: #f8fafc; }
    main { max-width: 1180px; margin: 0 auto; }
    h1, h2 { color: #111827; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .metric { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    .passed, .info { color: #047857; }
    .failed, .critical, .high { color: #b91c1c; }
    .warning, .missing { color: #92400e; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0 28px; }
    th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 10px 12px; vertical-align: top; }
    th { background: #eef2f7; color: #374151; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    ul { margin: 6px 0 0; padding-left: 18px; }
  </style>
</head>
<body>
<main>
  <h1>RAG SLO Report</h1>
  <p class="${statusClass}"><strong>${escapeHtml(report.status)}</strong> · generated ${escapeHtml(report.generatedAt)}</p>
  <section class="summary">
    ${metric("Rules", report.evaluatedRuleCount)}
    ${metric("Alerts", report.alertCount)}
    ${metric("Critical", report.criticalAlertCount)}
    ${metric("High", report.highAlertCount)}
    ${metric("Warnings", report.warningAlertCount)}
    ${metric("Missing Signals", report.missingSignalCount)}
  </section>
  <h2>Alerts</h2>
  <table>
    <thead><tr><th>Severity</th><th>Rule</th><th>Observed</th><th>Runbook</th></tr></thead>
    <tbody>${alertRows || `<tr><td colspan="4">No alerts</td></tr>`}</tbody>
  </table>
  <h2>Evaluations</h2>
  <table>
    <thead><tr><th>Status</th><th>Rule</th><th>Signal</th><th>Message</th></tr></thead>
    <tbody>${evaluationRows}</tbody>
  </table>
  <h2>Signals</h2>
  <table>
    <thead><tr><th>Name</th><th>Value</th><th>Unit</th><th>Labels</th></tr></thead>
    <tbody>${signalRows}</tbody>
  </table>
</main>
</body>
</html>
`;
}

function evaluateRule(rule: SloRule, signal: SloSignal | undefined): SloEvaluation {
  if (!signal) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      category: rule.category,
      severity: rule.required === false ? "warning" : rule.severity,
      status: rule.required === false ? "missing" : "failed",
      signalName: rule.signalName,
      comparator: rule.comparator,
      threshold: rule.threshold,
      message: `SLO signal "${rule.signalName}" is missing.`
    };
  }

  const passed = compare(signal.value, rule.comparator, rule.threshold);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    category: rule.category,
    severity: rule.severity,
    status: passed ? "passed" : "failed",
    signalName: rule.signalName,
    observedValue: signal.value,
    comparator: rule.comparator,
    threshold: rule.threshold,
    message: passed
      ? `Observed ${signal.name}=${String(signal.value)} satisfied ${rule.comparator} ${String(rule.threshold)}.`
      : `Observed ${signal.name}=${String(signal.value)} violated ${rule.comparator} ${String(rule.threshold)}.`
  };
}

function compare(
  value: SloSignalValue,
  comparator: SloComparator,
  threshold: SloSignalValue
): boolean {
  switch (comparator) {
    case "eq":
      return value === threshold;
    case "neq":
      return value !== threshold;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (typeof value !== "number" || typeof threshold !== "number") {
        return false;
      }
      return numericCompare(value, comparator, threshold);
  }
}

function numericCompare(value: number, comparator: SloComparator, threshold: number): boolean {
  switch (comparator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "eq":
    case "neq":
      return compare(value, comparator, threshold);
  }
}

function alertForEvaluation(
  evaluation: SloEvaluation,
  rules: readonly SloRule[],
  generatedAt: string
): SloAlertEvent {
  const rule = rules.find((candidate) => candidate.id === evaluation.ruleId);
  if (!rule) {
    throw new Error(`Missing SLO rule for evaluation "${evaluation.ruleId}".`);
  }

  return {
    event: "rag_slo_alert",
    alertId: `slo_${safeId(evaluation.ruleId)}_${safeId(generatedAt)}`,
    generatedAt,
    ruleId: evaluation.ruleId,
    ruleName: evaluation.ruleName,
    category: evaluation.category,
    severity: evaluation.severity,
    signalName: evaluation.signalName,
    ...(evaluation.observedValue === undefined ? {} : { observedValue: evaluation.observedValue }),
    comparator: evaluation.comparator,
    threshold: evaluation.threshold,
    message: evaluation.message,
    runbook: rule.runbook
  };
}

function alertRow(alert: SloAlertEvent): string {
  const actions = alert.runbook.immediateActions
    .map((action) => `<li>${escapeHtml(action)}</li>`)
    .join("");

  return `<tr>
    <td class="${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</td>
    <td><code>${escapeHtml(alert.ruleId)}</code><br>${escapeHtml(alert.ruleName)}<br>${escapeHtml(alert.message)}</td>
    <td><code>${escapeHtml(alert.signalName)}</code><br>${escapeHtml(String(alert.observedValue ?? "missing"))} ${escapeHtml(alert.comparator)} ${escapeHtml(String(alert.threshold))}</td>
    <td><strong>${escapeHtml(alert.runbook.title)}</strong><br>${escapeHtml(alert.runbook.summary)}<ul>${actions}</ul><p>${escapeHtml(alert.runbook.escalation)}</p></td>
  </tr>`;
}

function evaluationRow(evaluation: SloEvaluation): string {
  return `<tr>
    <td class="${escapeHtml(evaluation.status)}">${escapeHtml(evaluation.status)}<br><span class="${escapeHtml(evaluation.severity)}">${escapeHtml(evaluation.severity)}</span></td>
    <td><code>${escapeHtml(evaluation.ruleId)}</code><br>${escapeHtml(evaluation.ruleName)}</td>
    <td><code>${escapeHtml(evaluation.signalName)}</code><br>${escapeHtml(String(evaluation.observedValue ?? "missing"))} ${escapeHtml(evaluation.comparator)} ${escapeHtml(String(evaluation.threshold))}</td>
    <td>${escapeHtml(evaluation.message)}</td>
  </tr>`;
}

function signalRow(signal: SloSignal): string {
  return `<tr>
    <td><code>${escapeHtml(signal.name)}</code></td>
    <td>${escapeHtml(String(signal.value))}</td>
    <td>${escapeHtml(signal.unit ?? "-")}</td>
    <td>${escapeHtml(signal.labels ? JSON.stringify(signal.labels) : "-")}</td>
  </tr>`;
}

function metric(label: string, value: number | string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function safeId(value: string): string {
  return value.replace(/[^0-9a-z]+/giu, "_").replace(/^_+|_+$/gu, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
