import {
  buildEvalBenchmarkSnapshot,
  breakawaySupportProfile,
  compareEvalBenchmarks,
  genericDocsProfile,
  renderEvalHtmlReport,
  runProfileEvalSuites,
  ultimateDefaultProfile
} from "../dist/index.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const summary = await runProfileEvalSuites({
  profiles: [genericDocsProfile, breakawaySupportProfile, ultimateDefaultProfile],
  projectRoot: process.cwd()
});
const options = parseArgs(process.argv.slice(2));
const benchmark = buildEvalBenchmarkSnapshot(
  summary,
  options.generatedAt ?? new Date().toISOString()
);
let regression;

if (options.baselinePath) {
  const baseline = JSON.parse(await readFile(options.baselinePath, "utf8"));
  regression = compareEvalBenchmarks(baseline, benchmark, options.regressionOptions);
}

if (options.updateBaselinePath) {
  await writeJson(options.updateBaselinePath, benchmark);
}

if (options.reportDir) {
  await writeReportArtifacts(options.reportDir, {
    summary,
    benchmark,
    ...(regression ? { regression } : {})
  });
}

if (!summary.passed) {
  console.error(`RAG evals failed: ${summary.failures.length} failure(s).`);
  for (const failure of summary.failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else if (regression && !regression.passed) {
  console.error(`RAG eval regressions failed: ${regression.failures.length} failure(s).`);
  for (const failure of regression.failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `RAG evals passed: ${summary.caseCount} cases across ${summary.suiteCount} profiles.`
  );
  if (regression) {
    console.log("RAG eval benchmark comparison passed.");
  }
  if (options.reportDir) {
    console.log(`RAG eval report written to ${options.reportDir}.`);
  }
}

async function writeReportArtifacts(reportDir, bundle) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "summary.json"), bundle.summary);
  await writeJson(path.join(reportDir, "benchmark.json"), bundle.benchmark);
  if (bundle.regression) {
    await writeJson(path.join(reportDir, "regression.json"), bundle.regression);
  }
  await writeFile(path.join(reportDir, "report.html"), renderEvalHtmlReport(bundle), "utf8");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function parseArgs(args) {
  const options = {
    regressionOptions: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--baseline":
        options.baselinePath = requiredValue(args, ++index, arg);
        break;
      case "--update-baseline":
        options.updateBaselinePath = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--max-pass-rate-drop":
        options.regressionOptions.maxPassRateDrop = numericValue(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--allow-case-count-decrease":
        options.regressionOptions.allowCaseCountDecrease = true;
        break;
      case "--allow-check-coverage-decrease":
        options.regressionOptions.allowCheckCoverageDecrease = true;
        break;
      case "--allow-visual-coverage-decrease":
        options.regressionOptions.allowVisualCoverageDecrease = true;
        break;
      case "--allow-citation-decrease":
        options.regressionOptions.allowCitationDecrease = true;
        break;
      default:
        throw new Error(`Unknown eval runner argument "${arg}".`);
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

function numericValue(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number.`);
  }
  return parsed;
}
