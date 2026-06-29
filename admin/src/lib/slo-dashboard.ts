import "server-only";

import {
  getOverview,
  type HttpMetrics,
  type OverviewResult,
  type ProductionHealth,
  type ProviderSummary
} from "@/lib/rag-admin-api";

export type SloGateStatus = "passed" | "warning" | "failed" | "no_data";

export interface SloDashboardResult {
  readonly generatedAt: string;
  readonly status: SloGateStatus;
  readonly overview: OverviewResult;
  readonly summary: {
    readonly gateCount: number;
    readonly passedCount: number;
    readonly warningCount: number;
    readonly failedCount: number;
    readonly noDataCount: number;
  };
  readonly metrics: SloMetricSummary;
  readonly gates: readonly SloGate[];
  readonly recommendations: readonly string[];
  readonly counters: {
    readonly statusCodes: readonly SloCounterRow[];
    readonly routes: readonly SloCounterRow[];
    readonly outcomes: readonly SloCounterRow[];
  };
}

export interface SloMetricSummary {
  readonly totalRequests: number | undefined;
  readonly completedRequests: number | undefined;
  readonly activeRequests: number | undefined;
  readonly completionRate: number | undefined;
  readonly answerRequests: number;
  readonly answerFailureRate: number | undefined;
  readonly authDeniedRate: number | undefined;
  readonly rateLimitedRate: number | undefined;
  readonly serverErrorRate: number | undefined;
  readonly requestErrorRate: number | undefined;
}

export interface SloGate {
  readonly id: string;
  readonly area: string;
  readonly label: string;
  readonly status: SloGateStatus;
  readonly target: string;
  readonly actual: string;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly actionHref?: string;
}

export interface SloCounterRow {
  readonly label: string;
  readonly count: number;
  readonly percentage: number | undefined;
}

const METADATA_POSTGRES_ERROR = "postgres index storage";

export async function getSloDashboard(): Promise<SloDashboardResult> {
  return buildSloDashboard(await getOverview());
}

export function buildSloDashboard(overview: OverviewResult): SloDashboardResult {
  const metrics = overview.metrics;
  const summaryMetrics = metricSummary(metrics);
  const gates: SloGate[] = [
    runtimeReadyGate(overview),
    metricsEndpointGate(overview),
    requestCompletionGate(summaryMetrics),
    serverErrorGate(summaryMetrics, metrics),
    requestErrorGate(summaryMetrics, metrics),
    authDeniedGate(summaryMetrics, metrics),
    rateLimitedGate(summaryMetrics, metrics),
    answerFailureGate(summaryMetrics, metrics),
    answerCoverageGate(summaryMetrics, metrics),
    storageReadinessGate(overview.health),
    providerReadinessGate(overview.health),
    corpusLoadedGate(overview.health),
    inspectionMetadataGate(overview)
  ];
  const summary = {
    gateCount: gates.length,
    passedCount: gates.filter((gate) => gate.status === "passed").length,
    warningCount: gates.filter((gate) => gate.status === "warning").length,
    failedCount: gates.filter((gate) => gate.status === "failed").length,
    noDataCount: gates.filter((gate) => gate.status === "no_data").length
  };

  return {
    generatedAt: new Date().toISOString(),
    status: aggregateGateStatus(gates.map((gate) => gate.status)),
    overview,
    summary,
    metrics: summaryMetrics,
    gates,
    recommendations: gates
      .filter((gate) => gate.status === "failed" || gate.status === "warning")
      .map((gate) => `${gate.label}: ${gate.detail}`),
    counters: {
      statusCodes: counterRows(metrics?.byStatusCode, metrics?.completedRequests),
      routes: counterRows(metrics?.byRoute, metrics?.completedRequests),
      outcomes: counterRows(metrics?.byOutcome, metrics?.completedRequests)
    }
  };
}

function runtimeReadyGate(overview: OverviewResult): SloGate {
  const ready = overview.ready?.ready === true;
  const status = ready ? "passed" : "failed";
  return {
    id: "runtime_ready",
    area: "Availability",
    label: "RAG service readiness",
    status,
    target: "/ready returns ready=true",
    actual: overview.ready?.status ?? overview.status,
    detail: ready
      ? "RAG service readiness is passing."
      : "RAG service is unavailable, not ready, or draining.",
    evidence: [
      `Overview status: ${overview.status}`,
      `Ready flag: ${overview.ready?.ready === undefined ? "unknown" : String(overview.ready.ready)}`
    ],
    actionHref: "/"
  };
}

function metricsEndpointGate(overview: OverviewResult): SloGate {
  const status: SloGateStatus = overview.metrics ? "passed" : "failed";
  return {
    id: "metrics_endpoint",
    area: "Observability",
    label: "Metrics endpoint",
    status,
    target: "/metrics reachable",
    actual: overview.metrics ? "available" : "unavailable",
    detail: overview.metrics
      ? "Service metrics are available for gate checks."
      : "Service metrics are missing, so operational SLOs cannot be evaluated.",
    evidence: overview.errors.length ? overview.errors : ["No overview errors."],
    actionHref: "/"
  };
}

function requestCompletionGate(summary: SloMetricSummary): SloGate {
  if (summary.totalRequests === undefined || summary.totalRequests === 0) {
    return noDataGate({
      id: "request_completion",
      area: "Traffic",
      label: "Request completion",
      target: ">= 99% completed",
      detail: "No HTTP request volume has been observed yet."
    });
  }
  const rate = summary.completionRate ?? 0;
  return {
    id: "request_completion",
    area: "Traffic",
    label: "Request completion",
    status: rate >= 0.99 ? "passed" : rate >= 0.95 ? "warning" : "failed",
    target: ">= 99% completed",
    actual: formatPercent(rate),
    detail:
      rate >= 0.99
        ? "Completed request ratio is inside the gate."
        : "Active or unfinished requests are too high for a steady production window.",
    evidence: [
      `Total requests: ${formatNumber(summary.totalRequests)}`,
      `Completed requests: ${formatNumber(summary.completedRequests)}`
    ]
  };
}

function serverErrorGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  return countGate({
    id: "server_errors",
    area: "Reliability",
    label: "Server errors",
    target: "0 5xx errors",
    count: metrics?.serverErrors,
    rate: summary.serverErrorRate,
    warnAt: 1,
    failAt: 1,
    detailForClean: "No server errors have been observed.",
    detailForDirty: "5xx errors mean RAG service failures are reaching callers."
  });
}

function requestErrorGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  return countGate({
    id: "request_errors",
    area: "Reliability",
    label: "Request errors",
    target: "<= 2% 4xx errors",
    count: metrics?.requestErrors,
    rate: summary.requestErrorRate,
    failWhen: (count, rate) => count > 0 && rate !== undefined && rate > 0.02,
    warnWhen: (count) => count > 0,
    detailForClean: "No client-side request errors have been observed.",
    detailForDirty:
      "4xx errors should be explained by auth/rate-limit behavior or fixed at the caller."
  });
}

function authDeniedGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  return countGate({
    id: "auth_denied",
    area: "Security",
    label: "Auth denied",
    target: "0 unexpected auth denials",
    count: metrics?.authDenied,
    rate: summary.authDeniedRate,
    failWhen: (count, rate) => count > 0 && rate !== undefined && rate > 0.05,
    warnWhen: (count) => count > 0,
    detailForClean: "No unauthorized answer requests have been observed.",
    detailForDirty:
      "Auth denials are expected during tests, but should be reviewed in company traffic."
  });
}

function rateLimitedGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  return countGate({
    id: "rate_limited",
    area: "Traffic",
    label: "Rate limited",
    target: "0 sustained rate limits",
    count: metrics?.rateLimited,
    rate: summary.rateLimitedRate,
    failWhen: (count, rate) => count > 0 && rate !== undefined && rate > 0.05,
    warnWhen: (count) => count > 0,
    detailForClean: "No rate-limit events have been observed.",
    detailForDirty: "Rate limits mean callers are exceeding the configured edge budget."
  });
}

function answerFailureGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  return countGate({
    id: "answer_failures",
    area: "Answering",
    label: "Answer failures",
    target: "0 answer failures",
    count: metrics?.answerFailed,
    rate: summary.answerFailureRate,
    warnAt: 1,
    failAt: 1,
    detailForClean: "No answer failures have been observed.",
    detailForDirty: "Answer failures mean the guarded answer path could not complete."
  });
}

function answerCoverageGate(summary: SloMetricSummary, metrics: HttpMetrics | undefined): SloGate {
  if (!metrics) {
    return noDataGate({
      id: "answer_coverage",
      area: "Answering",
      label: "Answer traffic",
      target: "Observed answer traffic",
      detail: "Service metrics are unavailable."
    });
  }
  if (summary.answerRequests === 0) {
    return {
      id: "answer_coverage",
      area: "Answering",
      label: "Answer traffic",
      status: "warning",
      target: "Observed answer traffic",
      actual: "0 answer events",
      detail:
        "No successful, refused, or failed answer events have been observed in this RAG service.",
      evidence: ["Run Answer Lab or production smoke to exercise the answer path."],
      actionHref: "/answer-lab"
    };
  }
  return {
    id: "answer_coverage",
    area: "Answering",
    label: "Answer traffic",
    status: "passed",
    target: "Observed answer traffic",
    actual: formatNumber(summary.answerRequests),
    detail: "The answer path has emitted service outcome counters.",
    evidence: [
      `Succeeded: ${formatNumber(metrics.answerSucceeded)}`,
      `Refused: ${formatNumber(metrics.answerRefused)}`,
      `Failed: ${formatNumber(metrics.answerFailed)}`
    ],
    actionHref: "/answer-lab"
  };
}

function storageReadinessGate(health: ProductionHealth | undefined): SloGate {
  if (!health) {
    return noDataGate({
      id: "storage_readiness",
      area: "Storage",
      label: "Production storage",
      target: "Postgres index, pgvector, and ledger",
      detail: "RAG service health is unavailable."
    });
  }
  const surfaces = [
    ["Index", health.index?.storageKind, health.index?.durable],
    ["Vector", health.vector?.storageKind, health.vector?.durable],
    ["Source ledger", health.sourceSyncLedger?.storageKind, health.sourceSyncLedger?.durable]
  ] as const;
  const ready = surfaces.every(([, kind, durable]) => kind === "postgres" && durable === true);
  return {
    id: "storage_readiness",
    area: "Storage",
    label: "Production storage",
    status: ready ? "passed" : "failed",
    target: "Postgres index, pgvector, and ledger",
    actual: surfaces.map(([label, kind]) => `${label}: ${kind ?? "missing"}`).join(", "),
    detail: ready
      ? "Core storage surfaces are on the serious company deployment target."
      : "Company traffic needs Postgres-backed index storage, pgvector text vectors, and a Postgres source-sync ledger.",
    evidence: surfaces.map(
      ([label, kind, durable]) =>
        `${label}: ${kind ?? "missing"}${durable === undefined ? "" : durable ? ", durable" : ", not durable"}`
    ),
    actionHref: "/storage"
  };
}

function providerReadinessGate(health: ProductionHealth | undefined): SloGate {
  const provider = health?.providers?.model;
  const ready = liveProviderReady(provider);
  return {
    id: "provider_readiness",
    area: "Providers",
    label: "Answer model provider",
    status: ready ? "passed" : "warning",
    target: "Live non-placeholder answer model",
    actual: providerLabel(provider),
    detail: ready
      ? "The answer model provider does not look like a local placeholder."
      : "The current answer model provider appears to be a dev placeholder.",
    evidence: [
      `Provider: ${provider?.provider ?? "missing"}`,
      `Model: ${provider?.modelName ?? "missing"}`
    ],
    actionHref: "/storage"
  };
}

function corpusLoadedGate(health: ProductionHealth | undefined): SloGate {
  const documents = health?.index?.documentCount;
  const chunks = health?.index?.chunkCount;
  const loaded =
    typeof documents === "number" && documents > 0 && typeof chunks === "number" && chunks > 0;
  return {
    id: "corpus_loaded",
    area: "Corpus",
    label: "Corpus loaded",
    status: loaded ? "passed" : "warning",
    target: "> 0 documents and chunks",
    actual: `${formatNumber(documents)} documents, ${formatNumber(chunks)} chunks`,
    detail: loaded
      ? "The RAG service has indexed corpus content."
      : "No indexed corpus content is visible to the RAG service yet.",
    evidence: [`Documents: ${formatNumber(documents)}`, `Chunks: ${formatNumber(chunks)}`],
    actionHref: "/ingestion"
  };
}

function inspectionMetadataGate(overview: OverviewResult): SloGate {
  const metadataErrors = overview.errors.filter((error) =>
    error.toLowerCase().includes(METADATA_POSTGRES_ERROR)
  );
  const otherErrors = overview.errors.filter(
    (error) => !error.toLowerCase().includes(METADATA_POSTGRES_ERROR)
  );
  if (otherErrors.length > 0) {
    return {
      id: "inspection_metadata",
      area: "Observability",
      label: "Inspection metadata",
      status: "failed",
      target: "Inspection APIs available",
      actual: `${otherErrors.length} blocking errors`,
      detail: "One or more admin inspection surfaces are unavailable.",
      evidence: otherErrors,
      actionHref: "/admin-ops"
    };
  }
  return {
    id: "inspection_metadata",
    area: "Observability",
    label: "Inspection metadata",
    status: metadataErrors.length > 0 ? "warning" : "passed",
    target: "Postgres-backed inspection history",
    actual: metadataErrors.length > 0 ? "local/dev metadata gap" : "available",
    detail:
      metadataErrors.length > 0
        ? "Durable ingestion inspection needs Postgres-backed production metadata."
        : "Admin inspection metadata is available.",
    evidence: metadataErrors.length > 0 ? metadataErrors : ["No inspection metadata errors."],
    actionHref: "/admin-ops"
  };
}

function countGate(input: {
  readonly id: string;
  readonly area: string;
  readonly label: string;
  readonly target: string;
  readonly count: number | undefined;
  readonly rate: number | undefined;
  readonly warnAt?: number;
  readonly failAt?: number;
  readonly warnWhen?: (count: number, rate: number | undefined) => boolean;
  readonly failWhen?: (count: number, rate: number | undefined) => boolean;
  readonly detailForClean: string;
  readonly detailForDirty: string;
}): SloGate {
  if (input.count === undefined) {
    return noDataGate({
      id: input.id,
      area: input.area,
      label: input.label,
      target: input.target,
      detail: "Service metrics are unavailable."
    });
  }
  const fail =
    input.failWhen?.(input.count, input.rate) ??
    (input.failAt !== undefined && input.count >= input.failAt);
  const warn =
    input.warnWhen?.(input.count, input.rate) ??
    (input.warnAt !== undefined && input.count >= input.warnAt);
  const status: SloGateStatus = fail ? "failed" : warn ? "warning" : "passed";
  return {
    id: input.id,
    area: input.area,
    label: input.label,
    status,
    target: input.target,
    actual: `${formatNumber(input.count)}${input.rate === undefined ? "" : ` (${formatPercent(input.rate)})`}`,
    detail: input.count === 0 ? input.detailForClean : input.detailForDirty,
    evidence: [`Count: ${formatNumber(input.count)}`, `Rate: ${formatPercent(input.rate)}`]
  };
}

function noDataGate(input: {
  readonly id: string;
  readonly area: string;
  readonly label: string;
  readonly target: string;
  readonly detail: string;
}): SloGate {
  return {
    ...input,
    status: "no_data",
    actual: "no data",
    evidence: [input.detail]
  };
}

function metricSummary(metrics: HttpMetrics | undefined): SloMetricSummary {
  const total = finiteMetric(metrics?.totalRequests);
  const completed = finiteMetric(metrics?.completedRequests);
  const answerRequests =
    finiteMetric(metrics?.answerSucceeded) +
    finiteMetric(metrics?.answerRefused) +
    finiteMetric(metrics?.answerFailed);
  return {
    totalRequests: metrics?.totalRequests,
    completedRequests: metrics?.completedRequests,
    activeRequests: metrics?.activeRequests,
    completionRate: safeRatio(completed, total),
    answerRequests,
    answerFailureRate: safeRatio(finiteMetric(metrics?.answerFailed), answerRequests),
    authDeniedRate: safeRatio(finiteMetric(metrics?.authDenied), total),
    rateLimitedRate: safeRatio(finiteMetric(metrics?.rateLimited), total),
    serverErrorRate: safeRatio(finiteMetric(metrics?.serverErrors), total),
    requestErrorRate: safeRatio(finiteMetric(metrics?.requestErrors), total)
  };
}

function counterRows(
  counters: Record<string, number> | undefined,
  denominator: number | undefined
): readonly SloCounterRow[] {
  return Object.entries(counters ?? {})
    .map(([label, count]) => ({
      label,
      count,
      percentage: safeRatio(count, finiteMetric(denominator))
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function aggregateGateStatus(statuses: readonly SloGateStatus[]): SloGateStatus {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  if (statuses.some((status) => status === "no_data")) return "warning";
  return "passed";
}

function liveProviderReady(provider: ProviderSummary | undefined): boolean {
  if (!provider) return false;
  const joined = [provider.id, provider.provider, provider.modelName].filter(Boolean).join(" ");
  return !/(placeholder|example\.invalid|json-chat)/iu.test(joined);
}

function providerLabel(provider: ProviderSummary | undefined): string {
  if (!provider) return "missing";
  return [provider.provider, provider.modelName].filter(Boolean).join(" / ") || "configured";
}

function safeRatio(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return undefined;
  }
  return numerator / denominator;
}

function finiteMetric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(value < 0.01 && value > 0 ? 2 : 1)}%`;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}
