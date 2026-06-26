#!/usr/bin/env node
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  breakawaySupportProfile,
  buildEvalTraceReplayReport,
  genericDocsProfile,
  renderEvalTraceReplayHtmlReport,
  runProfileEvalSuites,
  ultimateDefaultProfile
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  await assertReadable(options.evalSummaryPath);
  const baselineSummary = JSON.parse(await readFile(options.evalSummaryPath, "utf8"));
  const currentSummary = await runProfileEvalSuites({
    profiles: [genericDocsProfile, breakawaySupportProfile, ultimateDefaultProfile],
    projectRoot: process.cwd()
  });
  const report = buildEvalTraceReplayReport(baselineSummary, currentSummary, {
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.target === undefined ? {} : { target: options.target })
  });

  if (options.reportDir) {
    await writeReplayArtifacts(options.reportDir, report, currentSummary);
  }

  if (report.status === "passed") {
    console.log(
      `Trace replay passed: ${report.matchedCount}/${report.caseCount} cases matched, ${report.notComparableCount} not comparable.`
    );
    if (options.reportDir) {
      console.log(`Trace replay report written to ${options.reportDir}.`);
    }
  } else {
    console.error(
      `Trace replay failed: ${report.mismatchedCount} mismatched, ${report.notComparableCount} not comparable.`
    );
    for (const failure of report.failures) {
      console.error(`- ${failure}`);
    }
    if (options.reportDir) {
      console.error(`Trace replay report written to ${options.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Trace replay failed."
      }
    })
  );
  process.exitCode = 1;
}

async function writeReplayArtifacts(reportDir, report, currentSummary) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "replay.json"), report);
  await writeJson(path.join(reportDir, "current-summary.json"), currentSummary);
  await writeFile(
    path.join(reportDir, "report.html"),
    renderEvalTraceReplayHtmlReport(report),
    "utf8"
  );
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

async function assertReadable(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Eval summary not found at ${filePath}. Run "npm run evals" first.`);
  }
}

function parseArgs(args) {
  const options = {
    evalSummaryPath: path.join(".rag", "eval-runs", "latest", "summary.json"),
    reportDir: path.join(".rag", "trace-replay", "latest")
  };
  const target = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--eval-summary":
        options.evalSummaryPath = requiredValue(args, ++index, arg);
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--trace-id":
        target.traceId = requiredValue(args, ++index, arg);
        break;
      case "--profile-id":
        target.profileId = requiredValue(args, ++index, arg);
        break;
      case "--case-id":
        target.caseId = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown trace replay argument "${arg}".`);
    }
  }

  if (Object.keys(target).length > 0) {
    options.target = target;
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
