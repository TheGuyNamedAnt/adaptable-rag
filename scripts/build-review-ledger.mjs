#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildReviewDecisionLedger,
  redactText,
  renderReviewDecisionLedgerMarkdown
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const queue = await readRequiredJson(options.queuePath, "Human review queue");
  const decisions = await readOptionalDecisions(
    options.decisionsPath,
    options.decisionsExplicit,
    "Review decisions"
  );
  const ledger = buildReviewDecisionLedger({
    ...(options.ledgerId === undefined ? {} : { ledgerId: options.ledgerId }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    queue,
    decisions
  });

  if (options.reportDir) {
    await writeReviewLedgerArtifacts(options.reportDir, ledger);
  }

  console.log(
    `Review decision ledger built: ${ledger.metrics.decisionCount} decision(s), ${ledger.metrics.feedbackSignalCount} feedback signal(s), ${ledger.metrics.invalidDecisionCount} invalid.`
  );
  if (options.reportDir) {
    console.log(`Review decision ledger artifacts written to ${options.reportDir}.`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Review decision ledger build failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeReviewLedgerArtifacts(reportDir, ledger) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "ledger.json"), ledger);
  await writeJson(path.join(reportDir, "feedback.json"), ledger.feedback);
  await writeFile(
    path.join(reportDir, "ledger.md"),
    renderReviewDecisionLedgerMarkdown(ledger),
    "utf8"
  );
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
      throw new Error(`${label} not found at ${filePath}. Run npm run review:queue first.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON.`);
    }
    throw error;
  }
}

async function readOptionalDecisions(filePath, explicit, label) {
  try {
    return parseDecisions(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (isNotFound(error) && !explicit) {
      return [];
    }
    if (isNotFound(error)) {
      throw new Error(`${label} not found at ${filePath}.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} at ${filePath} is not valid JSON or JSONL.`);
    }
    throw error;
  }
}

function parseDecisions(body, filePath) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`Review decisions at ${filePath} must be an array or JSONL records.`);
    }
    return parsed;
  }

  return trimmed.split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SyntaxError(`Invalid JSONL record ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  });
}

function parseArgs(args) {
  const options = {
    queuePath: path.join(".rag", "human-review", "latest", "queue.json"),
    decisionsPath: path.join(".rag", "human-review", "decisions.jsonl"),
    decisionsExplicit: false,
    reportDir: path.join(".rag", "review-ledger", "latest")
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--queue":
        options.queuePath = requiredValue(args, ++index, arg);
        break;
      case "--decisions":
        options.decisionsPath = requiredValue(args, ++index, arg);
        options.decisionsExplicit = true;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--ledger-id":
        options.ledgerId = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown review ledger argument "${arg}".`);
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
