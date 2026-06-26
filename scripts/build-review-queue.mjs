#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  breakawaySupportProfile,
  buildHumanReviewQueue,
  genericDocsProfile,
  redactText,
  renderHumanReviewQueueMarkdown,
  ultimateDefaultProfile
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const evalSummary = await readRequiredJson(options.evalSummaryPath, "Eval summary");
  const incidentBundle = await readOptionalJson(
    options.incidentBundlePath,
    options.incidentBundleExplicit,
    "Incident bundle"
  );
  const queue = buildHumanReviewQueue({
    ...(options.queueId === undefined ? {} : { queueId: options.queueId }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    profiles: [genericDocsProfile, breakawaySupportProfile, ultimateDefaultProfile],
    evalSummary,
    evalSummaryPath: options.evalSummaryPath,
    ...(incidentBundle === undefined
      ? {}
      : {
          incidentBundle,
          incidentBundlePath: options.incidentBundlePath
        }),
    includeRefusals: options.includeRefusals,
    defaultSlaHours: options.defaultSlaHours
  });

  if (options.reportDir) {
    await writeReviewQueueArtifacts(options.reportDir, queue);
  }

  console.log(
    `Human review queue built: ${queue.metrics.itemCount} item(s), ${queue.metrics.criticalItemCount} critical, ${queue.metrics.highItemCount} high.`
  );
  if (options.reportDir) {
    console.log(`Human review queue artifacts written to ${options.reportDir}.`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Review queue build failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function writeReviewQueueArtifacts(reportDir, queue) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "queue.json"), queue);
  await writeFile(path.join(reportDir, "queue.md"), renderHumanReviewQueueMarkdown(queue), "utf8");
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
      throw new Error(`${label} not found at ${filePath}. Run npm run evals first.`);
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
    evalSummaryPath: path.join(".rag", "eval-runs", "latest", "summary.json"),
    incidentBundlePath: path.join(".rag", "incidents", "latest", "incident.json"),
    incidentBundleExplicit: false,
    reportDir: path.join(".rag", "human-review", "latest"),
    includeRefusals: false,
    defaultSlaHours: 24
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--eval-summary":
        options.evalSummaryPath = requiredValue(args, ++index, arg);
        break;
      case "--incident":
        options.incidentBundlePath = requiredValue(args, ++index, arg);
        options.incidentBundleExplicit = true;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--queue-id":
        options.queueId = requiredValue(args, ++index, arg);
        break;
      case "--include-refusals":
        options.includeRefusals = true;
        break;
      case "--default-sla-hours":
        options.defaultSlaHours = positiveNumber(requiredValue(args, ++index, arg), arg);
        break;
      default:
        throw new Error(`Unknown review queue argument "${arg}".`);
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

function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
