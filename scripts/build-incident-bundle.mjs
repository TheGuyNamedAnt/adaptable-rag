#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildRagIncidentBundle, redactText, renderRagIncidentMarkdown } from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const evalBenchmark = await readRequiredJson(options.evalBenchmarkPath, "Eval benchmark");
  const evalSummary = await readRequiredJson(options.evalSummaryPath, "Eval summary");
  const traceReplay = await readRequiredJson(options.traceReplayPath, "Trace replay report");
  const sloReport = await readRequiredJson(options.sloReportPath, "SLO report");
  const alertDelivery = await readRequiredJson(options.alertDeliveryPath, "Alert delivery report");
  const providerSmoke = await readOptionalJson(
    options.providerSmokePath,
    options.providerSmokeExplicit,
    "Provider smoke report"
  );
  const bundle = buildRagIncidentBundle({
    ...(options.incidentId === undefined ? {} : { incidentId: options.incidentId }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    artifactPaths: {
      evalBenchmark: options.evalBenchmarkPath,
      evalSummary: options.evalSummaryPath,
      traceReplay: options.traceReplayPath,
      sloReport: options.sloReportPath,
      alertDelivery: options.alertDeliveryPath,
      ...(providerSmoke === undefined ? {} : { providerSmoke: options.providerSmokePath })
    },
    evalBenchmark,
    evalSummary,
    traceReplay,
    sloReport,
    alertDelivery,
    ...(providerSmoke === undefined ? {} : { providerSmoke })
  });

  if (options.reportDir) {
    await writeIncidentArtifacts(options.reportDir, bundle);
  }

  console.log(
    `Incident bundle built: ${bundle.status}/${bundle.severity}, ${bundle.findings.length} finding(s), ${bundle.traceEvidence.length} trace evidence item(s).`
  );
  if (options.reportDir) {
    console.log(`Incident artifacts written to ${options.reportDir}.`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Incident bundle generation failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeIncidentArtifacts(reportDir, bundle) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "incident.json"), bundle);
  await writeFile(path.join(reportDir, "postmortem.md"), renderRagIncidentMarkdown(bundle), "utf8");
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
      throw new Error(`${label} not found at ${filePath}. Run the release evidence gates first.`);
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
    evalSummaryPath: path.join(".rag", "eval-runs", "latest", "summary.json"),
    traceReplayPath: path.join(".rag", "trace-replay", "latest", "replay.json"),
    sloReportPath: path.join(".rag", "slo", "latest", "slo.json"),
    alertDeliveryPath: path.join(".rag", "alert-delivery", "latest", "delivery.json"),
    providerSmokePath: path.join(".rag", "provider-smoke", "latest", "smoke.json"),
    providerSmokeExplicit: false,
    reportDir: path.join(".rag", "incidents", "latest")
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--eval-benchmark":
        options.evalBenchmarkPath = requiredValue(args, ++index, arg);
        break;
      case "--eval-summary":
        options.evalSummaryPath = requiredValue(args, ++index, arg);
        break;
      case "--trace-replay":
        options.traceReplayPath = requiredValue(args, ++index, arg);
        break;
      case "--slo":
        options.sloReportPath = requiredValue(args, ++index, arg);
        break;
      case "--alert-delivery":
        options.alertDeliveryPath = requiredValue(args, ++index, arg);
        break;
      case "--provider-smoke":
        options.providerSmokePath = requiredValue(args, ++index, arg);
        options.providerSmokeExplicit = true;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--incident-id":
        options.incidentId = requiredValue(args, ++index, arg);
        break;
      case "--title":
        options.title = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown incident bundle argument "${arg}".`);
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
