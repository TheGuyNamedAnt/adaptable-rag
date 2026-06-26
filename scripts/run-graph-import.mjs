#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  importGraphBatches,
  InMemoryGraphStore,
  JsonFileGraphBatchImportCheckpointStore,
  JsonFileGraphStore,
  redactText,
  renderGraphBatchImportMarkdown,
  SqliteGraphStore
} from "../dist/index.js";

const options = parseArgs(process.argv.slice(2));

try {
  if (options.batchesPath === undefined) {
    throw new Error("--batches is required.");
  }

  const importId = options.importId ?? (await defaultImportIdForBatches(options.batchesPath));
  const store = createStore(options);
  try {
    const checkpointStore =
      options.checkpointEnabled === false
        ? undefined
        : new JsonFileGraphBatchImportCheckpointStore({
            filePath:
              options.checkpointPath ?? path.join(options.reportDir, `${importId}.checkpoint.json`)
          });
    const result = await importGraphBatches({
      store,
      batches: readGraphBatches(options.batchesPath),
      importId,
      ...(options.requestedAt === undefined ? {} : { requestedAt: options.requestedAt }),
      ...(checkpointStore === undefined ? {} : { checkpointStore }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      continueOnError: options.continueOnError,
      thresholds: options.thresholds
    });

    if (options.reportDir) {
      await writeGraphImportArtifacts(options.reportDir, result);
    }

    const summary = `${result.metrics.completedBatchCount} completed, ${result.metrics.skippedBatchCount} skipped, ${result.metrics.sourceBatchCount} source batch(es), ${result.metrics.storedEntityCount} entities, ${result.metrics.storedRelationCount} relations, store=${options.storeKind}.`;
    if (result.status === "succeeded") {
      console.log(`Graph import succeeded: ${summary}`);
      if (options.reportDir) {
        console.log(`Graph import report written to ${options.reportDir}.`);
      }
    } else {
      console.error(`Graph import ${result.status}: ${summary}`);
      for (const failure of result.failures) {
        console.error(`- ${failure.batchId}: ${failure.message}`);
      }
      for (const violation of result.thresholdViolations) {
        console.error(`- ${violation.message}`);
      }
      if (options.reportDir) {
        console.error(`Graph import report written to ${options.reportDir}.`);
      }
      process.exitCode = 1;
    }
  } finally {
    store.close?.();
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: redactText(error instanceof Error ? error.message : "Graph import failed.")
      }
    })
  );
  process.exitCode = 1;
}

async function defaultImportIdForBatches(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return `graph_import_${safeIdSegment(path.basename(filePath))}_${hash.digest("hex").slice(0, 16)}`;
}

function safeIdSegment(value) {
  const normalized = value
    .replace(/\.[^.]+$/u, "")
    .replace(/[^0-9a-z]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "batches";
}

async function writeGraphImportArtifacts(reportDir, result) {
  await mkdir(reportDir, { recursive: true });
  await writeJson(path.join(reportDir, "import.json"), result);
  await writeFile(
    path.join(reportDir, "report.md"),
    renderGraphBatchImportMarkdown(result),
    "utf8"
  );
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.tmp`, filePath);
}

function createStore(options) {
  switch (options.storeKind) {
    case "memory":
      return new InMemoryGraphStore();
    case "json":
      return new JsonFileGraphStore({
        filePath: options.jsonPath ?? path.join(options.reportDir, "graph.json"),
        pretty: true
      });
    case "sqlite":
      return new SqliteGraphStore({
        filePath: options.sqlitePath ?? path.join(options.reportDir, "graph.sqlite")
      });
    default:
      throw new Error(`Unsupported graph import store "${options.storeKind}".`);
  }
}

async function* readGraphBatches(filePath) {
  await assertReadable(filePath);
  if (filePath.endsWith(".jsonl")) {
    yield* readJsonlGraphBatches(filePath);
    return;
  }

  const records = parseJsonGraphBatches(await readFile(filePath, "utf8"), filePath);
  for (const [index, record] of records.entries()) {
    yield requiredRecordValue(record, `${filePath}[${index}]`);
  }
}

async function* readJsonlGraphBatches(filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SyntaxError(`${filePath}:${lineNumber} is not valid JSON: ${error.message}`);
      }
      throw error;
    }

    yield requiredRecordValue(parsed, `${filePath}:${lineNumber}`);
  }
}

function parseJsonGraphBatches(body, filePath) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError(`${filePath} is not valid JSON.`);
    }
    throw error;
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed.batches)) {
    return parsed.batches;
  }
  if (isRecord(parsed)) {
    return [parsed];
  }

  throw new Error(`${filePath} must be a graph batch object, an array, or { "batches": [...] }.`);
}

async function assertReadable(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Graph batch input not found at ${filePath}.`);
    }
    throw error;
  }
}

function parseArgs(args) {
  const options = {
    storeKind: "sqlite",
    reportDir: path.join(".rag", "graph-import", "latest"),
    continueOnError: false,
    checkpointEnabled: true,
    thresholds: {}
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--batches":
        options.batchesPath = requiredValue(args, ++index, arg);
        break;
      case "--store":
        options.storeKind = enumValue(requiredValue(args, ++index, arg), arg, [
          "memory",
          "json",
          "sqlite"
        ]);
        break;
      case "--sqlite-path":
        options.sqlitePath = requiredValue(args, ++index, arg);
        break;
      case "--json-path":
        options.jsonPath = requiredValue(args, ++index, arg);
        break;
      case "--checkpoint-path":
        options.checkpointPath = requiredValue(args, ++index, arg);
        break;
      case "--no-checkpoint":
        options.checkpointEnabled = false;
        break;
      case "--report-dir":
        options.reportDir = requiredValue(args, ++index, arg);
        break;
      case "--import-id":
        options.importId = requiredValue(args, ++index, arg);
        break;
      case "--requested-at":
        options.requestedAt = requiredValue(args, ++index, arg);
        break;
      case "--max-attempts":
        options.maxAttempts = positiveInteger(requiredValue(args, ++index, arg), arg);
        break;
      case "--retry-delay-ms":
        options.retryDelayMs = nonNegativeNumber(requiredValue(args, ++index, arg), arg);
        break;
      case "--continue-on-error":
        options.continueOnError = true;
        break;
      case "--max-failed-batches":
        options.thresholds.maxFailedBatches = nonNegativeInteger(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-failure-ratio":
        options.thresholds.maxFailureRatio = ratioValue(requiredValue(args, ++index, arg), arg);
        break;
      case "--max-batch-write-ms":
        options.thresholds.maxBatchWriteMs = nonNegativeNumber(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-write-p95-ms":
        options.thresholds.maxWriteP95Ms = nonNegativeNumber(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      case "--max-total-write-ms":
        options.thresholds.maxTotalWriteMs = nonNegativeNumber(
          requiredValue(args, ++index, arg),
          arg
        );
        break;
      default:
        throw new Error(`Unknown graph import argument "${arg}".`);
    }
  }

  return options;
}

function requiredRecordValue(value, label) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be a graph batch object.`);
  }
  return value;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1.`);
  }
  return parsed;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function nonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative finite number.`);
  }
  return parsed;
}

function ratioValue(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a finite number between 0 and 1.`);
  }
  return parsed;
}

function enumValue(value, flag, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
