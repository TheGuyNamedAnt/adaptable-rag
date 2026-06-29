import type { RagEvalBenchmarkSnapshot, RagEvalRetrievalQualityMetrics } from "./eval-report.js";

export interface EmbeddingMigrationReport {
  readonly status: "passed" | "failed";
  readonly baselineGeneratedAt: string;
  readonly candidateGeneratedAt: string;
  readonly thresholds: EmbeddingMigrationThresholds;
  readonly deltas: readonly EmbeddingMigrationDelta[];
  readonly failures: readonly string[];
}

export interface EmbeddingMigrationThresholds {
  readonly maxRecallAtKDrop: number;
  readonly maxCitationRecallDrop: number;
  readonly maxPassRateDrop: number;
}

export interface EmbeddingMigrationDelta {
  readonly metric: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly change: number;
}

const DEFAULT_THRESHOLDS: EmbeddingMigrationThresholds = {
  maxRecallAtKDrop: 0.02,
  maxCitationRecallDrop: 0.02,
  maxPassRateDrop: 0.02
};

export function buildEmbeddingMigrationReport(input: {
  readonly baseline: RagEvalBenchmarkSnapshot;
  readonly candidate: RagEvalBenchmarkSnapshot;
  readonly thresholds?: Partial<EmbeddingMigrationThresholds>;
}): EmbeddingMigrationReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const deltas = [
    metricDelta("passRate", input.baseline.passRate, input.candidate.passRate),
    metricDelta(
      "recallAtK",
      qualityMetric(input.baseline.retrievalQuality, "recallAtK"),
      qualityMetric(input.candidate.retrievalQuality, "recallAtK")
    ),
    metricDelta(
      "citationRecall",
      qualityMetric(input.baseline.retrievalQuality, "citationRecall"),
      qualityMetric(input.candidate.retrievalQuality, "citationRecall")
    ),
    metricDelta(
      "mrr",
      qualityMetric(input.baseline.retrievalQuality, "mrr"),
      qualityMetric(input.candidate.retrievalQuality, "mrr")
    ),
    metricDelta(
      "latencyMsP50",
      qualityMetric(input.baseline.retrievalQuality, "latencyMsP50"),
      qualityMetric(input.candidate.retrievalQuality, "latencyMsP50")
    ),
    metricDelta(
      "estimatedCostUsdTotal",
      qualityMetric(input.baseline.retrievalQuality, "estimatedCostUsdTotal"),
      qualityMetric(input.candidate.retrievalQuality, "estimatedCostUsdTotal")
    )
  ];
  const failures = migrationFailures(deltas, thresholds);

  return {
    status: failures.length === 0 ? "passed" : "failed",
    baselineGeneratedAt: input.baseline.generatedAt,
    candidateGeneratedAt: input.candidate.generatedAt,
    thresholds,
    deltas,
    failures
  };
}

function migrationFailures(
  deltas: readonly EmbeddingMigrationDelta[],
  thresholds: EmbeddingMigrationThresholds
): readonly string[] {
  const failures: string[] = [];
  const passRateDrop = -deltaFor(deltas, "passRate");
  const recallDrop = -deltaFor(deltas, "recallAtK");
  const citationRecallDrop = -deltaFor(deltas, "citationRecall");

  if (passRateDrop > thresholds.maxPassRateDrop) {
    failures.push(`Pass rate dropped by ${formatPercent(passRateDrop)}.`);
  }

  if (recallDrop > thresholds.maxRecallAtKDrop) {
    failures.push(`Recall@K dropped by ${formatPercent(recallDrop)}.`);
  }

  if (citationRecallDrop > thresholds.maxCitationRecallDrop) {
    failures.push(`Citation recall dropped by ${formatPercent(citationRecallDrop)}.`);
  }

  return failures;
}

function metricDelta(metric: string, baseline: number, candidate: number): EmbeddingMigrationDelta {
  return {
    metric,
    baseline,
    candidate,
    change: candidate - baseline
  };
}

function qualityMetric(
  metrics: RagEvalRetrievalQualityMetrics | undefined,
  metric: keyof RagEvalRetrievalQualityMetrics
): number {
  return metrics?.[metric] ?? 0;
}

function deltaFor(deltas: readonly EmbeddingMigrationDelta[], metric: string): number {
  return deltas.find((delta) => delta.metric === metric)?.change ?? 0;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}
