#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildRagOperationalSloReport, redactText, renderSloHtmlReport } from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const evalBenchmark = await readRequiredJson(options.evalBenchmarkPath, "Eval benchmark");
  const traceReplay = await readRequiredJson(options.traceReplayPath, "Trace replay report");
  const providerSmoke = await readOptionalJson(
    options.providerSmokePath,
    options.providerSmokeExplicit,
    "Provider smoke report"
  );
  const httpMetrics = await readOptionalJson(
    options.httpMetricsPath,
    options.httpMetricsExplicit,
    "HTTP metrics snapshot"
  );
  const report = buildRagOperationalSloReport({
    evalBenchmark,
    traceReplay,
    ...(providerSmoke === undefined ? {} : { providerSmoke }),
    ...(httpMetrics === undefined ? {} : { httpMetrics }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt })
  });

  if (options.reportDir) {
    await writeSloArtifacts(options.reportDir, report);
  }

  const summary = `${report.alertCount} alert(s), ${report.criticalAlertCount} critical, ${report.highAlertCount} high, ${report.warningAlertCount} warning.`;
  if (report.status === "passed") {
    console.log(`SLO check passed: ${summary}`);
    if (options.reportDir) {
      console.log(`SLO report written to ${options.reportDir}.`);
    }
  } else {
    console.error(`SLO check failed: ${summary}`);
    for (const alert of report.alerts) {
      console.error(`- [${alert.severity}] ${alert.ruleId}: ${alert.message}`);
    }
    if (options.reportDir) {
      console.error(`SLO report written to ${options.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "SLO check failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeSloArtifacts(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "slo.json"), report);
  await writeJson(path.join(reportDir, "alerts.json"), report.alerts);
  await writeFile(path.join(reportDir, "report.html"), renderSloHtmlReport(report), "utf8");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function readRequiredJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `${label} not found at ${filePath}. Run npm run evals and npm run replay:eval first.`
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

async function readOptionalJson(filePath, explicit, label) {
  if (filePath === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error) && !explicit) {
      return undefined;
    }
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

function parseArgs(args) {
  const options = {
    evalBenchmarkPath: path.join(".rag", "eval-runs", "latest", "benchmark.json"),
    traceReplayPath: path.join(".rag", "trace-replay", "latest", "replay.json"),
    providerSmokePath: path.join(".rag", "provider-smoke", "latest", "smoke.json"),
    providerSmokeExplicit: false,
    httpMetricsExplicit: false,
    reportDir: path.join(".rag", "slo", "latest")
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--eval-benchmark":
        options.evalBenchmarkPath = requiredValue(args, ++index, arg);
        break;
      case "--trace-replay":
        options.traceReplayPath = requiredValue(args, ++index, arg);
        break;
      case "--provider-smoke":
        options.providerSmokePath = requiredValue(args, ++index, arg);
        options.providerSmokeExplicit = true;
        break;
      case "--http-metrics":
        options.httpMetricsPath = requiredValue(args, ++index, arg);
        options.httpMetricsExplicit = true;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown SLO check argument "${arg}".`);
    }
  }

  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
