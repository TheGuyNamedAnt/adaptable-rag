#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reconcileReviewTickets,
  redactText,
  renderReviewTicketReconciliationMarkdown
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  const tickets = await readRequiredJson(options.ticketsPath, "Review ticket payloads");
  const syncReport = await readRequiredJson(options.syncPath, "Review ticket sync report");
  const previousStore = await readOptionalJson(
    options.previousStorePath,
    options.previousStoreExplicit,
    "Review ticket idempotency store"
  );
  const externalStatuses = await readOptionalRecords(
    options.externalStatusesPath,
    options.externalStatusesExplicit,
    "External ticket statuses"
  );
  const result = reconcileReviewTickets({
    ...(options.reconciliationId === undefined
      ? {}
      : { reconciliationId: options.reconciliationId }),
    ...(options.storeId === undefined ? {} : { storeId: options.storeId }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    tickets,
    syncReport,
    ...(previousStore === undefined ? {} : { previousStore }),
    externalStatuses,
    staleAfterHours: options.staleAfterHours
  });

  if (options.reportDir) {
    await writeReconciliationArtifacts(options.reportDir, result);
  }

  const summary = `${result.report.metrics.ticketCount} ticket(s), ${result.report.metrics.syncedCount} synced, ${result.report.metrics.skippedCount} skipped, ${result.report.metrics.failedCount} failed, ${result.report.metrics.staleCount} stale.`;
  if (result.report.status === "passed") {
    console.log(`Review ticket reconciliation passed: ${summary}`);
    if (options.reportDir) {
      console.log(`Review ticket reconciliation artifacts written to ${options.reportDir}.`);
    }
  } else {
    console.error(`Review ticket reconciliation ${result.report.status}: ${summary}`);
    for (const error of result.report.errors) {
      console.error(`- ${error}`);
    }
    for (const warning of result.report.warnings) {
      console.error(`- ${warning}`);
    }
    if (options.reportDir) {
      console.error(`Review ticket reconciliation artifacts written to ${options.reportDir}.`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(
          error instanceof Error ? error.message : "Review ticket reconciliation failed."
        )
      }
    })
  );
  process.exitCode = 1;
}

async function writeReconciliationArtifacts(reportDir, result) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "idempotency-store.json"), result.store);
  await writeJson(path.join(reportDir, "reconciliation.json"), result.report);
  await writeFile(
    path.join(reportDir, "reconciliation.md"),
    renderReviewTicketReconciliationMarkdown(result.report),
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
      throw new Error(`${label} not found at ${filePath}. Run npm run review:sync first.`);
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

async function readOptionalRecords(filePath, explicit, label) {
  if (filePath === undefined) {
    return [];
  }

  try {
    return parseRecords(await readFile(filePath, "utf8"), filePath);
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

function parseRecords(body, filePath) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`Records at ${filePath} must be an array or JSONL records.`);
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
  const reportDir = path.join(".rag", "review-reconciliation", "latest");
  const options = {
    ticketsPath: path.join(".rag", "review-sync", "latest", "tickets.json"),
    syncPath: path.join(".rag", "review-sync", "latest", "sync.json"),
    previousStorePath: path.join(reportDir, "idempotency-store.json"),
    previousStoreExplicit: false,
    externalStatusesPath: path.join(".rag", "review-sync", "external-statuses.jsonl"),
    externalStatusesExplicit: false,
    reportDir,
    staleAfterHours: 168
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--tickets":
        options.ticketsPath = requiredValue(args, ++index, arg);
        break;
      case "--sync":
        options.syncPath = requiredValue(args, ++index, arg);
        break;
      case "--previous-store":
        options.previousStorePath = requiredValue(args, ++index, arg);
        options.previousStoreExplicit = true;
        break;
      case "--external-statuses":
        options.externalStatusesPath = requiredValue(args, ++index, arg);
        options.externalStatusesExplicit = true;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--stale-after-hours":
        options.staleAfterHours = positiveNumber(requiredValue(args, ++index, arg), arg);
        break;
      case "--generated-at":
        options.generatedAt = requiredValue(args, ++index, arg);
        break;
      case "--reconciliation-id":
        options.reconciliationId = requiredValue(args, ++index, arg);
        break;
      case "--store-id":
        options.storeId = requiredValue(args, ++index, arg);
        break;
      default:
        throw new Error(`Unknown review ticket reconciliation argument "${arg}".`);
    }
  }

  return options;
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
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
