#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const baselinePath = requiredArg(args, "baseline");
const candidatePath = requiredArg(args, "candidate");
const outputPath = args.output ?? path.join(".rag", "embedding-migration", "report.json");

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
const report = buildReport({
  baseline,
  candidate,
  thresholds: {
    maxPassRateDrop: numberArg(args, "max-pass-rate-drop", 0.02),
    maxRecallAtKDrop: numberArg(args, "max-recall-drop", 0.02),
    maxCitationRecallDrop: numberArg(args, "max-citation-recall-drop", 0.02)
  }
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Embedding migration report ${report.status}: ${outputPath}`);
for (const failure of report.failures) {
  console.log(`- ${failure}`);
}

if (report.status === "failed") {
  process.exitCode = 1;
}

function buildReport(input) {
  const deltas = [
    delta("passRate", input.baseline.passRate, input.candidate.passRate),
    delta(
      "recallAtK",
      quality(input.baseline.retrievalQuality, "recallAtK"),
      quality(input.candidate.retrievalQuality, "recallAtK")
    ),
    delta(
      "citationRecall",
      quality(input.baseline.retrievalQuality, "citationRecall"),
      quality(input.candidate.retrievalQuality, "citationRecall")
    ),
    delta(
      "mrr",
      quality(input.baseline.retrievalQuality, "mrr"),
      quality(input.candidate.retrievalQuality, "mrr")
    ),
    delta(
      "latencyMsP50",
      quality(input.baseline.retrievalQuality, "latencyMsP50"),
      quality(input.candidate.retrievalQuality, "latencyMsP50")
    ),
    delta(
      "estimatedCostUsdTotal",
      quality(input.baseline.retrievalQuality, "estimatedCostUsdTotal"),
      quality(input.candidate.retrievalQuality, "estimatedCostUsdTotal")
    )
  ];
  const failures = failuresFor(deltas, input.thresholds);
  return {
    status: failures.length === 0 ? "passed" : "failed",
    baselineGeneratedAt: input.baseline.generatedAt,
    candidateGeneratedAt: input.candidate.generatedAt,
    thresholds: input.thresholds,
    deltas,
    failures
  };
}

function failuresFor(deltas, thresholds) {
  const failures = [];
  const passRateDrop = -changeFor(deltas, "passRate");
  const recallDrop = -changeFor(deltas, "recallAtK");
  const citationRecallDrop = -changeFor(deltas, "citationRecall");

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

function delta(metric, baseline, candidate) {
  return { metric, baseline, candidate, change: candidate - baseline };
}

function quality(metrics, metric) {
  return Number(metrics?.[metric] ?? 0);
}

function changeFor(deltas, metric) {
  return deltas.find((entry) => entry.metric === metric)?.change ?? 0;
}

function formatPercent(value) {
  return `${Math.round(value * 10000) / 100}%`;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    parsed[arg.slice(2)] = rawArgs[index + 1];
    index += 1;
  }
  return parsed;
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function numberArg(args, name, fallback) {
  const raw = args[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number.`);
  }
  return value;
}
